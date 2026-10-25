import type { Logger } from "../logger"
import type { SessionState, WithParts } from "../state"

export interface RecompressCommandContext {
    client: any
    state: SessionState
    logger: Logger
    sessionId: string
    messages: WithParts[]
    args: string[]
}

export async function handleRecompressCommand(_ctx: RecompressCommandContext): Promise<void> {
    throw new Error(
        "DCP restore commands are disabled: compression and release are one-way. Use dcp_read to inspect originals.",
    )
}
