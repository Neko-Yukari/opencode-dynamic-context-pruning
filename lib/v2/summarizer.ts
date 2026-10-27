import type { Plugin } from "@opencode/plugin"
import type { ToolContext } from "../compress/types"

// Attachments are stored separately and represented by references in the source.
// Never replay their payloads through a temporary session or the host event stream.
export function createSummarizer(ctx: Plugin.Context): NonNullable<ToolContext["summarizer"]> {
    return {
        models: async (signal) => (await ctx.model.list(undefined, { signal })).data,
        generate: async (input, signal) => {
            signal.throwIfAborted()
            return ctx.generate.text({ prompt: input.prompt, model: input.model }, { signal })
        },
    }
}
