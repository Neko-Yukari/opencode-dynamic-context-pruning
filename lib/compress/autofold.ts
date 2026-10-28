import type { AutoFoldConfig } from "../config"
import type { SessionState, WithParts } from "../state"
import { countAllMessageTokens } from "../token-utils"
import { isIgnoredUserMessage } from "../messages/query"
import { analyzeContextTokens } from "../commands/context"
import { markNoteInjection } from "../notes"
import { prepareSession } from "./pipeline"
import { resolveRanges } from "./range-utils"
import { compressResolvedRanges } from "./apply-range"
import { estimate, generateSummary, selectedSource, summaryBudget } from "./model"
import type { SearchContext, ToolContext } from "./types"

/**
 * Pre-request auto-fold: a billion-context-like reduction that happens inside the
 * V2 context hook, before the request is forwarded. It never shells out and never
 * calls the model-visible compress tool: it reuses the same internal range path
 * the tool uses, so every invariant of `CompressionBlock` (active flags, consumed
 * and included ids, anchor, effective ids, summary tokens, stats) still holds.
 *
 * Safety rules: one pass per request, disabled by default, no subagents, no
 * denied/ask permission, no manual mode, only above `targetTokens + minGrowthTokens`,
 * newest messages and the active turn always retained, and fail open on error.
 */

export type AutoFoldSkipReason =
    | "disabled"
    | "invalid-target"
    | "subagent"
    | "permission"
    | "manual"
    | "below-target"
    | "no-safe-range"
    | "already-folded"
    | "in-flight"

export interface AutoFoldResult {
    folded: boolean
    reason?: AutoFoldSkipReason
    /** Actual context tokens measured for this request. */
    contextTokens: number
    blockIds?: number[]
    /** Approximate tokens removed from the resident context by this pass. */
    compressedTokens?: number
    error?: string
}

export interface AutoFoldRequest {
    ctx: ToolContext
    sessionID: string
    /** Messages representing the request context; used for token accounting only. */
    messages: WithParts[]
    /** Abort signal of the in-flight request, when available. */
    signal?: AbortSignal
}

// One fold pass per request: the same session cannot fold twice for the same
// request anchor. A new user message or a longer history is a new request.
const foldedRequests = new Map<string, string>()
// A fold issues its own summarizer request. If the host fires the context hook
// for that internal call, re-entering the fold would recurse; every nested
// invocation for the same session is skipped instead ("internal agent calls").
const foldingSessions = new Set<string>()

function foldSignature(rawMessages: WithParts[]): string {
    const last = rawMessages[rawMessages.length - 1]
    return `${rawMessages.length}:${last?.info.id ?? ""}`
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
    if (state.compressPermission === "deny" || state.compressPermission === "ask") return "permission"
    if (state.manualMode) return "manual"
    return undefined
}

export async function runAutoFold(request: AutoFoldRequest): Promise<AutoFoldResult> {
    const { ctx, sessionID, messages } = request
    const autoFold = resolveConfig(ctx.config)
    const blocker = autoFoldBlocker(ctx.state, ctx.config)

    if (!autoFold || blocker) {
        return {
            folded: false,
            reason: blocker ?? "disabled",
            contextTokens: analyzeContextTokens(ctx.state, messages).total,
        }
    }

    const contextTokens = analyzeContextTokens(ctx.state, messages).total
    const trigger = autoFold.targetTokens + Math.max(0, autoFold.minGrowthTokens)
    if (contextTokens <= trigger) {
        return { folded: false, reason: "below-target", contextTokens }
    }

    const neededTokens = contextTokens - autoFold.targetTokens

    if (foldingSessions.has(sessionID)) {
        return { folded: false, reason: "in-flight", contextTokens }
    }
    foldingSessions.add(sessionID)

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

        const signature = `${sessionID}:${foldSignature(rawMessages)}`
        if (foldedRequests.get(sessionID) === signature) {
            return { folded: false, reason: "already-folded", contextTokens }
        }

        const owner = [...rawMessages].reverse().find(
            (message) => message.info.role === "user" && !isIgnoredUserMessage(message),
        )
        if (!owner) {
            return { folded: false, reason: "no-safe-range", contextTokens }
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
            return { folded: false, reason: "no-safe-range", contextTokens }
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
            return { folded: false, reason: "no-safe-range", contextTokens }
        }

        request.signal?.throwIfAborted()

        const result = await compressResolvedRanges({
            ctx,
            rawMessages,
            searchContext,
            plans,
            topic,
            compressMessageId: owner.info.id,
            summaryFor: async (plan) => {
                request.signal?.throwIfAborted()
                const source = selectedSource(plan.selection, searchContext, ctx.state.idFormat)
                if (ctx.config.compress.model !== undefined && ctx.summarizer) {
                    const body = await generateSummary(ctx, topic, source, signalOf(request))
                    return {
                        body,
                        source,
                        replyTokens: 5 * summaryBudget(estimate(source.text)),
                    }
                }
                ctx.logger.warn(
                    "DCP auto-fold has no appendable summarizer model; writing a mechanical digest",
                    { topic },
                )
                return {
                    body: mechanicalDigest(summaryBudget(estimate(source.text)), source.text),
                    source,
                }
            },
        })

        foldedRequests.set(sessionID, signature)
        markNoteInjection(ctx.state.sessionId)

        ctx.logger.info("DCP auto-fold applied", {
            contextTokens,
            targetTokens: autoFold.targetTokens,
            blockIds: result.blockIds,
            compressedMessages: result.totalCompressedMessages,
        })

        return {
            folded: true,
            contextTokens,
            blockIds: result.blockIds,
            compressedTokens: selectedTokens,
        }
    } catch (error) {
        // Fail open: the original context stays untouched and nothing is claimed.
        ctx.logger.warn("DCP auto-fold failed; original context retained", {
            error: (error as Error)?.message ?? String(error),
        })
        return {
            folded: false,
            contextTokens,
            error: (error as Error)?.message ?? String(error),
        }
    } finally {
        foldingSessions.delete(sessionID)
    }
}

function signalOf(request: AutoFoldRequest): AbortSignal {
    return request.signal ?? new AbortController().signal
}
