import assert from "node:assert/strict"
import test from "node:test"
import { syncCompressionBlocks } from "../lib/messages/sync"
import { buildCompressedBlockGuidance } from "../lib/prompts/extensions/nudge"
import { buildSearchContext, resolveSelection } from "../lib/compress/search"
import { parseBlockPlaceholders, stripBlockPlaceholders } from "../lib/compress/range-utils"
import { createSessionState, type CompressionBlock, type WithParts } from "../lib/state"
import { loadMessageIdState, resetOnCompaction, serializeMessageIdState } from "../lib/state/utils"
import { Logger } from "../lib/logger"

function message(id: string, created: number): WithParts {
    return {
        info: {
            id,
            role: "assistant",
            sessionID: "ses_release",
            time: { created },
        } as WithParts["info"],
        parts: [
            {
                type: "text",
                text: `body ${id}`,
                id: `${id}-p`,
                messageID: id,
                sessionID: "ses_release",
            },
        ],
    } as WithParts
}

function block(overrides: Partial<CompressionBlock> = {}): CompressionBlock {
    return {
        blockId: 1,
        runId: 1,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 10,
        summaryTokens: 5,
        durationMs: 0,
        topic: "done",
        startId: "m1",
        endId: "m1",
        anchorMessageId: "m1",
        compressMessageId: "m0",
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: ["m1"],
        directToolIds: [],
        effectiveMessageIds: ["m1"],
        effectiveToolIds: [],
        createdAt: 1,
        summary: "[Compressed conversation section]\nold body",
        ...overrides,
    }
}

test("released blocks keep suppressing sources without a summary or nudge entry", () => {
    const state = createSessionState("compact")
    state.prune.messages.blocksById.set(1, block({ released: true }))
    state.prune.messages.activeBlockIds.add(1)
    state.prune.messages.byMessageId.set("m1", {
        tokenCount: 5,
        allBlockIds: [1],
        activeBlockIds: [1],
    })

    const messages = [message("m0", 1), message("m1", 2)]
    syncCompressionBlocks(state, new Logger(false), messages)

    assert.equal(state.prune.messages.activeBlockIds.has(1), true)
    assert.equal(state.prune.messages.activeByAnchorMessageId.has("m1"), false)
    assert.deepEqual(state.prune.messages.byMessageId.get("m1")?.activeBlockIds, [1])
    assert.doesNotMatch(
        buildCompressedBlockGuidance(state),
        /Active compressed blocks in this session: 1/,
    )
})

test("search context hides released sources and their summaries from selection", () => {
    const state = createSessionState("compact")
    state.prune.messages.blocksById.set(1, block({ released: true }))
    state.prune.messages.activeBlockIds.add(1)
    const messages = [message("m0", 1), message("m1", 2), message("m2", 3)]
    const context = buildSearchContext(state, messages)

    assert.equal(context.summaryByBlockId.size, 0)
    assert.equal(context.blockedMessageIdToBlockId?.get("m1"), 1)

    const selection = resolveSelection(
        context,
        {
            kind: "message",
            rawIndex: 0,
            messageId: "m0",
        },
        {
            kind: "message",
            rawIndex: 2,
            messageId: "m2",
        },
    )
    // The released hole is omitted, never resurrected as a raw message.
    assert.deepEqual(selection.messageIds, ["m0", "m2"])
    assert.deepEqual(selection.requiredBlockIds, [])
})

test("resummary strips block placeholders instead of expanding old bodies", () => {
    const compact = "Start @b1@ end"
    assert.equal(
        stripBlockPlaceholders(compact, parseBlockPlaceholders(compact, "compact")),
        "Start  end",
    )
    const xml = "Start (b2) end"
    assert.equal(stripBlockPlaceholders(xml, parseBlockPlaceholders(xml, "xml")), "Start  end")
})

test("compaction clears history but keeps id high-water marks", () => {
    const state = createSessionState("compact")
    state.prune.messages.nextBlockId = 7
    state.prune.messages.nextRunId = 5
    state.messageIds.nextRef = 12
    state.prune.messages.blocksById.set(1, block())

    resetOnCompaction(state)

    assert.equal(state.prune.messages.blocksById.size, 0)
    assert.equal(state.prune.messages.nextBlockId, 7)
    assert.equal(state.prune.messages.nextRunId, 5)
    assert.equal(state.messageIds.nextRef, 12)
    assert.equal(state.messageIds.byRawId.size, 0)
})

test("persisted aliases restore without renumbering and old files load", () => {
    const state = createSessionState("compact")
    state.messageIds.byRawId.set("raw-1", "@1@")
    state.messageIds.byRef.set("@1@", "raw-1")
    state.messageIds.nextRef = 2
    const saved = serializeMessageIdState(state)

    const restored = createSessionState("compact")
    restored.messageIds.nextRef = 5
    loadMessageIdState(restored, saved)
    assert.equal(restored.messageIds.byRawId.get("raw-1"), "@1@")
    assert.equal(restored.messageIds.nextRef, 5)

    const legacy = createSessionState("compact")
    loadMessageIdState(legacy, undefined)
    assert.equal(legacy.messageIds.byRef.size, 0)
})
