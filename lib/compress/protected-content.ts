import type { SessionState } from "../state"
import { isIgnoredUserMessage } from "../messages/query"
import { isToolProtected } from "../protected-patterns"
import {
    buildSubagentResultText,
    getSubAgentId,
    mergeSubagentResult,
} from "../subagents/subagent-results"
import { fetchSessionMessages } from "./search"
import type { SearchContext, SelectionResolution } from "./types"

function protectedSourceIds(
    selection: SelectionResolution,
    searchContext: SearchContext,
): string[] {
    const ids = new Set(selection.messageIds)
    for (const blockId of selection.requiredBlockIds) {
        const block = searchContext.summaryByBlockId.get(blockId)
        if (!block) throw new Error(`DCP protected block source unavailable: ${blockId}`)
        for (const id of block.effectiveMessageIds) {
            if (!searchContext.rawMessagesById.has(id))
                throw new Error(
                    `DCP protected original unavailable: ${id}; original context retained`,
                )
            ids.add(id)
        }
    }
    return [...ids]
}

export function appendProtectedUserMessages(
    summary: string,
    selection: SelectionResolution,
    searchContext: SearchContext,
    state: SessionState,
    enabled: boolean,
): string {
    if (!enabled) return summary

    const userTexts: string[] = []

    for (const messageId of protectedSourceIds(selection, searchContext)) {
        const message = searchContext.rawMessagesById.get(messageId)
        if (!message) continue
        if (message.info.role !== "user") continue
        if (isIgnoredUserMessage(message)) continue

        for (const part of message.parts) {
            if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
                userTexts.push(part.text)
                break
            }
        }
    }

    if (userTexts.length === 0) {
        return summary
    }

    const heading = "\n\nThe following user messages were sent in this conversation verbatim:"
    const body = userTexts.map((text) => `\n${text}`).join("")
    return summary + heading + body
}

export function appendProtectedPromptInfo(
    summary: string,
    selection: SelectionResolution,
    searchContext: SearchContext,
    state: SessionState,
    enabled: boolean,
): string {
    if (!enabled) return summary

    const protectedTexts: string[] = []

    for (const messageId of protectedSourceIds(selection, searchContext)) {
        const message = searchContext.rawMessagesById.get(messageId)
        if (!message) continue
        if (message.info.role !== "user") continue
        if (isIgnoredUserMessage(message)) continue

        for (const part of message.parts) {
            if (part.type !== "text" || typeof part.text !== "string") continue

            protectedTexts.push(...extractProtectedPromptInfo(part.text))
        }
    }

    if (protectedTexts.length === 0) {
        return summary
    }

    const heading =
        "\n\nThe following protected prompt information was included in this conversation verbatim:"
    const body = protectedTexts.map((text) => `\n${text}`).join("")
    return summary + heading + body
}

export function extractProtectedPromptInfo(text: string): string[] {
    const protectedTexts: string[] = []
    const protectTagRegex = /<protect>([\s\S]*?)<\/protect>/gi

    for (const match of text.matchAll(protectTagRegex)) {
        const protectedText = match[1]?.trim()
        if (protectedText) {
            protectedTexts.push(protectedText)
        }
    }

    return protectedTexts
}

export async function appendProtectedTools(
    client: any,
    state: SessionState,
    allowSubAgents: boolean,
    summary: string,
    selection: SelectionResolution,
    searchContext: SearchContext,
    protectedTools: string[],
    protectedFilePatterns: string[] = [],
): Promise<string> {
    if (protectedTools.length === 0 && protectedFilePatterns.length === 0) return summary
    const protectedOutputs: string[] = []

    for (const messageId of protectedSourceIds(selection, searchContext)) {
        const message = searchContext.rawMessagesById.get(messageId)
        if (!message) continue

        for (const part of message.parts) {
            if (part.type === "tool" && part.callID) {
                if (
                    isToolProtected(
                        part.tool,
                        part.state.input,
                        protectedTools,
                        protectedFilePatterns,
                        "metadata" in part.state ? part.state.metadata : undefined,
                    )
                ) {
                    const title = `Tool: ${part.tool}`
                    let output = ""

                    if (part.state?.status === "completed" && part.state?.output) {
                        output =
                            typeof part.state.output === "string"
                                ? part.state.output
                                : JSON.stringify(part.state.output)
                    }

                    if (
                        allowSubAgents &&
                        (part.tool === "task" || part.tool === "subagent") &&
                        part.state?.status === "completed" &&
                        typeof part.state?.output === "string"
                    ) {
                        const cachedSubAgentResult = state.subAgentResultCache.get(part.callID)

                        if (cachedSubAgentResult !== undefined) {
                            if (cachedSubAgentResult) {
                                output = mergeSubagentResult(
                                    part.state.output,
                                    cachedSubAgentResult,
                                )
                            }
                        } else {
                            const subAgentSessionId = getSubAgentId(part)
                            if (subAgentSessionId) {
                                const subAgentMessages = await fetchSessionMessages(
                                    client,
                                    subAgentSessionId,
                                )
                                const subAgentResultText = buildSubagentResultText(subAgentMessages)

                                if (subAgentResultText) {
                                    state.subAgentResultCache.set(part.callID, subAgentResultText)
                                    output = mergeSubagentResult(
                                        part.state.output,
                                        subAgentResultText,
                                    )
                                }
                            }
                        }
                    }

                    if (output) {
                        protectedOutputs.push(`\n### ${title}\n${output}`)
                    }
                }
            }
        }
    }

    if (protectedOutputs.length === 0) {
        return summary
    }

    const heading = "\n\nThe following protected tools were used in this conversation as well:"
    return summary + heading + protectedOutputs.join("")
}
