import type { AutoFoldConfig } from "../config"
import type { PreparedAutoFold, PreparedAutoFoldRange, SessionState, WithParts } from "../state"
import { countAllMessageTokens } from "../token-utils"
import { isIgnoredUserMessage } from "../messages/query"
import { analyzeContextTokens } from "../commands/context"
import { markNoteInjection } from "../notes"
import { saveSessionState } from "../state/persistence"
import { prepareSession } from "./pipeline"
import { resolveRanges } from "./range-utils"
import { compressResolvedRanges } from "./apply-range"
import { estimate, generateSummary, selectedSource, summaryBudget } from "./model"
import type { SearchContext, ToolContext } from "./types"

/**
 * Auto-fold is split in two halves so no model call sits on the request path.
 *
 * `prepareAutoFold` runs after a turn ends (session execution terminal event): it
 * picks the safe ranges, has the summarizer author each summary and persists the
 * artifact on the session state. `projectAutoFold` runs inside the V2 context
 * hook and only substitutes a persisted artifact, reusing `compressResolvedRanges`
 * so blocks, protection, state and note injection stay identical to the manual
 * compress path.
 *
 * Safety rules are unchanged: disabled by default, no subagents, no denied/ask
 * permission, no manual mode, only above `targetTokens + minGrowthTokens`, the
 * newest messages and the active turn always retained, ranges never overlap an
 * active block, and both halves fail open on error.
 */

export type AutoFoldSkipReason =
    | "disabled"
    | "invalid-target"
    | "subagent"
    | "permission"
    | "manual"
    | "below-target"
    | "no-safe-range"
    | "already-prepared"
    | "in-flight"
    | "no-artifact"
    | "active-turn"
    | "prepared-stale"

export interface AutoFoldPrepareResult {
    prepared: boolean
    reason?: AutoFoldSkipReason
    /** Actual context tokens measured for the turn that just ended. */
    contextTokens: number
    /** Approximate tokens the prepared fold would remove. */
    preparedTokens?: number
    error?: string
}

export interface AutoFoldProjectResult {
    folded: boolean
    reason?: AutoFoldSkipReason
    /** Actual context tokens measured for this request. */
    contextTokens: number
    blockIds?: number[]
    /** Approximate tokens removed from the resident context by this pass. */
    compressedTokens?: number
    error?: string
}

export interface AutoFoldInput {
    ctx: ToolContext
    sessionID: string
    /** Messages representing the current context; used for token accounting only. */
    messages: WithParts[]
    /** Renders the user-visible notices through the host message inbox. */
    notify?: AutoFoldNotify
}

/** Both notices are user-visible chat messages, never toasts. */
export const AUTO_FOLD_START_NOTICE = "自动压缩触发"
export const AUTO_FOLD_NOTICE_LABEL = "自动压缩"
export const AUTO_FOLD_NOTICE_PREFIX = `${AUTO_FOLD_NOTICE_LABEL}: `
const AUTO_FOLD_NOTICE_SOURCE = "dcp.autofold"
// A prepared fold is only useful for the request that follows its turn. Anything
// older is abandoned instead of resurrecting an unrelated summary after a restart.
const PREPARED_FOLD_TTL_MS = 30 * 60_000

export interface AutoFoldNotice {
    sessionID: string
    text: string
    description: string
    metadata: Record<string, string>
}

export type AutoFoldNotify = (notice: AutoFoldNotice) => Promise<unknown>

// Overlapping ticks for one session must not fold twice: a prepare is guarded by
// its own in-flight set and a projection by its own, so an in-flight summarizer
// request never blocks a projection of the artifact prepared earlier.
const preparingSessions = new Set<string>()
const projectingSessions = new Set<string>()

function errorMessage(error: unknown): string {
    return (error as Error)?.message ?? String(error)
}

async function notify(
    ctx: ToolContext,
    send: AutoFoldNotify | undefined,
    notice: AutoFoldNotice,
): Promise<void> {
    if (!send) return
    try {
        await send(notice)
    } catch (error) {
        // A missed notice must never abort or fake a fold.
        ctx.logger.warn("DCP auto-fold notice failed", {
            text: notice.text,
            error: errorMessage(error),
        })
    }
}

function formatTokens(tokens: number): string {
    if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
    if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`
    return `${tokens}`
}

function hasOpenToolCall(message: WithParts): boolean {
    return message.parts.some(
        (part) =>
            part.type === "tool" &&
            part.state?.status !== "completed" &&
            part.state?.status !== "error",
    )
}

export interface AutoFoldRun {
    startId: string
    endId: string
    tokens: number
}

interface FoldUnit {
    messageId: string
    rawIndex: number
    tokens: number
    foldable: boolean
}

function buildFoldUnits(
    rawMessages: WithParts[],
    searchContext: SearchContext,
    keepRecentMessages: number,
): FoldUnit[] {
    const units: FoldUnit[] = []
    let lastUserRawIndex = -1

    for (let index = 0; index < rawMessages.length; index++) {
        const message = rawMessages[index]!
        if (isIgnoredUserMessage(message)) continue
        if (message.info.role === "user") lastUserRawIndex = index
        const messageId = message.info.id
        units.push({
            messageId,
            rawIndex: index,
            tokens: countAllMessageTokens(message),
            // An active block owns its sources: folding them again would overlap it.
            foldable:
                searchContext.blockedMessageIdToBlockId?.has(messageId) !== true &&
                !hasOpenToolCall(message),
        })
    }

    const protectedIds = new Set<string>()
    for (const unit of units.slice(Math.max(0, units.length - keepRecentMessages))) {
        protectedIds.add(unit.messageId)
    }
    // The active turn (last real user message and everything after it) is in flight.
    if (lastUserRawIndex >= 0) {
        for (const unit of units) {
            if (unit.rawIndex >= lastUserRawIndex) protectedIds.add(unit.messageId)
        }
    }

    for (const unit of units) {
        if (protectedIds.has(unit.messageId)) unit.foldable = false
    }

    return units
}

/** Messages a fold may still touch right now, under the current protection rules. */
export function foldableMessageIds(
    rawMessages: WithParts[],
    searchContext: SearchContext,
    keepRecentMessages: number,
): Set<string> {
    const foldable = new Set<string>()
    for (const unit of buildFoldUnits(rawMessages, searchContext, keepRecentMessages)) {
        if (unit.foldable) foldable.add(unit.messageId)
    }
    return foldable
}

/**
 * Pick the oldest, largest safe contiguous ranges. A range never spans a
 * protected message, an active block, or pending work: those break the run.
 */
export function selectAutoFoldRuns(input: {
    rawMessages: WithParts[]
    searchContext: SearchContext
    state: SessionState
    keepRecentMessages: number
    neededTokens: number
    maxRanges?: number
}): AutoFoldRun[] {
    const { rawMessages, searchContext, state, neededTokens } = input
    const maxRanges = input.maxRanges ?? 4
    const units = buildFoldUnits(rawMessages, searchContext, input.keepRecentMessages)

    const runs: AutoFoldRun[] = []
    let current: FoldUnit[] = []

    const closeRun = () => {
        if (current.length === 0) return
        const first = current[0]!
        const last = current[current.length - 1]!
        const startId = state.messageIds.byRawId.get(first.messageId)
        const endId = state.messageIds.byRawId.get(last.messageId)
        if (startId !== undefined && endId !== undefined) {
            runs.push({
                startId,
                endId,
                tokens: current.reduce((total, unit) => total + unit.tokens, 0),
            })
        }
        current = []
    }

    for (const unit of units) {
        if (!unit.foldable) {
            closeRun()
            continue
        }
        current.push(unit)
    }
    closeRun()

    const selected: AutoFoldRun[] = []
    let accumulated = 0
    for (const run of runs) {
        if (selected.length >= maxRanges) break
        selected.push(run)
        accumulated += run.tokens
        if (accumulated >= neededTokens) break
    }

    // Do not fold a range that cannot measurably reduce the context: an
    // unneeded fold costs a summary and a new block for no gain.
    while (selected.length > 0) {
        const run = selected[selected.length - 1]!
        if (accumulated - run.tokens >= neededTokens) {
            selected.pop()
            accumulated -= run.tokens
            continue
        }
        break
    }

    return selected
}

// Without a configured summarizer model there is no model-authored summary.
// Keep an honest mechanical digest of the folded range instead of pretending a
// summary was written: excerpts plus the block refs for exact readback.
function mechanicalDigest(planSummaryBudget: number, source: string): string {
    const budget = Math.max(120, planSummaryBudget)
    const maxChars = budget * 3
    const trimmed = source.replace(/\s+/g, " ").trim()
    const excerpt =
        trimmed.length > maxChars ? `${trimmed.slice(0, maxChars).trimEnd()} …` : trimmed
    return `Mechanical digest (no summarizer model configured; excerpts of the folded range, not a model-authored summary):\n${excerpt}`
}

function resolveConfig(config: ToolContext["config"]): AutoFoldConfig | undefined {
    const autoFold = config.compress.autoFold
    if (!autoFold || autoFold.enabled !== true) return undefined
    if (!Number.isSafeInteger(autoFold.targetTokens) || autoFold.targetTokens <= 0) return undefined
    return autoFold
}

/** Reasons a fold must not run at all in this session, independent of size. */
export function autoFoldBlocker(
    state: SessionState,
    config: ToolContext["config"],
): AutoFoldSkipReason | undefined {
    if (!resolveConfig(config)) {
        return config.compress.autoFold?.enabled === true ? "invalid-target" : "disabled"
    }
    if (state.isSubAgent) return "subagent"
    if (state.compressPermission === "deny" || state.compressPermission === "ask")
        return "permission"
    if (state.manualMode) return "manual"
    return undefined
}

function lastRealUserMessage(rawMessages: WithParts[]): WithParts | undefined {
    return [...rawMessages]
        .reverse()
        .find((message) => message.info.role === "user" && !isIgnoredUserMessage(message))
}

/**
 * End-of-turn prepare: measure, select the safe ranges and author every summary.
 * It never creates a block and never touches the request being forwarded.
 */
export async function prepareAutoFold(input: AutoFoldInput): Promise<AutoFoldPrepareResult> {
    const { ctx, sessionID, messages, notify: send } = input
    const autoFold = resolveConfig(ctx.config)
    const blocker = autoFoldBlocker(ctx.state, ctx.config)
    const contextTokens = analyzeContextTokens(ctx.state, messages).total

    if (!autoFold || blocker) {
        return { prepared: false, reason: blocker ?? "disabled", contextTokens }
    }

    const trigger = autoFold.targetTokens + Math.max(0, autoFold.minGrowthTokens)
    if (contextTokens <= trigger) {
        return { prepared: false, reason: "below-target", contextTokens }
    }

    const neededTokens = contextTokens - autoFold.targetTokens

    if (preparingSessions.has(sessionID)) {
        return { prepared: false, reason: "in-flight", contextTokens }
    }
    preparingSessions.add(sessionID)

    try {
        const toolCtx = {
            sessionID,
            ask: async () => {},
            metadata: () => {},
        }
        const { rawMessages, searchContext } = await prepareSession(ctx, toolCtx, "Auto-fold", {
            skipPermission: true,
            skipStrategies: true,
        })

        const owner = lastRealUserMessage(rawMessages)
        if (!owner) {
            return { prepared: false, reason: "no-safe-range", contextTokens }
        }
        // Repeated terminal events for the same turn must not summarize twice.
        const existing = ctx.state.preparedAutoFold
        if (
            existing?.sessionID === sessionID &&
            existing.anchorUserId === owner.info.id &&
            Date.now() - existing.createdAt < PREPARED_FOLD_TTL_MS
        ) {
            return { prepared: false, reason: "already-prepared", contextTokens }
        }

        const runs = selectAutoFoldRuns({
            rawMessages,
            searchContext,
            state: ctx.state,
            keepRecentMessages: autoFold.keepRecentMessages,
            neededTokens,
        })
        const selectedTokens = runs.reduce((total, run) => total + run.tokens, 0)
        // A fold that cannot outweigh the smallest possible summary would grow the
        // context instead of shrinking it, so leave the original context alone.
        if (runs.length === 0 || selectedTokens <= summaryBudget(0)) {
            return { prepared: false, reason: "no-safe-range", contextTokens }
        }

        const topic = `Auto-fold: ${formatTokens(contextTokens)} -> ${formatTokens(autoFold.targetTokens)}`
        const plans = resolveRanges(
            {
                topic,
                content: runs.map((run) => ({ startId: run.startId, endId: run.endId })),
            },
            searchContext,
            ctx.state,
        )
        if (plans.length === 0) {
            return { prepared: false, reason: "no-safe-range", contextTokens }
        }

        // Everything below spends a model call, so the fold genuinely starts here.
        await notify(ctx, send, {
            sessionID,
            text: AUTO_FOLD_START_NOTICE,
            description: AUTO_FOLD_NOTICE_LABEL,
            metadata: { source: AUTO_FOLD_NOTICE_SOURCE, event: "start" },
        })

        const signal = new AbortController().signal
        const ranges: PreparedAutoFoldRange[] = []
        let compressedTokens = 0
        for (const plan of plans) {
            const source = selectedSource(plan.selection, searchContext, ctx.state.idFormat)
            const sourceTokens = estimate(source.text)
            let body: string
            if (ctx.config.compress.model !== undefined && ctx.summarizer) {
                body = await generateSummary(ctx, topic, source, signal)
            } else {
                ctx.logger.warn(
                    "DCP auto-fold has no appendable summarizer model; writing a mechanical digest",
                    { topic },
                )
                body = mechanicalDigest(summaryBudget(sourceTokens), source.text)
            }
            ranges.push({
                startId: plan.entry.startId,
                endId: plan.entry.endId,
                body,
                messageIds: [...plan.selection.messageIds],
                requiredBlockIds: [...plan.selection.requiredBlockIds],
                sourceTokens,
            })
            compressedTokens += plan.selection.messageIds.reduce(
                (total, messageId) => total + (plan.selection.messageTokenById.get(messageId) ?? 0),
                0,
            )
        }

        const prepared: PreparedAutoFold = {
            version: 1,
            sessionID,
            topic,
            anchorUserId: owner.info.id,
            contextTokens,
            targetTokens: autoFold.targetTokens,
            createdAt: Date.now(),
            ranges,
        }
        ctx.state.preparedAutoFold = prepared
        await saveSessionState(ctx.state, ctx.logger)

        ctx.logger.info("DCP auto-fold prepared", {
            contextTokens,
            targetTokens: autoFold.targetTokens,
            ranges: ranges.length,
        })

        return { prepared: true, contextTokens, preparedTokens: compressedTokens }
    } catch (error) {
        // Fail open: nothing is claimed and the original context stays untouched.
        ctx.logger.warn("DCP auto-fold prepare failed; original context retained", {
            error: errorMessage(error),
        })
        return { prepared: false, contextTokens, error: errorMessage(error) }
    } finally {
        preparingSessions.delete(sessionID)
    }
}

/**
 * Request-path projection: substitute the prepared artifact locally. No model
 * call, no fabricated summary. Anything that no longer matches the current
 * history is dropped with a logged reason instead of blocking the request.
 */
export async function projectAutoFold(input: AutoFoldInput): Promise<AutoFoldProjectResult> {
    const { ctx, sessionID, messages, notify: send } = input
    const autoFold = resolveConfig(ctx.config)
    const blocker = autoFoldBlocker(ctx.state, ctx.config)
    const contextTokens = analyzeContextTokens(ctx.state, messages).total

    if (!autoFold || blocker) {
        return { folded: false, reason: blocker ?? "disabled", contextTokens }
    }

    const trigger = autoFold.targetTokens + Math.max(0, autoFold.minGrowthTokens)
    if (contextTokens <= trigger) {
        return { folded: false, reason: "below-target", contextTokens }
    }

    const prepared = ctx.state.preparedAutoFold
    if (!prepared || prepared.sessionID !== sessionID) {
        ctx.logger.debug("DCP auto-fold found no prepared fold for this request", {
            sessionID,
            contextTokens,
        })
        return { folded: false, reason: "no-artifact", contextTokens }
    }

    if (projectingSessions.has(sessionID)) {
        return { folded: false, reason: "in-flight", contextTokens }
    }
    projectingSessions.add(sessionID)

    // An unusable artifact can never become usable again: drop it and say why.
    const drop = async (
        reason: "active-turn" | "prepared-stale",
        detail: string,
    ): Promise<AutoFoldProjectResult> => {
        ctx.state.preparedAutoFold = null
        ctx.logger.warn("DCP auto-fold skipped the prepared fold", {
            sessionID,
            reason,
            detail,
            contextTokens,
        })
        await saveSessionState(ctx.state, ctx.logger)
        return { folded: false, reason, contextTokens }
    }

    try {
        if (Date.now() - prepared.createdAt > PREPARED_FOLD_TTL_MS) {
            return await drop("prepared-stale", "the prepared fold expired before the next request")
        }
        const toolCtx = {
            sessionID,
            ask: async () => {},
            metadata: () => {},
        }
        const { rawMessages, searchContext } = await prepareSession(ctx, toolCtx, "Auto-fold", {
            skipPermission: true,
            skipStrategies: true,
        })

        const owner = lastRealUserMessage(rawMessages)
        if (!owner) return await drop("active-turn", "no active turn to own the folded blocks")

        const foldable = foldableMessageIds(rawMessages, searchContext, autoFold.keepRecentMessages)
        const claimed = prepared.ranges
            .flatMap((range) => range.messageIds)
            .find((messageId) => !foldable.has(messageId))
        if (claimed !== undefined) {
            return await drop("active-turn", `message ${claimed} is no longer a foldable unit`)
        }

        let plans
        try {
            plans = resolveRanges(
                {
                    topic: prepared.topic,
                    content: prepared.ranges.map((range) => ({
                        startId: range.startId,
                        endId: range.endId,
                    })),
                },
                searchContext,
                ctx.state,
            )
        } catch (error) {
            return await drop("prepared-stale", errorMessage(error))
        }
        if (plans.length !== prepared.ranges.length) {
            return await drop("prepared-stale", "prepared ranges no longer resolve")
        }
        for (const plan of plans) {
            const stored = prepared.ranges[plan.index]!
            const unchanged =
                plan.selection.messageIds.length === stored.messageIds.length &&
                plan.selection.messageIds.every(
                    (messageId, index) => messageId === stored.messageIds[index],
                ) &&
                plan.selection.requiredBlockIds.length === stored.requiredBlockIds.length &&
                plan.selection.requiredBlockIds.every(
                    (blockId, index) => blockId === stored.requiredBlockIds[index],
                )
            if (!unchanged) {
                return await drop(
                    "prepared-stale",
                    `range ${stored.startId}..${stored.endId} changed after preparation`,
                )
            }
        }

        // Claim before committing so a repeated hook event cannot fold twice.
        ctx.state.preparedAutoFold = null

        const result = await compressResolvedRanges({
            ctx,
            rawMessages,
            searchContext,
            plans,
            topic: prepared.topic,
            compressMessageId: owner.info.id,
            summaryFor: async (plan) => {
                const stored = prepared.ranges[plan.index]!
                return {
                    body: stored.body,
                    source: selectedSource(plan.selection, searchContext, ctx.state.idFormat),
                    // No summarizer runs in this request, so nothing is reserved for one.
                    replyTokens: 0,
                }
            },
        })

        markNoteInjection(ctx.state.sessionId)

        const compressedTokens = result.blockIds.reduce(
            (total, blockId) =>
                total + (ctx.state.prune.messages.blocksById.get(blockId)?.compressedTokens ?? 0),
            0,
        )

        // The fold is committed; the notice must never hold the request that is
        // being assembled, so it is dispatched without awaiting the host inbox.
        const restoredTokens = prepared.ranges.reduce((total, range) => total + estimate(range.body), 0)
        const afterTokens = Math.max(0, contextTokens - compressedTokens + restoredTokens)
        void notify(ctx, send, {
            sessionID,
            text: `${AUTO_FOLD_NOTICE_PREFIX}${formatTokens(contextTokens)} → ${formatTokens(afterTokens)}，折叠 ${result.totalCompressedMessages} 条消息（${result.blockIds.length} 段）`,
            description: AUTO_FOLD_NOTICE_LABEL,
            metadata: { source: AUTO_FOLD_NOTICE_SOURCE, event: "end" },
        })

        ctx.logger.info("DCP auto-fold applied", {
            contextTokens,
            targetTokens: autoFold.targetTokens,
            blockIds: result.blockIds,
            compressedMessages: result.totalCompressedMessages,
        })

        return { folded: true, contextTokens, blockIds: result.blockIds, compressedTokens }
    } catch (error) {
        // Fail open: the original context stays untouched and nothing is claimed.
        ctx.state.preparedAutoFold = null
        ctx.logger.warn("DCP auto-fold failed; original context retained", {
            error: errorMessage(error),
        })
        return { folded: false, contextTokens, error: errorMessage(error) }
    } finally {
        projectingSessions.delete(sessionID)
    }
}
