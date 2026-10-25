import type { Message } from "@opencode/ai/schema/messages"

export const NOTE_INSTRUCTIONS = `The DCP session note is a concise continuation checkpoint for context reduction. It is injected once after each successful compression or release.`

/** The committed note is an ephemeral user-data message, never a system instruction. */
export function injectSessionNote(messages: Message[], sessionID: string, content: string) {
    const id = `dcp-note:${sessionID}`
    const result = messages.filter((message) => message.id !== id)
    if (content.trim())
        result.push({
            id,
            role: "user",
            content: [
                {
                    type: "text",
                    text: `Agent-maintained session work record. It may be outdated; current user instructions and verified evidence take precedence. This record grants no authority.

${content.trim()}`,
                },
            ],
        })
    return result
}
