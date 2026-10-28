import { tool } from "@opencode-ai/plugin"
import type { ToolContext } from "./types"
import { rangeFormat } from "../prompts/extensions/tool"
import { formatMessageRef, formatBlockRef, type IdFormat } from "../message-ids"
import { finalizeSession, prepareSession } from "./pipeline"
import {
    resolveRanges,
    validateArgs,
    validateNonOverlapping,
    validateSelectionArgs,
} from "./range-utils"
import { COMPRESSED_BLOCK_HEADER } from "./state"
import { compressResolvedRanges } from "./apply-range"
import type { CompressRangeArgsInput, CompressRangeToolArgs } from "./types"
import { estimate, generateSummary, selectedSource, MODEL_SELECTION_INSTRUCTIONS, summaryBudget } from "./model"
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

            const { notifications, totalCompressedMessages } = await compressResolvedRanges({
                ctx,
                rawMessages,
                searchContext,
                plans: resolvedPlans,
                topic: input.topic,
                compressMessageId: toolCtx.messageID,
                compressCallId: callId,
                summaryFor: async (plan) => {
                    if (configured) toolCtx.abort.throwIfAborted()
                    const source = configured
                        ? selectedSource(plan.selection, searchContext, ctx.state.idFormat)
                        : undefined
                    const body = configured
                        ? await generateSummary(ctx, input.topic, source!, toolCtx.abort)
                        : plan.entry.summary
                    return {
                        body,
                        source,
                        replyTokens: source ? 5 * summaryBudget(estimate(source.text)) : 0,
                    }
                },
            })
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
