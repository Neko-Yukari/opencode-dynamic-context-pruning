export const CONTEXT_LIMIT_NUDGE = `<dcp-system-reminder>
CRITICAL WARNING: MAX CONTEXT LIMIT REACHED

You are at or beyond the configured max context threshold. This is an emergency context-recovery moment.

You MUST use the \`compress\` tool now. Do not continue normal exploration until compression is handled.

If you are in the middle of a critical atomic operation, finish that atomic step first, then compress immediately.

SELECTION PROCESS
Start from older, resolved history and capture as much stale context as safely possible in one pass.
Avoid the newest active working messages unless it is clearly closed.

SUMMARY REQUIREMENTS
Your summary MUST cover all essential details from the selected messages so work can continue.
If the compressed range includes user messages, preserve user intent exactly. Prefer direct quotes for short user messages to avoid semantic drift.
</dcp-system-reminder>
`

export const MODEL_SELECTION_CONTEXT_LIMIT_NUDGE = `
<dcp-system-reminder>
CONTEXT LIMIT REACHED — COMPRESS AT A SAFE BOUNDARY

You are at or beyond the configured max context threshold. Recover space by compressing older, genuinely finished history once you reach a safe boundary. Finish the current atomic step first instead of abandoning it.

COMPRESS TOOL CONTRACT
Call \`compress\` with only \`topic\` and \`content: [{ startId, endId }]\` using observed message or block IDs.
The configured summarizer model writes the summary. Do not write or pass a summary yourself.

SELECTION PROCESS
Start from older, resolved history that is truly complete and has no remaining raw-fidelity dependency.
Do not compress active or unresolved work, messages still waiting on a user answer, raw output needed for exact verification, or this compress call.
If no safely closed range exists, continue useful work without forcing compression, and do not repeat compress attempts on the same range.

ON FAILURE
If compression fails, the original context is retained. Report the diagnostic; do not substitute a summary of your own.
</dcp-system-reminder>
`
