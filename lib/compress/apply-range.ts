import type { SessionState, WithParts } from "../state"
import { countTokens } from "../token-utils"
import { saveSessionState } from "../state/persistence"
import type { NotificationEntry } from "./pipeline"
import {
    allocateBlockId,
    allocateRunId,
    applyCompressionState,
    wrapCompressedSummary,
} from "./state"
import {
    appendProtectedPromptInfo,
    appendProtectedTools,
    appendProtectedUserMessages,
} from "./protected-content"
import { parseBlockPlaceholders, stripBlockPlaceholders } from "./range-utils"
import { redact, selectedSource } from "./model"
import { assertCompressedContextFits } from "./capacity"
import type { ResolvedRangeCompression, SearchContext, ToolContext } from "./types"

export interface RangeSummaryInput {
    /** Summary body for this range, without the application-owned wrapper. */
    body: string
    /** Selected observable source, when a summarizer received and rewrote it. */
    source?: ReturnType<typeof selectedSource>
    /** Reply tokens reserved for the summarizer that authored this body. */
    replyTokens?: number
}

export interface CompressResolvedRangesInput {
    ctx: ToolContext
    rawMessages: WithParts[]
    searchContext: SearchContext
    plans: ResolvedRangeCompression[]
    /** Batch topic; also the visible title rendered into every block summary. */
    topic: string
    /** Message that owns the created blocks; must exist in the session history. */
    compressMessageId: string
    compressCallId?: string
    summaryFor: (plan: ResolvedRangeCompression) => Promise<RangeSummaryInput>
}

export interface CompressResolvedRangesResult {
    blockIds: number[]
    totalCompressedMessages: number
    notifications: NotificationEntry[]
}

/**
 * Shared range-compression executor for every internal or tool-driven caller.
 * It owns the whole persistence contract: protection appends, staged state,
 * ordinary CompressionBlock records via applyCompressionState, capacity check,
 * strict save and live-state publication. Notifications and note injection stay
 * with the caller so each entry point keeps its own semantics.
 */
export async function compressResolvedRanges(
    input: CompressResolvedRangesInput,
): Promise<CompressResolvedRangesResult> {
    const { ctx, rawMessages, searchContext, plans, topic } = input

    const preparedPlans: Array<{
        plan: ResolvedRangeCompression
        finalSummary: string
        replyTokens: number
    }> = []
    let summaryReplyTokens = 0

    for (const plan of plans) {
        const { body, source, replyTokens } = await input.summaryFor(plan)
        summaryReplyTokens += replyTokens ?? 0
        const rewritten = stripBlockPlaceholders(
            body,
            parseBlockPlaceholders(body, ctx.state.idFormat),
        )
        const summaryWithUsers = appendProtectedUserMessages(
            rewritten,
            plan.selection,
            searchContext,
            ctx.state,
            ctx.config.compress.protectUserMessages,
        )
        const summaryWithPromptInfo = appendProtectedPromptInfo(
            summaryWithUsers,
            plan.selection,
            searchContext,
            ctx.state,
            ctx.config.compress.protectTags,
        )
        const summaryWithTools = await appendProtectedTools(
            ctx.client,
            ctx.state,
            ctx.config.experimental.allowSubAgents,
            summaryWithPromptInfo,
            plan.selection,
            searchContext,
            ctx.config.compress.protectedTools,
            ctx.config.protectedFilePatterns,
        )
        // Selected blocks are rewritten, so no old block body is appended.
        const finalSummary = source
            ? (redact(source.media.transform(summaryWithTools)) as string)
            : summaryWithTools
        await source?.media.save()
        preparedPlans.push({ plan, finalSummary, replyTokens: replyTokens ?? 0 })
    }

    // Stage the whole batch, persist it strictly, then publish. A failed write
    // must not leave a half-applied live state or report success.
    const staged: SessionState = {
        ...ctx.state,
        prune: {
            ...ctx.state.prune,
            messages: structuredClone(ctx.state.prune.messages),
        },
        stats: { ...ctx.state.stats },
    }
    const runId = allocateRunId(staged)
    const notifications: NotificationEntry[] = []
    const blockIds: number[] = []
    let totalCompressedMessages = 0

    for (const prepared of preparedPlans) {
        const blockId = allocateBlockId(staged)
        const storedSummary = wrapCompressedSummary(
            blockId,
            prepared.finalSummary,
            staged.idFormat,
            topic,
        )
        const summaryTokens = countTokens(storedSummary)
        const applied = applyCompressionState(
            staged,
            {
                topic,
                batchTopic: topic,
                startId: prepared.plan.entry.startId,
                endId: prepared.plan.entry.endId,
                mode: "range",
                runId,
                compressMessageId: input.compressMessageId,
                compressCallId: input.compressCallId,
                summaryTokens,
            },
            prepared.plan.selection,
            prepared.plan.anchorMessageId,
            blockId,
            storedSummary,
            [...prepared.plan.selection.requiredBlockIds],
        )

        totalCompressedMessages += applied.messageIds.length
        blockIds.push(blockId)
        notifications.push({
            blockId,
            runId,
            summary: prepared.finalSummary,
            summaryTokens,
        })
    }

    assertCompressedContextFits(
        ctx,
        staged,
        rawMessages,
        summaryReplyTokens > 0 ? summaryReplyTokens : undefined,
    )
    await saveSessionState(staged, ctx.logger)
    ctx.state.prune = staged.prune
    ctx.state.stats = staged.stats

    return { blockIds, totalCompressedMessages, notifications }
}
