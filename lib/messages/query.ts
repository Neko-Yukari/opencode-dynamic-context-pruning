import type { PluginConfig } from "../config"
import type { WithParts } from "../state"

export const getLastUserMessage = (
    messages: WithParts[],
    startIndex?: number,
): WithParts | null => {
    const start = startIndex ?? messages.length - 1
    for (let i = start; i >= 0; i--) {
        const msg = messages[i]
        if (msg.info.role === "user" && !isIgnoredUserMessage(msg)) {
            return msg
        }
    }
    return null
}

export const messageHasCompress = (message: WithParts): boolean => {
    if (message.info.role !== "assistant") {
        return false
    }

    return message.parts.some(
        (part) =>
            part.type === "tool" && part.tool === "compress" && part.state?.status === "completed",
    )
}

export const isIgnoredUserMessage = (message: WithParts): boolean => {
    if (message.info.role !== "user") {
        return false
    }

    if (message.parts.length === 0) {
        return true
    }

    for (const part of message.parts) {
        if (!(part as any).ignored) {
            return false
        }
    }

    return true
}

export function isProtectedUserMessage(config: PluginConfig, message: WithParts): boolean {
    return (
        config.compress.mode === "message" &&
        config.compress.protectUserMessages &&
        message.info.role === "user" &&
        !isIgnoredUserMessage(message)
    )
}
