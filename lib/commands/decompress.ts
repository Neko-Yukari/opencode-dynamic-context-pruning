import type { Logger } from "../logger"
import type { SessionState, WithParts } from "../state"

export interface DecompressCommandContext {
    client: any
    state: SessionState
    logger: Logger
    sessionId: string
    messages: WithParts[]
    args: string[]
}

export async function handleDecompressCommand(_ctx: DecompressCommandContext): Promise<void> {
    throw new Error(
        "DCP restore commands are disabled: compression and release are one-way. Use dcp_read to inspect originals.",
    )
}
