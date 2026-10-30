import type { SessionState, WithParts } from "../../state"
import type { PluginConfig } from "../../config"
import { resolveContextLimit } from "../../context-limit"
import {
    appendGuidanceToDcpTag,
    buildCompressedBlockGuidance,
    renderMessagePriorityGuidance,
} from "../../prompts/extensions/nudge"
import type { RuntimePrompts } from "../../prompts/store"
import type { UserMessage } from "@opencode-ai/sdk/v2"
import {
    type CompressionPriorityMap,
    type MessagePriority,
    listPriorityRefsBeforeIndex,
} from "../priority"
import { getLastUserMessage, isIgnoredUserMessage } from "../query"
import { getCurrentTokenUsage } from "../../token-utils"
import { getActiveSummaryTokenUsage } from "../../state/utils"

const MESSAGE_MODE_NUDGE_PRIORITY: MessagePriority = "high"

export interface LastUserModelContext {
    providerId: string | undefined
    modelId: string | undefined
}

export interface LastNonIgnoredMessage {
    message: WithParts
    index: number
}

export function getNudgeFrequency(config: PluginConfig): number {
    return Math.max(1, Math.floor(config.compress.nudgeFrequency || 1))
}

export function getIterationNudgeThreshold(config: PluginConfig): number {
    return Math.max(1, Math.floor(config.compress.iterationNudgeThreshold || 1))
}

export function findLastNonIgnoredMessage(messages: WithParts[]): LastNonIgnoredMessage | null {
    for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i]
        if (isIgnoredUserMessage(message)) {
            continue
        }
        return { message, index: i }
    }

    return null
}

export function countMessagesAfterIndex(messages: WithParts[], index: number): number {
    let count = 0

    for (let i = index + 1; i < messages.length; i++) {
        const message = messages[i]
        if (isIgnoredUserMessage(message)) {
            continue
        }
        count++
    }

    return count
}

export function getModelInfo(messages: WithParts[]): LastUserModelContext {
    const lastUserMessage = getLastUserMessage(messages)
    if (!lastUserMessage) {
        return {
            providerId: undefined,
            modelId: undefined,
        }
    }

    const userInfo = lastUserMessage.info as UserMessage
    return {
        providerId: userInfo.model.providerID,
        modelId: userInfo.model.modelID,
    }
}

function resolveContextTokenLimit(
    config: PluginConfig,
    state: SessionState,
    providerId: string | undefined,
    modelId: string | undefined,
    threshold: "max" | "min",
): number | undefined {
    const context = state.modelContextLimit

    const modelLimits =
        threshold === "max" ? config.compress.modelMaxLimits : config.compress.modelMinLimits
    if (modelLimits && providerId !== undefined && modelId !== undefined) {
        const providerModelId = `${providerId}/${modelId}`
        const modelLimit = modelLimits[providerModelId]
        if (modelLimit !== undefined) {
            return resolveContextLimit(modelLimit, context)
        }
    }

    const globalLimit =
        threshold === "max" ? config.compress.maxContextLimit : config.compress.minContextLimit
    const resolved = resolveContextLimit(globalLimit, context)
    // Never nudge past the window the model actually accepts.
    return resolved === undefined || context === undefined ? resolved : Math.min(resolved, context)
}

/**
 * Tokens that must stay free for the model's own reply. The advertised output
 * allowance is used when the host reports it, otherwise 20% of the window; it is
 * capped at half the window so a small context never collapses the budget.
 */
export function resolveOutputReserve(state: SessionState): number | undefined {
    const context = state.modelContextLimit
    const explicit = state.modelOutputLimit
    if (context === undefined) return explicit
    const reserve = explicit ?? Math.round(context * 0.2)
    return Math.max(0, Math.min(reserve, Math.round(context * 0.5)))
}

export function isContextOverLimits(
    config: PluginConfig,
    state: SessionState,
    providerId: string | undefined,
    modelId: string | undefined,
    messages: WithParts[],
) {
    const summaryTokenExtension = config.compress.summaryBuffer
        ? getActiveSummaryTokenUsage(state)
        : 0
    const resolvedMaxContextLimit = resolveContextTokenLimit(
        config,
        state,
        providerId,
        modelId,
        "max",
    )
    const reserve = resolveOutputReserve(state)
    const safeBudget =
        state.modelContextLimit !== undefined && reserve !== undefined
            ? Math.max(0, state.modelContextLimit - reserve)
            : undefined
    const cappedMax =
        resolvedMaxContextLimit === undefined
            ? undefined
            : safeBudget === undefined
              ? resolvedMaxContextLimit
              : Math.min(resolvedMaxContextLimit, safeBudget)
    const maxContextLimit = cappedMax === undefined ? undefined : cappedMax + summaryTokenExtension
    const rawMinContextLimit = resolveContextTokenLimit(config, state, providerId, modelId, "min")
    const minContextLimit =
        rawMinContextLimit !== undefined && maxContextLimit !== undefined
            ? Math.min(rawMinContextLimit, maxContextLimit)
            : rawMinContextLimit
    const currentTokens = getCurrentTokenUsage(state, messages)

    const overMaxLimit = maxContextLimit === undefined ? false : currentTokens > maxContextLimit
    const overMinLimit = minContextLimit === undefined ? true : currentTokens >= minContextLimit

    return {
        overMaxLimit,
        overMinLimit,
    }
}

export function addAnchor(
    anchorMessageIds: Set<string>,
    anchorMessageId: string,
    anchorMessageIndex: number,
    messages: WithParts[],
    interval: number,
): boolean {
    if (anchorMessageIndex < 0) {
        return false
    }

    let latestAnchorMessageIndex = -1
    for (let i = messages.length - 1; i >= 0; i--) {
        if (anchorMessageIds.has(messages[i].info.id)) {
            latestAnchorMessageIndex = i
            break
        }
    }

    const shouldAdd =
        latestAnchorMessageIndex < 0 || anchorMessageIndex - latestAnchorMessageIndex >= interval
    if (!shouldAdd) {
        return false
    }

    const previousSize = anchorMessageIds.size
    anchorMessageIds.add(anchorMessageId)
    return anchorMessageIds.size !== previousSize
}

function buildMessagePriorityGuidance(
    messages: WithParts[],
    compressionPriorities: CompressionPriorityMap | undefined,
    anchorIndex: number,
    priority: MessagePriority,
): string {
    if (!compressionPriorities || compressionPriorities.size === 0) {
        return ""
    }

    const refs = listPriorityRefsBeforeIndex(messages, compressionPriorities, anchorIndex, priority)
    const priorityLabel = `${priority[0].toUpperCase()}${priority.slice(1)}`

    return renderMessagePriorityGuidance(priorityLabel, refs)
}

/** Wrap bare nudge text so it reads as environment metadata, never as a turn. */
function wrapReminder(text: string): string {
    const trimmed = text.trim()
    if (!trimmed || trimmed.includes("</dcp-system-reminder>")) return trimmed
    return `<dcp-system-reminder>\n${trimmed}\n</dcp-system-reminder>`
}

/**
 * The nudge for this request, or "" when the latest message carries no anchor.
 * Only the newest message can trigger it: historical anchors are never replayed,
 * so nothing in the cached prefix changes when blocks or anchors change.
 */
export function renderCompressNudge(
    state: SessionState,
    config: PluginConfig,
    messages: WithParts[],
    prompts: RuntimePrompts,
    compressionPriorities?: CompressionPriorityMap,
): string {
    const last = findLastNonIgnoredMessage(messages)
    if (!last) return ""
    const id = last.message.info.id
    const base = state.nudges.contextLimitAnchors.has(id)
        ? prompts.contextLimitNudge
        : state.nudges.iterationNudgeAnchors.has(id)
          ? prompts.iterationNudge
          : state.nudges.turnNudgeAnchors.has(id)
            ? prompts.turnNudge
            : ""
    const nudge = wrapReminder(base)
    if (!nudge) return ""
    const guidance =
        config.compress.mode === "message"
            ? buildMessagePriorityGuidance(
                  messages,
                  compressionPriorities,
                  last.index,
                  MESSAGE_MODE_NUDGE_PRIORITY,
              )
            : buildCompressedBlockGuidance(state, config.compress.model !== undefined)
    return appendGuidanceToDcpTag(nudge, guidance)
}
