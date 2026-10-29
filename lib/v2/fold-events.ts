/**
 * Which host events may start an auto-fold prepare pass.
 *
 * A prepare spends a summarizer call, so it happens only outside a request:
 * after a finished turn (`session.execution.*`) or when the session falls idle
 * (`session.idle`, including turns that end without a terminal execution event).
 * Repeated events for the same turn are collapsed by the prepared-artifact
 * anchor + TTL, not by a second state machine here.
 */
export const FOLD_PREPARE_EVENTS = new Set([
    "session.execution.succeeded",
    "session.execution.failed",
    "session.execution.interrupted",
    "session.idle",
])

/** Shape of a host bus event as far as prepare dispatch needs to read it. */
export interface FoldPrepareEvent {
    type: string
    /** Bus payloads differ per event; only `sessionID` is read, when present. */
    data?: object
    location?: { readonly directory?: string }
}

export function sameDirectory(left: string | undefined, right: string): boolean {
    if (left === undefined) return true
    const normalize = (value: string) =>
        value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()
    return normalize(left) === normalize(right)
}

/**
 * The session a fold-prepare event belongs to, or undefined when the event is
 * irrelevant (another event type, another directory, or no session).
 */
export function foldPrepareTrigger(
    event: FoldPrepareEvent,
    directory: string,
): string | undefined {
    if (!FOLD_PREPARE_EVENTS.has(event.type)) return undefined
    const sessionID = (event.data as { sessionID?: unknown } | undefined)?.sessionID
    if (typeof sessionID !== "string") return undefined
    if (!sameDirectory(event.location?.directory, directory)) return undefined
    return sessionID
}
