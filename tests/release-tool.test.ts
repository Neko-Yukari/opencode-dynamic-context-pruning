import assert from "node:assert/strict"
import test, { after } from "node:test"
import { mkdtempSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Logger } from "../lib/logger"
import type { SessionState, WithParts } from "../lib/state"
import type { ToolContext } from "../lib/compress/types"

const dataHome = mkdtempSync(join(tmpdir(), "dcp-release-tool-"))
process.env.XDG_DATA_HOME = dataHome
after(() => rmSync(dataHome, { recursive: true, force: true }))
const { createReleaseTool } = await import("../lib/release")
const { createCompressRangeTool, createCompressMessageTool } = await import("../lib/compress")
const { createSessionState } = await import("../lib/state")
const { saveSessionState } = await import("../lib/state/persistence")

let sessionCounter = 0

function msg(
    id: string,
    role: "user" | "assistant",
    created: number,
    text = id,
    sessionID = "ses_release_tool",
): WithParts {
    return {
        info: { id, role, sessionID, time: { created } } as WithParts["info"],
        parts: [
            {
                id: `${id}:text`,
                messageID: id,
                sessionID,
                type: "text",
                text,
            } as WithParts["parts"][number],
        ],
    }
}

function fixture(
    build: (sessionID: string) => WithParts[] = (sid) => [
        msg("m1", "user", 1, "m1", sid),
        msg("m2", "assistant", 2, "m2", sid),
        msg("m3", "user", 3, "m3", sid),
    ],
) {
    const sessionID = "ses_release_tool_" + ++sessionCounter
    const messages = build(sessionID)
    const state = createSessionState("compact")
    state.sessionId = sessionID
    const config = {
        compress: {
            permission: "allow",
            mode: "range",
            model: undefined,
            minContextLimit: 0,
            maxContextLimit: 1_000_000,
            summaryBuffer: false,
            protectedTools: [],
            protectTags: false,
            protectUserMessages: false,
        },
        manualMode: { enabled: false },
        strategies: {
            deduplication: { enabled: false, protectedTools: [] },
            purgeErrors: { enabled: false, turns: 1, protectedTools: [] },
        },
        experimental: { allowSubAgents: false },
        protectedFilePatterns: [],
    }
    const ctx = {
        client: {
            session: {
                messages: async () => ({ data: messages }),
                get: async () => ({ data: {} }),
            },
        },
        state,
        logger: new Logger(false),
        config,
        prompts: { reload() {}, getRuntimePrompts: () => ({}) },
    } as unknown as ToolContext
    const toolCtx = {
        sessionID,
        messageID: "caller",
        callID: "call_release",
        agent: "general",
        directory: dataHome,
        worktree: dataHome,
        abort: new AbortController().signal,
        ask: async () => {},
        metadata: () => {},
    }
    return { ctx, toolCtx, state }
}

const args = (startId: string, endId: string) => ({
    topic: "Finished",
    content: [{ startId, endId }],
})

function addActiveBlock(
    state: SessionState,
    blockId: number,
    anchorMessageId: string,
    messageIds: string[],
): void {
    state.prune.messages.blocksById.set(blockId, {
        blockId,
        runId: blockId,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 10,
        summaryTokens: 5,
        durationMs: 0,
        topic: "old",
        startId: messageIds[0]!,
        endId: messageIds.at(-1)!,
        anchorMessageId,
        compressMessageId: "caller",
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: [...messageIds],
        directToolIds: [],
        effectiveMessageIds: [...messageIds],
        effectiveToolIds: [],
        createdAt: 1,
        summary: "[Compressed conversation section]\nold body",
    })
    state.prune.messages.activeBlockIds.add(blockId)
    state.prune.messages.activeByAnchorMessageId.set(anchorMessageId, blockId)
    for (const messageId of messageIds) {
        const entry = state.prune.messages.byMessageId.get(messageId)
        if (entry) {
            if (!entry.allBlockIds.includes(blockId)) entry.allBlockIds.push(blockId)
            if (!entry.activeBlockIds.includes(blockId)) entry.activeBlockIds.push(blockId)
            continue
        }
        state.prune.messages.byMessageId.set(messageId, {
            tokenCount: 5,
            allBlockIds: [blockId],
            activeBlockIds: [blockId],
        })
    }
}

test("releasing a raw range hides it and records a released block", async () => {
    const f = fixture()
    const content = await createReleaseTool(f.ctx).execute(args("@1@", "@2@"), f.toolCtx as never)

    assert.match(String(content), /Released 2 messages/)
    const blocks = [...f.state.prune.messages.blocksById.values()]
    assert.equal(blocks.length, 1)
    assert.equal(blocks[0]!.released, true)
    assert.equal(blocks[0]!.summary, "")
    assert.equal(blocks[0]!.summaryTokens, 0)
    assert.deepEqual(f.state.prune.messages.byMessageId.get("m1")?.activeBlockIds, [1])
    assert.equal(f.state.prune.messages.activeByAnchorMessageId.size, 0)
})

test("releasing a whole block reports effective source messages and selected blocks", async () => {
    const f = fixture()
    f.state.prune.messages.nextBlockId = 2
    f.state.prune.messages.nextRunId = 2
    f.state.prune.messages.blocksById.set(1, {
        blockId: 1,
        runId: 1,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 10,
        summaryTokens: 5,
        durationMs: 0,
        topic: "old",
        startId: "m1",
        endId: "m2",
        anchorMessageId: "m1",
        compressMessageId: "caller",
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: ["m1", "m2"],
        directToolIds: [],
        effectiveMessageIds: ["m1", "m2"],
        effectiveToolIds: [],
        createdAt: 1,
        summary: "[Compressed conversation section]\nold body",
    })
    f.state.prune.messages.activeBlockIds.add(1)
    f.state.prune.messages.activeByAnchorMessageId.set("m1", 1)
    for (const messageId of ["m1", "m2"]) {
        f.state.prune.messages.byMessageId.set(messageId, {
            tokenCount: 5,
            allBlockIds: [1],
            activeBlockIds: [1],
        })
    }

    const content = await createReleaseTool(f.ctx).execute(args("@b1@", "@b1@"), f.toolCtx as never)

    assert.match(String(content), /Released 2 messages \(covering 1 selected old block\) into b2/)
    const oldBlock = f.state.prune.messages.blocksById.get(1)
    const releasedBlock = f.state.prune.messages.blocksById.get(2)
    assert.equal(oldBlock?.active, false)
    assert.equal(releasedBlock?.released, true)
    assert.equal(releasedBlock?.summary, "")
    assert.equal(releasedBlock?.summaryTokens, 0)
    assert.deepEqual(releasedBlock?.effectiveMessageIds.sort(), ["m1", "m2"])
    assert.equal(f.state.prune.messages.activeByAnchorMessageId.size, 0)
})

test("overlapping effective sources across whole blocks are counted once", async () => {
    const f = fixture()
    f.state.prune.messages.nextBlockId = 3
    f.state.prune.messages.nextRunId = 3
    addActiveBlock(f.state, 1, "m1", ["m1", "m2"])
    addActiveBlock(f.state, 2, "m3", ["m2", "m3"])

    const content = await createReleaseTool(f.ctx).execute(
        {
            topic: "Finished",
            content: [
                { startId: "@b1@", endId: "@b1@" },
                { startId: "@b2@", endId: "@b2@" },
            ],
        },
        f.toolCtx as never,
    )

    assert.match(
        String(content),
        /Released 3 messages \(covering 2 selected old blocks\) into b3, b4/,
    )
})

test("a hidden boundary is rejected and nothing is mutated", async () => {
    const f = fixture()
    f.state.prune.messages.blocksById.set(1, {
        blockId: 1,
        runId: 1,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 0,
        summaryTokens: 1,
        durationMs: 0,
        topic: "old",
        startId: "m1",
        endId: "m2",
        anchorMessageId: "m1",
        compressMessageId: "caller",
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: ["m1"],
        directToolIds: [],
        effectiveMessageIds: ["m1", "m2"],
        effectiveToolIds: [],
        createdAt: 1,
        summary: "old summary",
    })
    f.state.prune.messages.activeBlockIds.add(1)

    await assert.rejects(
        createReleaseTool(f.ctx).execute(args("@1@", "@2@"), f.toolCtx as never),
        /hidden inside|visible closed unit|inside/,
    )
    assert.equal(f.state.prune.messages.blocksById.size, 1)
})

test("a pending tool call blocks the release before mutation", async () => {
    const f = fixture((sid) => {
        const pending: WithParts = {
            info: {
                id: "m2",
                role: "assistant",
                sessionID: sid,
                time: { created: 2 },
            } as WithParts["info"],
            parts: [
                {
                    id: "m2:tool",
                    messageID: "m2",
                    sessionID: sid,
                    type: "tool",
                    tool: "shell",
                    callID: "call_pending",
                    state: { status: "running", input: {}, time: { start: 2 } },
                } as WithParts["parts"][number],
            ],
        }
        return [msg("m1", "user", 1, "m1", sid), pending, msg("m3", "user", 3, "m3", sid)]
    })

    await assert.rejects(
        createReleaseTool(f.ctx).execute(args("@1@", "@2@"), f.toolCtx as never),
        /completed tool calls/,
    )
    assert.equal(f.state.prune.messages.blocksById.size, 0)
})

test("releasing its own call is rejected", async () => {
    const f = fixture()
    f.toolCtx.messageID = "m2"
    await assert.rejects(
        createReleaseTool(f.ctx).execute(args("@1@", "@2@"), f.toolCtx as never),
        /own active call/,
    )
    assert.equal(f.state.prune.messages.blocksById.size, 0)
})

test("an uninitialized session has no state to persist", async () => {
    const state = createSessionState("compact")
    state.sessionId = null
    await assert.doesNotReject(saveSessionState(state, new Logger(false)))
})

test("a real failed state-file replacement never publishes release or either compression mode", async () => {
    for (const mode of ["release", "range", "message"] as const) {
        const f = fixture()
        const obstruction = join(
            dataHome,
            "opencode",
            "storage",
            "plugin",
            "dcp",
            `${f.toolCtx.sessionID}.json`,
        )
        mkdirSync(obstruction, { recursive: true })
        const before = structuredClone(f.state.prune.messages)
        const beforeStats = { ...f.state.stats }
        const tool =
            mode === "release"
                ? createReleaseTool(f.ctx)
                : mode === "range"
                  ? createCompressRangeTool(f.ctx)
                  : createCompressMessageTool(f.ctx)
        const input =
            mode === "release"
                ? args("@1@", "@2@")
                : mode === "range"
                  ? {
                        topic: "Closed",
                        content: [{ startId: "@1@", endId: "@2@", summary: "Verified result" }],
                    }
                  : {
                        topic: "Closed",
                        content: [
                            { messageId: "@2@", topic: "Result", summary: "Verified result" },
                        ],
                    }
        await assert.rejects(tool.execute(input as never, f.toolCtx as never))
        assert.deepEqual(
            f.state.prune.messages,
            before,
            `${mode} published unsaved blocks or counters`,
        )
        assert.deepEqual(f.state.stats, beforeStats, `${mode} published unsaved accounting`)
        rmSync(obstruction, { recursive: true })
    }
})
