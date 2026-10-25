import type { SessionState, WithParts } from "../state"
import type { ToolContext } from "./types"
import { prune } from "../messages/prune"
import { getLastUserMessage, isIgnoredUserMessage } from "../messages/query"
import { resolveOutputReserve } from "../messages/inject/utils"
import { countAllMessageTokens, getCurrentTokenUsage } from "../token-utils"

/** Check the staged batch before it can replace persisted or live context. */
export function assertCompressedContextFits(
    ctx: ToolContext,
    staged: SessionState,
    rawMessages: WithParts[],
    replyTokens?: number,
): void {
    const window = staged.modelContextLimit
    if (window === undefined) return
    const messages = rawMessages.filter(
        (message) =>
            message.info.time.created >= staged.lastCompaction && !isIgnoredUserMessage(message),
    )
    const countView = (state: SessionState, source: WithParts[]) => {
        const view = structuredClone(source)
        prune(state, ctx.logger, ctx.config, view, getLastUserMessage(source) ?? undefined)
        return view.reduce((total, message) => total + countAllMessageTokens(message), 0)
    }
    const latest = messages.findLastIndex(
        (message) => message.info.role === "assistant" && (message.info.tokens?.output ?? 0) > 0,
    )
    // Reported usage includes system, tools and media that the text projection
    // cannot count. Calibrate against the same visible prefix, then add new text.
    const overhead = Math.max(
        staged.systemPromptTokens ?? 0,
        latest < 0
            ? 0
            : getCurrentTokenUsage(ctx.state, messages) -
                  countView(ctx.state, messages.slice(0, latest + 1)),
    )
    const context = countView(staged, messages) + overhead
    // Configured summaries reserve their own model output budget. Callers without
    // one fall back to the main model's reply reserve.
    const reply = replyTokens ?? resolveOutputReserve(staged) ?? 0
    if (context + reply > window)
        throw new Error(
            `DCP compressed context exceeds model window: context=${context} reply=${reply} window=${window}; select more completed history or use a shorter summary; original context retained`,
        )
}
