import { randomUUID } from "node:crypto"
import type { Plugin } from "@opencode/plugin"
import type { Logger } from "../logger"
import type { AutoFoldNotice, AutoFoldNotify } from "../compress/autofold"

/**
 * User-visible notices use the same host call background-enhanced peer messages
 * use: a synthetic session message that the chat renders as its own row. Text
 * passed this way is model-visible, like a peer message, so it carries only the
 * fold notice itself and never diagnostics.
 */
export function createNotifier(ctx: Plugin.Context, logger: Logger): AutoFoldNotify {
    return async (notice: AutoFoldNotice): Promise<void> => {
        logger.debug("DCP notice", { sessionID: notice.sessionID, text: notice.text })
        const input = {
            id: `msg_${randomUUID().replaceAll("-", "")}`,
            sessionID: notice.sessionID,
            text: notice.text,
            description: notice.description,
            metadata: { ...notice.metadata },
            delivery: "steer" as const,
            resume: false,
        }
        await ctx.session.synthetic(input as unknown as Parameters<typeof ctx.session.synthetic>[0])
    }
}
