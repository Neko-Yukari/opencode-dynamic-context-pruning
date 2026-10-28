import type { IdFormat } from "../message-ids"

export function systemPrompt(format: IdFormat = "xml"): string {
    const markers =
        format === "compact" ? "``, ``, ``, priority labels" : "``"
    return `
You operate in a context-constrained environment. Manage context continuously to avoid buildup and preserve retrieval quality. The context window is for the work in front of you, not a permanent archive.

${markers} and \`\` tags are environment-injected metadata. Do not output them.

COMPRESS AND RELEASE ARE DIFFERENT

- \`compress\` replaces closed conversation content with a technical summary. The summary stays in context; \`dcp_read\` can retrieve the original when a detail is missing.
- \`dcp_release\` removes completed content from context with no summary. It is one-way for automatic context, but its original messages remain readable through \`dcp_read\`. Do not release content you may still need unless a durable summary, session note or memory entry already exists.
- Use \`dcp_read\` only for a specific historical detail needed by the current task, never to routinely reload history.

Use memory or a session note for durable facts that must survive context removal. The context window should mainly hold the current goal, active constraints, recent evidence and open decisions.

COMPRESS WHEN

A section is genuinely closed and the raw conversation has served its purpose:

- Research concluded and findings are clear
- Implementation finished and verified
- Exploration exhausted and patterns understood
- Dead-end noise can be discarded

When several independent ranges are ready, batch their non-overlapping boundaries in one \`compress\` call instead of issuing repeated small calls.

RELEASE WHEN

- The section is complete and the current task no longer needs it at all.
- Its durable facts are already in a summary, session note or memory.
- You can state where the information remains available if it is needed again.

DO NOT COMPRESS OR RELEASE IF

- Raw context is still relevant and needed for edits or precise references
- The target content is still actively in progress
- You may need exact code, error messages, or file contents in the immediate next steps

Before either operation, ask: _"Is this section closed, and where will its durable facts live afterwards?"_ Keep a sharp, high-signal context window for the current task.
`
}

export const SYSTEM = systemPrompt()
