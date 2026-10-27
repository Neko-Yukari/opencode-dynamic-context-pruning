import { tool } from "@opencode-ai/plugin"
import type { ToolContext } from "./types"
import { countTokens } from "../token-utils"
import { rangeFormat } from "../prompts/extensions/tool"
import { formatMessageRef, formatBlockRef, type IdFormat } from "../message-ids"
import { finalizeSession, prepareSession, type NotificationEntry } from "./pipeline"
import {
    appendProtectedPromptInfo,
    appendProtectedTools,
    appendProtectedUserMessages,
} from "./protected-content"
import {
    parseBlockPlaceholders,
    resolveRanges,
    stripBlockPlaceholders,
    validateArgs,
    validateNonOverlapping,
    validateSelectionArgs,
} from "./range-utils"
import {
    COMPRESSED_BLOCK_HEADER,
    allocateBlockId,
    allocateRunId,
    applyCompressionState,
    wrapCompressedSummary,
} from "./state"
import type { CompressRangeArgsInput, CompressRangeToolArgs } from "./types"
import {
    estimate,
    generateSummary,
    selectedSource,
    redact,
    MODEL_SELECTION_INSTRUCTIONS,
    summaryBudget,
} from "./model"
import type { SessionState } from "../state"
import { saveSessionState } from "../state/persistence"
import { assertCompressedContextFits } from "./capacity"
import { markNoteInjection } from "../notes"

function buildSchema(format: IdFormat, configured: boolean) {
    return {
        topic: tool.schema
            .string()
            .describe("Short label (3-5 words) for display - e.g., 'Auth System Exploration'"),
        content: tool.schema
            .array(
                tool.schema.object({
                    startId: tool.schema
                        .string()
                        .describe(
                            `Message or block ID marking the beginning of range (e.g. ${formatMessageRef(1, format)}, ${formatBlockRef(2, format)})`,
                        ),
                    endId: tool.schema
                        .string()
                        .describe(
                            `Message or block ID marking the end of range (e.g. ${formatMessageRef(12, format)}, ${formatBlockRef(5, format)})`,
                        ),
                    ...(!configured
                        ? {
                              summary: tool.schema
                                  .string()
                                  .describe(
                                      "Complete technical summary replacing all content in range",
                                  ),
                          }
                        : {}),
                }),
            )
            .describe(
                configured
                    ? "Closed ranges with start/end boundaries; the configured model authors their summaries"
                    : "One or more ranges to compress, each with start/end boundaries and a summary",
            ),
    }
}

export function createCompressRangeTool(ctx: ToolContext): ReturnType<typeof tool> {
    ctx.prompts.reload()
    const runtimePrompts = ctx.prompts.getRuntimePrompts()
    const configured = ctx.config.compress.model !== undefined

    return tool({
        description: configured
            ? MODEL_SELECTION_INSTRUCTIONS
            : runtimePrompts.compressRange + rangeFormat(ctx.state.idFormat),
        args: buildSchema(ctx.state.idFormat, configured),
        async execute(args, toolCtx) {
            if (configured && ctx.config.compress.mode !== "range")
                throw new Error(
                    "DCP compress.model currently requires compress.mode='range'; original context retained",
                )
            // Configured mode takes boundaries only: the configured model authors
            // every summary, so demanding or inventing one here would be wrong.
            if (configured) validateSelectionArgs(args)
            else validateArgs(args as CompressRangeToolArgs)
            const input = args as CompressRangeArgsInput
            if (configured) toolCtx.abort.throwIfAborted()
            const callId =
                typeof (toolCtx as unknown as { callID?: unknown }).callID === "string"
                    ? (toolCtx as unknown as { callID: string }).callID
                    : undefined

            const { rawMessages, searchContext } = await prepareSession(
                ctx,
                toolCtx,
                `Compress Range: ${input.topic}`,
            )
            const resolvedPlans = resolveRanges(input, searchContext, ctx.state)
            validateNonOverlapping(resolvedPlans)
            if (
                configured &&
                resolvedPlans.some(
                    (plan) =>
                        plan.selection.messageIds.includes(toolCtx.messageID) ||
                        (callId !== undefined && plan.selection.toolIds.includes(callId)),
                )
            )
                throw new Error("DCP model compression cannot include its active compression call")

            const notifications: NotificationEntry[] = []
            const preparedPlans: Array<{
                entry: (typeof resolvedPlans)[number]["entry"]
                selection: (typeof resolvedPlans)[number]["selection"]
                anchorMessageId: string
                finalSummary: string
                consumedBlockIds: number[]
            }> = []
            let totalCompressedMessages = 0
            let summaryReplyTokens = 0

            for (const plan of resolvedPlans) {
                const source = configured
                    ? selectedSource(plan.selection, searchContext, ctx.state.idFormat)
                    : undefined
                if (configured) {
                    plan.entry.summary = await generateSummary(
                        ctx,
                        input.topic,
                        source!,
                        toolCtx.abort,
                    )
                }
                if (source) {
                    summaryReplyTokens += 5 * summaryBudget(estimate(source.text))
                }
                const rewritten = stripBlockPlaceholders(
                    plan.entry.summary,
                    parseBlockPlaceholders(plan.entry.summary, ctx.state.idFormat),
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

                preparedPlans.push({
                    entry: plan.entry,
                    selection: plan.selection,
                    anchorMessageId: plan.anchorMessageId,
                    finalSummary,
                    consumedBlockIds: [...plan.selection.requiredBlockIds],
                })
            }

            if (configured) toolCtx.abort.throwIfAborted()
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

            for (const preparedPlan of preparedPlans) {
                const blockId = allocateBlockId(staged)
                const storedSummary = wrapCompressedSummary(
                    blockId,
                    preparedPlan.finalSummary,
                    staged.idFormat,
                )
                const summaryTokens = countTokens(storedSummary)

                const applied = applyCompressionState(
                    staged,
                    {
                        topic: input.topic,
                        batchTopic: input.topic,
                        startId: preparedPlan.entry.startId,
                        endId: preparedPlan.entry.endId,
                        mode: "range",
                        runId,
                        compressMessageId: toolCtx.messageID,
                        compressCallId: callId,
                        summaryTokens,
                    },
                    preparedPlan.selection,
                    preparedPlan.anchorMessageId,
                    blockId,
                    storedSummary,
                    preparedPlan.consumedBlockIds,
                )

                totalCompressedMessages += applied.messageIds.length

                notifications.push({
                    blockId,
                    runId,
                    summary: preparedPlan.finalSummary,
                    summaryTokens,
                })
            }

            assertCompressedContextFits(
                ctx,
                staged,
                rawMessages,
                configured ? summaryReplyTokens : undefined,
            )
            await saveSessionState(staged, ctx.logger)
            ctx.state.prune = staged.prune
            ctx.state.stats = staged.stats
            markNoteInjection(ctx.state.sessionId)

            // State is already persisted: a notification failure must not be
            // reported as "original context retained".
            try {
                await finalizeSession(ctx, toolCtx, rawMessages, notifications, input.topic)
            } catch (error) {
                ctx.logger.error("DCP compression persisted but its notification failed", {
                    error: (error as Error)?.message,
                })
            }

            return `Compressed ${totalCompressedMessages} messages into ${COMPRESSED_BLOCK_HEADER}.`
        },
    })
}
