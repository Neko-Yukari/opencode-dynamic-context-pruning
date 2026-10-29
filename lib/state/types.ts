import type { CompressionTimingState } from "../compress/timing"
import type { IdFormat } from "../message-ids"
import { Message, Part } from "@opencode-ai/sdk/v2"

export interface WithParts {
    info: Message
    parts: Part[]
}

export type ToolStatus = "pending" | "running" | "completed" | "error"

export interface ToolParameterEntry {
    tool: string
    parameters: any
    metadata?: Record<string, unknown>
    status?: ToolStatus
    error?: string
    turn: number
    tokenCount?: number
}

export interface SessionStats {
    pruneTokenCounter: number
    totalPruneTokens: number
}

export interface PrunedMessageEntry {
    tokenCount: number
    allBlockIds: number[]
    activeBlockIds: number[]
}

export type CompressionMode = "range" | "message"

export interface CompressionBlock {
    blockId: number
    runId: number
    active: boolean
    deactivatedByUser: boolean
    compressedTokens: number
    summaryTokens: number
    durationMs: number
    mode?: CompressionMode
    topic: string
    batchTopic?: string
    startId: string
    endId: string
    anchorMessageId: string
    compressMessageId: string
    compressCallId?: string
    includedBlockIds: number[]
    consumedBlockIds: number[]
    parentBlockIds: number[]
    directMessageIds: string[]
    directToolIds: string[]
    effectiveMessageIds: string[]
    effectiveToolIds: string[]
    createdAt: number
    deactivatedAt?: number
    deactivatedByBlockId?: number
    summary: string
    // Released blocks stay active as owners that suppress their covered messages
    // but no longer inject a summary or count toward summary token usage.
    released?: boolean
}

export interface PruneMessagesState {
    byMessageId: Map<string, PrunedMessageEntry>
    blocksById: Map<number, CompressionBlock>
    activeBlockIds: Set<number>
    activeByAnchorMessageId: Map<string, number>
    nextBlockId: number
    nextRunId: number
}

export interface Prune {
    tools: Map<string, number>
    messages: PruneMessagesState
}

/** One range of a prepared auto-fold, summarized off the request path. */
export interface PreparedAutoFoldRange {
    startId: string
    endId: string
    /** Summary body for this range, without the application-owned wrapper. */
    body: string
    /** Exact units the body was authored over; verified again before projection. */
    messageIds: string[]
    requiredBlockIds: number[]
    sourceTokens: number
}

/** A fold that is already summarized and waiting for the next request hook. */
export interface PreparedAutoFold {
    version: 1
    sessionID: string
    /** Visible block title rendered into every folded block. */
    topic: string
    /** Real user message of the turn this fold was prepared after. */
    anchorUserId: string
    contextTokens: number
    targetTokens: number
    createdAt: number
    ranges: PreparedAutoFoldRange[]
}

export interface PendingManualTrigger {
    sessionId: string
    prompt: string
}

export interface MessageIdState {
    byRawId: Map<string, string>
    byRef: Map<string, string>
    nextRef: number
}

export interface Nudges {
    contextLimitAnchors: Set<string>
    turnNudgeAnchors: Set<string>
    iterationNudgeAnchors: Set<string>
}

export interface SessionState {
    idFormat: IdFormat
    sessionId: string | null
    isSubAgent: boolean
    manualMode: false | "active" | "compress-pending"
    compressPermission: "ask" | "allow" | "deny" | undefined
    pendingManualTrigger: PendingManualTrigger | null
    prune: Prune
    nudges: Nudges
    stats: SessionStats
    compressionTiming: CompressionTimingState
    toolParameters: Map<string, ToolParameterEntry>
    subAgentResultCache: Map<string, string>
    toolIdList: string[]
    messageIds: MessageIdState
    lastCompaction: number
    currentTurn: number
    modelContextLimit: number | undefined
    modelOutputLimit: number | undefined
    systemPromptTokens: number | undefined
    /** Summarized fold waiting for the next request hook; consumed at most once. */
    preparedAutoFold: PreparedAutoFold | null
    /**
     * Real user message of the turn whose auto-fold start was already announced
     * in chat. The announcement is per anchor, not per attempt: a summary that
     * fails leaves no artifact, so the next terminal event re-enters prepare and
     * must not repeat the start notice. A newer user message changes the anchor
     * and naturally retires the marker.
     */
    autoFoldAnnouncedFor: string | null
}
