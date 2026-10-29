import type {
    CompressionBlock,
    PruneMessagesState,
    PrunedMessageEntry,
    SessionState,
    WithParts,
} from "./types"
import { isIgnoredUserMessage, messageHasCompress } from "../messages/query"
import type { IdFormat } from "../message-ids"

export const isMessageCompacted = (state: SessionState, msg: WithParts): boolean => {
    if (msg.info.time.created < state.lastCompaction) {
        return true
    }
    const pruneEntry = state.prune.messages.byMessageId.get(msg.info.id)
    if (pruneEntry && pruneEntry.activeBlockIds.length > 0) {
        return true
    }
    return false
}

interface PersistedPruneMessagesState {
    byMessageId: Record<string, PrunedMessageEntry>
    blocksById: Record<string, CompressionBlock>
    activeBlockIds: number[]
    activeByAnchorMessageId: Record<string, number>
    nextBlockId: number
    nextRunId: number
}

export function serializePruneMessagesState(
    messagesState: PruneMessagesState,
): PersistedPruneMessagesState {
    return {
        byMessageId: Object.fromEntries(messagesState.byMessageId),
        blocksById: Object.fromEntries(
            Array.from(messagesState.blocksById.entries()).map(([blockId, block]) => [
                String(blockId),
                block,
            ]),
        ),
        activeBlockIds: Array.from(messagesState.activeBlockIds),
        activeByAnchorMessageId: Object.fromEntries(messagesState.activeByAnchorMessageId),
        nextBlockId: messagesState.nextBlockId,
        nextRunId: messagesState.nextRunId,
    }
}

export async function isSubAgentSession(client: any, sessionID: string): Promise<boolean> {
    const result = await client.session.get({ path: { id: sessionID } })
    return !!result.data.parentID
}

export function findLastCompactionTimestamp(messages: WithParts[]): number {
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i]
        if (msg.info.role === "assistant" && msg.info.summary === true) {
            return msg.info.time.created
        }
    }
    return 0
}

export function countTurns(state: SessionState, messages: WithParts[]): number {
    let turnCount = 0
    for (const msg of messages) {
        if (isMessageCompacted(state, msg)) {
            continue
        }
        for (const part of msg.parts) {
            if (part.type === "step-start") {
                turnCount++
            }
        }
    }
    return turnCount
}

export function loadPruneMap(obj?: Record<string, number>): Map<string, number> {
    return new Map(Object.entries(obj ?? {}))
}

export interface PersistedMessageIdState {
    byRawId?: Record<string, string>
    byRef?: Record<string, string>
    nextRef?: number
    format?: IdFormat
}

export function serializeMessageIdState(state: SessionState): PersistedMessageIdState {
    return {
        byRawId: Object.fromEntries(state.messageIds.byRawId),
        byRef: Object.fromEntries(state.messageIds.byRef),
        nextRef: state.messageIds.nextRef,
        format: state.idFormat,
    }
}

// Restore aliases without allocating new ones or lowering the high-water mark, so
// a service restart never renumbers refs the model has already seen.
export function loadMessageIdState(state: SessionState, persisted?: PersistedMessageIdState): void {
    if (!persisted) return
    state.messageIds.byRawId = new Map(Object.entries(persisted.byRawId ?? {}))
    state.messageIds.byRef = new Map(Object.entries(persisted.byRef ?? {}))
    state.messageIds.nextRef = Math.max(state.messageIds.nextRef, persisted.nextRef ?? 1)
}

export function createPruneMessagesState(): PruneMessagesState {
    return {
        byMessageId: new Map<string, PrunedMessageEntry>(),
        blocksById: new Map<number, CompressionBlock>(),
        activeBlockIds: new Set<number>(),
        activeByAnchorMessageId: new Map<string, number>(),
        nextBlockId: 1,
        nextRunId: 1,
    }
}

export function loadPruneMessagesState(
    persisted?: PersistedPruneMessagesState,
): PruneMessagesState {
    const state = createPruneMessagesState()
    if (!persisted) return state
    return {
        byMessageId: new Map(Object.entries(persisted.byMessageId)),
        blocksById: new Map(
            Object.entries(persisted.blocksById).map(([id, block]) => [Number(id), block]),
        ),
        activeBlockIds: new Set(persisted.activeBlockIds),
        activeByAnchorMessageId: new Map(Object.entries(persisted.activeByAnchorMessageId)),
        nextBlockId: persisted.nextBlockId,
        nextRunId: persisted.nextRunId,
    }
}

export function collectTurnNudgeAnchors(messages: WithParts[]): Set<string> {
    const anchors = new Set<string>()
    let pendingUserMessageId: string | null = null

    for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i]

        if (messageHasCompress(message)) {
            break
        }

        if (message.info.role === "user") {
            if (!isIgnoredUserMessage(message)) {
                pendingUserMessageId = message.info.id
            }
            continue
        }

        if (message.info.role === "assistant" && pendingUserMessageId) {
            anchors.add(message.info.id)
            anchors.add(pendingUserMessageId)
            pendingUserMessageId = null
        }
    }

    return anchors
}

export function getActiveSummaryTokenUsage(state: SessionState): number {
    let total = 0
    for (const blockId of state.prune.messages.activeBlockIds) {
        const block = state.prune.messages.blocksById.get(blockId)
        if (!block || !block.active || block.released === true) {
            continue
        }
        total += block.summaryTokens
    }
    return total
}

export function resetOnCompaction(state: SessionState): void {
    // Native compaction starts a fresh history, but aliases and block ids must keep
    // climbing: an old ref may never resolve to new content. Note state lives
    // outside this object and survives on purpose.
    const nextBlockId = state.prune.messages.nextBlockId
    const nextRunId = state.prune.messages.nextRunId
    state.toolParameters.clear()
    state.prune.tools = new Map<string, number>()
    state.prune.messages = createPruneMessagesState()
    state.prune.messages.nextBlockId = nextBlockId
    state.prune.messages.nextRunId = nextRunId
    state.messageIds = {
        byRawId: new Map<string, string>(),
        byRef: new Map<string, string>(),
        nextRef: state.messageIds.nextRef,
    }
    state.nudges = {
        contextLimitAnchors: new Set<string>(),
        turnNudgeAnchors: new Set<string>(),
        iterationNudgeAnchors: new Set<string>(),
    }
    // A prepared fold was summarized from pre-compaction history; keep neither.
    state.preparedAutoFold = null
}
