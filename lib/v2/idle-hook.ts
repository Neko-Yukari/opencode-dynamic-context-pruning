import type { Plugin } from "@opencode/plugin"
import type { Logger } from "../logger"
import { idleHookSession, type IdleHookEvent } from "./fold-events"

/**
 * Session hook added in OpenCode 2.2.1. It runs before a session goes idle and
 * carries `{ sessionID, background }`, so a turn that ends without a terminal
 * execution event can still prepare an auto-fold.
 */
export const IDLE_HOOK = "experimental.idle"

/**
 * `session.hook` narrowed to the one hook the installed `@opencode/plugin`
 * types do not declare yet. The host accepts the name at runtime; setup must
 * still work on a host that rejects it, which is why registration is guarded.
 */
export type IdleHook = (
    name: typeof IDLE_HOOK,
    callback: (event: IdleHookEvent) => Promise<void> | void,
) => Promise<unknown>

export function idleHook(ctx: Plugin.Context): IdleHook {
    return (name, callback) => (ctx.session.hook as unknown as IdleHook)(name, callback)
}

/**
 * Register the idle-hook prepare path. A host that does not know the hook kind
 * only produces a warning; it never fails plugin setup, because the event-path
 * prepare below it remains the fallback. Dedupe stays in `prepareAutoFold`, so
 * this module holds no per-turn state.
 */
export async function registerIdlePrepare(input: {
    hook: IdleHook
    logger: Logger
    directory: string
    prepare: (sessionID: string, event: IdleHookEvent) => Promise<void>
}): Promise<boolean> {
    try {
        await input.hook(IDLE_HOOK, async (event) => {
            const sessionID = idleHookSession(event, input.directory)
            if (sessionID === undefined) {
                input.logger.debug("DCP experimental.idle ignored for another directory", {
                    sessionID: event.sessionID,
                    directory: event.location?.directory ?? event.directory,
                })
                return
            }
            // `trigger` on the prepare log names the path; this line keeps the
            // host's background flag visible next to it.
            input.logger.debug("DCP experimental.idle hook fired", {
                sessionID,
                background: event.background,
            })
            await input.prepare(sessionID, event)
        })
        return true
    } catch (error) {
        await input.logger.warn("DCP experimental.idle hook not registered", {
            error: (error as Error)?.message ?? String(error),
        })
        return false
    }
}
