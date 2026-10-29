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

/**
 * Payload of the host's `experimental.idle` session hook. OpenCode 2.2.1 sends
 * `{ sessionID, background }`; the optional directory fields cover a host that
 * also carries the session's location, so a payload is only treated as local
 * when it names no location or names this one.
 */
export interface IdleHookEvent {
    sessionID: string
    background?: boolean
    location?: { readonly directory?: string }
    directory?: string
}

/**
 * The session an `experimental.idle` hook belongs to, or undefined when it
 * addresses another directory. A payload without a location counts as this
 * plugin's directory, matching the event-path default above.
 */
export function idleHookSession(event: IdleHookEvent, directory: string): string | undefined {
    if (typeof event.sessionID !== "string") return undefined
    const location = event.location?.directory ?? event.directory
    if (!sameDirectory(location, directory)) return undefined
    return event.sessionID
}
