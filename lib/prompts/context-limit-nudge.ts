export const CONTEXT_LIMIT_NUDGE = `
<dcp-system-reminder>
MAX CONTEXT LIMIT REACHED. Compress the largest closed, completed ranges now.
You MUST use the \`compress\` tool now. Your summary MUST cover every file path, decision, constraint and key finding needed to continue. Keep the current goal, active constraints and open decisions.
If a safely closed range exists, you MUST use the compress tool now; a prose recap in chat does not replace the compress tool. If no safely closed range exists, continue useful work.
When several independent ranges are ready, batch their non-overlapping boundaries in one compress call. Do not compress active work, unresolved requests or the current compression call.
If the selected range includes compressed blocks, include each required placeholder exactly once in the summary.
Use dcp_release only after durable facts are stored in a summary, session note or memory; released originals remain readable through dcp_read but not in automatic context.
</dcp-system-reminder>
`

export const MODEL_SELECTION_CONTEXT_LIMIT_NUDGE = `
<dcp-system-reminder>
COMPRESS AT A SAFE BOUNDARY
Context is above the configured limit. Select the largest closed, completed ranges for compress now.
Pass one topic and multiple non-overlapping startId, endId entries in one call; the configured summarizer writes the summaries. Do not write or pass a summary yourself; do not substitute a summary of your own. Preserved by the configured summarizer.
Finish the current atomic step first; before continuing normal exploration or implementation, if a safely closed range exists, you MUST call the compress tool before continuing. If no safely closed range exists, continue useful work; do not wait for the entire task to finish.
A completed subtask can be compressed while the broader task continues; a prose recap in chat does not replace the compress tool. User-requested summaries are unaffected. Keep active work, recent tool results and unresolved evidence verbatim.
Use dcp_release only after durable facts are stored in a summary, session note or memory; released originals remain readable through dcp_read but not in automatic context.
</dcp-system-reminder>
`
