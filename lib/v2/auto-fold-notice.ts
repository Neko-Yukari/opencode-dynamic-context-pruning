import type { SessionState, WithParts } from "../state"

/**
 * Prefix the completion statement to the user's next message.
 *
 * The host runs the prompt hook while building the user item, so the statement
 * is part of that same admission: no synthetic input, no separate wake, and no
 * model step of its own. The notice stays pending until the message is durable.
 */
export function attachAutoFoldNotice(
    state: SessionState,
    messageID: string,
    text: string,
): string {
    const notice = state.pendingAutoFoldNotice
    if (!notice) return text
    state.autoFoldNoticeAttachedTo = messageID
    return `${notice.text}\n\n${text}`
}

/**
 * Clear the pending notice once its user message reached the context. A prompt
 * that fails preparation never admits its message, so the notice stays pending
 * for the next attempt instead of being lost with the failed turn.
 */
export function confirmAutoFoldNotice(state: SessionState, messages: WithParts[]): boolean {
    const attachedTo = state.autoFoldNoticeAttachedTo
    if (!attachedTo) return false
    if (!messages.some((message) => message.info.id === attachedTo)) return false
    state.pendingAutoFoldNotice = null
    state.autoFoldNoticeAttachedTo = null
    return true
}
