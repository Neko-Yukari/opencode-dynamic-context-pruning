import type { IdFormat } from "../message-ids"

export function rangePrompt(format: IdFormat = "xml"): string {
    const compact = format === "compact"
    const message = compact ? "@4@" : "mNNNN"
    const block = compact ? "@b1@" : "bN"
    const placeholder = compact ? "@b1@" : "(bN)"
    return `Collapse a range in the conversation into a detailed summary.

THE SUMMARY
Your summary must be EXHAUSTIVE. Capture file paths, function signatures, decisions made, constraints discovered, key findings... EVERYTHING that maintains context integrity. This is not a brief note - it is an authoritative record so faithful that the original conversation adds no value.

USER INTENT FIDELITY
When the compressed range includes user messages, preserve the user's intent with extra care. Do not change scope, constraints, priorities, acceptance criteria, or requested outcomes.
Directly quote user messages when they are short enough to include safely. Direct quotes are preferred when they best preserve exact meaning.

Yet be LEAN. Strip away the noise: failed attempts that led nowhere, verbose tool outputs, back-and-forth exploration. What remains should be pure signal - golden nuggets of detail that preserve full understanding with zero ambiguity.

PREVIOUSLY COMPRESSED BLOCKS
When the selected range includes previously compressed blocks, their stored summaries are part of the source you receive. You MAY rewrite them together with the new messages into one coherent, shorter summary.
- Preserve user intent, constraints, decisions, evidence, failures, status, uncertainty and unfinished work carried by those summaries.
- Do not paste an old block body verbatim and do not invent block references outside the selected range.
- Block IDs mentioned in prose are plain labels: nothing is expanded into your summary and no old body is appended after generation.

BOUNDARY IDS
You specify boundaries by ID using the injected IDs visible in the conversation:

- \`${message}\` IDs identify raw messages
- \`${block}\` IDs identify previously compressed blocks

${compact ? "Each message has an ID like `@4@`. Copy the whole marker, including both `@` characters, into `startId` and `endId`." : "Each message has an ID inside XML metadata tags like `<dcp-message-id>...</dcp-message-id>`."}
The same ID tag appears in every tool output of the message it belongs to — each unique ID identifies one complete message.
Treat these tags as boundary metadata only, not as tool result content.

Rules:

- Pick \`startId\` and \`endId\` directly from injected IDs in context.
- IDs must exist in the current visible context.
- \`startId\` must appear before \`endId\`.
- Do not invent IDs. Use only IDs that are present in context.

BATCHING
When multiple independent ranges are ready and their boundaries do not overlap, include all of them as separate entries in the \`content\` array of a single tool call. Each entry should have its own \`startId\`, \`endId\`, and \`summary\`.
`
}

export const COMPRESS_RANGE = rangePrompt()
