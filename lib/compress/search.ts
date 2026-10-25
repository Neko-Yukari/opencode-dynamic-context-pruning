import type { SessionState, WithParts, CompressionBlock } from "../state"
import { formatBlockRef, parseBlockRef, parseBoundaryId } from "../message-ids"
import { isIgnoredUserMessage } from "../messages/query"
import { filterMessages } from "../messages/shape"
import { countAllMessageTokens } from "../token-utils"
import type { BoundaryReference, SearchContext, SelectionResolution } from "./types"

export async function fetchSessionMessages(client: any, sessionId: string): Promise<WithParts[]> {
    const response = await client.session.messages({
        path: { id: sessionId },
    })

    return filterMessages(response?.data || response)
}

export function buildSearchContext(state: SessionState, rawMessages: WithParts[]): SearchContext {
    const rawMessagesById = new Map<string, WithParts>()
    const rawIndexById = new Map<string, number>()
    for (const msg of rawMessages) {
        rawMessagesById.set(msg.info.id, msg)
    }
    for (let index = 0; index < rawMessages.length; index++) {
        const message = rawMessages[index]
        if (!message) {
            continue
        }
        rawIndexById.set(message.info.id, index)
    }

    const summaryByBlockId = new Map<number, CompressionBlock>()
    const blockedMessageIdToBlockId = new Map<string, number>()
    const releasedMessageIds = new Set<string>()
    for (const [blockId, block] of state.prune.messages.blocksById) {
        if (!block.active) {
            continue
        }
        // Any active owner hides its covered sources. Released owners keep hiding
        // them but expose neither a summary nor a selectable boundary.
        for (const messageId of block.effectiveMessageIds) {
            blockedMessageIdToBlockId.set(messageId, blockId)
            if (block.released === true) {
                releasedMessageIds.add(messageId)
            }
        }
        if (block.released === true) {
            continue
        }
        summaryByBlockId.set(blockId, block)
    }

    return {
        rawMessages,
        rawMessagesById,
        rawIndexById,
        summaryByBlockId,
        blockedMessageIdToBlockId,
        releasedMessageIds,
    }
}

export function resolveBoundaryIds(
    context: SearchContext,
    state: SessionState,
    startId: string,
    endId: string,
): { startReference: BoundaryReference; endReference: BoundaryReference } {
    const lookup = buildBoundaryLookup(context, state)
    const issues: string[] = []
    const parsedStartId = parseBoundaryId(startId, state.idFormat)
    const parsedEndId = parseBoundaryId(endId, state.idFormat)
    const messageExample = state.idFormat === "compact" ? "@4@" : "mNNNN"
    const blockExample = state.idFormat === "compact" ? "@b1@" : "bN"

    if (parsedStartId === null) {
        issues.push(
            `startId is invalid. Use an injected message ID (${messageExample}) or block ID (${blockExample}).`,
        )
    }

    if (parsedEndId === null) {
        issues.push(
            `endId is invalid. Use an injected message ID (${messageExample}) or block ID (${blockExample}).`,
        )
    }

    if (issues.length > 0) {
        throw new Error(
            issues.length === 1 ? issues[0] : issues.map((issue) => `- ${issue}`).join("\n"),
        )
    }

    // Every issue-free boundary parses to a reference; the lookup may still not
    // resolve it when the unit is hidden inside an active block.
    const startReference = lookup.get(parsedStartId!.ref)
    const endReference = lookup.get(parsedEndId!.ref)

    if (!startReference) {
        issues.push(`startId ${hiddenReferenceHint(context, state, parsedStartId!.ref)}`)
    }

    if (!endReference) {
        issues.push(`endId ${hiddenReferenceHint(context, state, parsedEndId!.ref)}`)
    }

    if (issues.length > 0) {
        throw new Error(
            issues.length === 1 ? issues[0] : issues.map((issue) => `- ${issue}`).join("\n"),
        )
    }

    if (startReference!.rawIndex > endReference!.rawIndex) {
        throw new Error(
            `startId ${parsedStartId!.ref} appears after endId ${parsedEndId!.ref} in the conversation. Start must come before end.`,
        )
    }

    return { startReference: startReference!, endReference: endReference! }
}

export function resolveSelection(
    context: SearchContext,
    startReference: BoundaryReference,
    endReference: BoundaryReference,
): SelectionResolution {
    const startRawIndex = startReference.rawIndex
    const endRawIndex = endReference.rawIndex
    const messageIds: string[] = []
    const messageSeen = new Set<string>()
    const toolIds: string[] = []
    const toolSeen = new Set<string>()
    const requiredBlockIds: number[] = []
    const requiredBlockSeen = new Set<number>()
    const messageTokenById = new Map<string, number>()

    for (let index = startRawIndex; index <= endRawIndex; index++) {
        const rawMessage = context.rawMessages[index]
        if (!rawMessage) {
            continue
        }
        if (isIgnoredUserMessage(rawMessage)) {
            continue
        }

        const messageId = rawMessage.info.id
        // Only visible units are selectable. Sources already owned by an active
        // block (including a released one) are holes: their membership travels
        // through the block, never as a resurrected raw message.
        if (context.blockedMessageIdToBlockId?.has(messageId)) {
            continue
        }
        if (!messageSeen.has(messageId)) {
            messageSeen.add(messageId)
            messageIds.push(messageId)
        }

        if (!messageTokenById.has(messageId)) {
            messageTokenById.set(messageId, countAllMessageTokens(rawMessage))
        }

        const parts = rawMessage.parts
        for (const part of parts) {
            if (part.type !== "tool" || !part.callID) {
                continue
            }
            if (toolSeen.has(part.callID)) {
                continue
            }
            toolSeen.add(part.callID)
            toolIds.push(part.callID)
        }
    }

    const summariesInSelection: Array<{ blockId: number; rawIndex: number }> = []
    for (const summary of context.summaryByBlockId.values()) {
        const anchorIndex = context.rawIndexById.get(summary.anchorMessageId)
        if (anchorIndex === undefined) {
            continue
        }
        // A visible block participates when its anchor falls inside the range,
        // whether the caller used the block ref or a message around it.
        if (anchorIndex < startRawIndex || anchorIndex > endRawIndex) {
            continue
        }
        summariesInSelection.push({
            blockId: summary.blockId,
            rawIndex: anchorIndex,
        })
    }

    summariesInSelection.sort((a, b) => a.rawIndex - b.rawIndex || a.blockId - b.blockId)
    for (const summary of summariesInSelection) {
        if (requiredBlockSeen.has(summary.blockId)) {
            continue
        }
        requiredBlockSeen.add(summary.blockId)
        requiredBlockIds.push(summary.blockId)
    }

    if (messageIds.length === 0 && requiredBlockIds.length === 0) {
        throw new Error(
            "Failed to map boundary matches back to raw messages. Choose boundaries that include original conversation messages.",
        )
    }

    return {
        startReference,
        endReference,
        messageIds,
        messageTokenById,
        toolIds,
        requiredBlockIds,
    }
}

export function resolveAnchorMessageId(startReference: BoundaryReference): string {
    return startReference.kind === "compressed-block"
        ? startReference.anchorMessageId!
        : startReference.messageId!
}

function hiddenReferenceHint(context: SearchContext, state: SessionState, ref: string): string {
    const rawId = state.messageIds.byRef.get(ref)
    if (rawId !== undefined) {
        const owner = context.blockedMessageIdToBlockId?.get(rawId)
        if (owner !== undefined) {
            const ownerRef = formatBlockRef(owner, state.idFormat)
            return context.releasedMessageIds?.has(rawId)
                ? `is released inside ${ownerRef}; released history is readback-only.`
                : `is hidden inside ${ownerRef}; select ${ownerRef} instead.`
        }
    }

    const blockId = parseBlockRef(ref, state.idFormat)
    if (blockId !== null) {
        const block = state.prune.messages.blocksById.get(blockId)
        if (block?.released === true) {
            return "was released; released history is readback-only."
        }
        const parent = block && !block.active ? block.parentBlockIds.at(-1) : undefined
        if (parent !== undefined) {
            return `is inside ${formatBlockRef(parent, state.idFormat)}; select that block instead.`
        }
    }

    return "is not available in the current conversation context. Choose a visible closed unit."
}

function buildBoundaryLookup(
    context: SearchContext,
    state: SessionState,
): Map<string, BoundaryReference> {
    const lookup = new Map<string, BoundaryReference>()

    for (const [messageRef, messageId] of state.messageIds.byRef) {
        const rawMessage = context.rawMessagesById.get(messageId)
        if (!rawMessage) {
            continue
        }
        if (isIgnoredUserMessage(rawMessage)) {
            continue
        }
        // A message already owned by an active block is not a visible unit.
        if (context.blockedMessageIdToBlockId?.has(messageId)) {
            continue
        }

        const rawIndex = context.rawIndexById.get(messageId)
        if (rawIndex === undefined) {
            continue
        }
        lookup.set(messageRef, {
            kind: "message",
            rawIndex,
            messageId,
        })
    }

    const summaries = Array.from(context.summaryByBlockId.values()).sort(
        (a, b) => a.blockId - b.blockId,
    )
    for (const summary of summaries) {
        const anchorMessage = context.rawMessagesById.get(summary.anchorMessageId)
        if (!anchorMessage) {
            continue
        }
        if (isIgnoredUserMessage(anchorMessage)) {
            continue
        }

        const rawIndex = context.rawIndexById.get(summary.anchorMessageId)
        if (rawIndex === undefined) {
            continue
        }
        const blockRef = formatBlockRef(summary.blockId, state.idFormat)
        lookup.set(blockRef, {
            kind: "compressed-block",
            rawIndex,
            blockId: summary.blockId,
            anchorMessageId: summary.anchorMessageId,
        })
    }

    return lookup
}
