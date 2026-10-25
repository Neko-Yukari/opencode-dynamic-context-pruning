import { tool } from "@opencode-ai/plugin"
import type { ToolContext, CompressRangeToolArgs } from "./compress/types"
import { prepareSession } from "./compress/pipeline"
import { resolveRanges, validateNonOverlapping } from "./compress/range-utils"
import { allocateBlockId, allocateRunId, applyCompressionState } from "./compress/state"
import type { SessionState, WithParts } from "./state"
import { saveSessionState } from "./state/persistence"
import { markNoteInjection } from "./notes"

const RELEASE_INSTRUCTIONS = `Release completed history so it stops entering context. Select only closed ranges or complete active blocks that are no longer needed; active work, unresolved requests and anything still needed verbatim must stay. Original messages stay on disk for explicit dcp_read inspection, never for automatic context. Recorded summaries survive until native compaction but are not readable through dcp_read. Release is one-way: there is no decompress or recompress restore.`

function buildSchema() {
    return {
        topic: tool.schema
            .string()
            .describe(
                "Short label (3-5 words) for the released section, e.g., 'Finished auth exploration'",
            ),
        content: tool.schema
            .array(
                tool.schema.object({
                    startId: tool.schema
                        .string()
                        .describe(
                            "Visible message or block ID marking the start of the released range",
                        ),
                    endId: tool.schema
                        .string()
                        .describe(
                            "Visible message or block ID marking the end of the released range",
                        ),
                }),
            )
            .describe("Closed ranges or complete blocks to release"),
    }
}

// Pending tool work means the range is not actually complete.
function assertNoPendingTools(rawMessages: WithParts[], messageIds: string[]): void {
    const selected = new Set(messageIds)
    for (const message of rawMessages) {
        if (!selected.has(message.info.id)) continue
        for (const part of message.parts) {
            if (part.type !== "tool") continue
            if (part.state.status === "completed" || part.state.status === "error") continue
            throw new Error(
                `DCP release requires completed tool calls; ${part.tool} is still ${part.state.status}. Original context retained.`,
            )
        }
    }
}

export function createReleaseTool(ctx: ToolContext): ReturnType<typeof tool> {
    return tool({
        description: RELEASE_INSTRUCTIONS,
        args: buildSchema(),
        async execute(args, toolCtx) {
            const raw = args as CompressRangeToolArgs
            if (!raw.topic?.trim()) throw new Error("DCP release requires a non-empty topic")
            if (!Array.isArray(raw.content) || raw.content.length === 0)
                throw new Error("DCP release requires at least one range")
            const input: CompressRangeToolArgs = {
                topic: raw.topic,
                content: raw.content.map((entry) => ({
                    startId: entry.startId,
                    endId: entry.endId,
                    summary: "",
                })),
            }
            toolCtx.abort.throwIfAborted()

            const callId =
                typeof (toolCtx as unknown as { callID?: unknown }).callID === "string"
                    ? (toolCtx as unknown as { callID: string }).callID
                    : undefined

            const { rawMessages, searchContext } = await prepareSession(
                ctx,
                toolCtx,
                `Release: ${input.topic}`,
            )
            const plans = resolveRanges(input, searchContext, ctx.state)
            validateNonOverlapping(plans)

            for (const plan of plans) {
                if (
                    plan.selection.messageIds.includes(toolCtx.messageID) ||
                    (callId !== undefined && plan.selection.toolIds.includes(callId))
                )
                    throw new Error("DCP release cannot include its own active call")
            }
            assertNoPendingTools(
                rawMessages,
                plans.flatMap((plan) => plan.selection.messageIds),
            )
            toolCtx.abort.throwIfAborted()

            // Stage the whole mutation, persist it strictly, then publish. A failed
            // write leaves the live in-memory state untouched and reports failure.
            const live = ctx.state
            const staged: SessionState = {
                ...live,
                prune: { ...live.prune, messages: structuredClone(live.prune.messages) },
                stats: { ...live.stats },
            }
            const released: number[] = []
            const sourceMessageIds = new Set<string>()
            const selectedBlockIds = new Set<number>()
            for (const plan of plans) {
                const blockId = allocateBlockId(staged)
                const runId = allocateRunId(staged)
                applyCompressionState(
                    staged,
                    {
                        topic: input.topic,
                        batchTopic: input.topic,
                        startId: plan.entry.startId,
                        endId: plan.entry.endId,
                        mode: "range",
                        runId,
                        compressMessageId: toolCtx.messageID,
                        compressCallId: callId,
                        summaryTokens: 0,
                    },
                    plan.selection,
                    plan.anchorMessageId,
                    blockId,
                    "",
                    plan.selection.requiredBlockIds,
                )
                const block = staged.prune.messages.blocksById.get(blockId)
                block!.released = true
                block!.summary = ""
                block!.summaryTokens = 0
                // A released block must never re-inject a summary on later hooks.
                if (
                    staged.prune.messages.activeByAnchorMessageId.get(block!.anchorMessageId) ===
                    blockId
                )
                    staged.prune.messages.activeByAnchorMessageId.delete(block!.anchorMessageId)
                released.push(blockId)
                for (const messageId of block!.effectiveMessageIds) {
                    sourceMessageIds.add(messageId)
                }
                for (const consumedBlockId of block!.consumedBlockIds) {
                    selectedBlockIds.add(consumedBlockId)
                }
            }

            await saveSessionState(staged, ctx.logger)
            ctx.state.prune = staged.prune
            ctx.state.stats = staged.stats
            markNoteInjection(ctx.state.sessionId)

            toolCtx.metadata({ title: `Released ${released.length} block(s)` })
            const selectedBlocks = selectedBlockIds.size
            const blockSummary =
                selectedBlocks > 0
                    ? ` (covering ${selectedBlocks} selected old block${selectedBlocks === 1 ? "" : "s"})`
                    : ""
            return `Released ${sourceMessageIds.size} messages${blockSummary} into ${released.map((id) => formatRef(id, ctx.state)).join(", ")}.`
        },
    })
}

function formatRef(blockId: number, state: SessionState): string {
    // Keep the result visible: compact @bN@ refs are consumed as mentions by the UI.
    return state.idFormat === "compact" ? `b${blockId}` : `(b${blockId})`
}
