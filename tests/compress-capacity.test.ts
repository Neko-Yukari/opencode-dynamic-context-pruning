import assert from "node:assert/strict"
import test, { after } from "node:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Logger } from "../lib/logger"
import type { ToolContext } from "../lib/compress/types"
import type { WithParts } from "../lib/state"
import { countAllMessageTokens } from "../lib/token-utils"
import { formatMessageRef } from "../lib/message-ids"

const dataHome = mkdtempSync(join(tmpdir(), "dcp-capacity-"))
process.env.XDG_DATA_HOME = dataHome
after(() => rmSync(dataHome, { recursive: true, force: true }))
const { createCompressRangeTool, createCompressMessageTool } = await import("../lib/compress")
const { createSessionState } = await import("../lib/state")
let serial = 0

function fixture(mode: "range" | "message", selected = "old evidence ".repeat(600)) {
    const sessionID = `ses_capacity_${++serial}`
    const messages = [
        ["m1", "user", selected],
        ["m2", "assistant", "Closed investigation."],
        ["m3", "user", "Continue the current task."],
        ["caller", "assistant", "Compress the closed evidence."],
    ].map(([id, role, text], index) => ({
        info: {
            id,
            role,
            sessionID,
            model: { providerID: "fixture", modelID: "parent" },
            time: { created: index + 1 },
        },
        parts: [{ type: "text", id: `${id}:text`, messageID: id, sessionID, text }],
    })) as WithParts[]
    const reported = messages.reduce((total, message) => total + countAllMessageTokens(message), 0)
    Object.assign(messages.at(-1)!.info, {
        tokens: { input: reported + 39, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    })
    const state = createSessionState("compact")
    state.sessionId = sessionID
    state.modelContextLimit = 1_000
    state.modelOutputLimit = 100
    state.systemPromptTokens = 40
    const ctx = {
        state,
        logger: new Logger(false),
        client: {
            session: {
                messages: async () => ({ data: messages }),
                get: async () => ({ data: {} }),
            },
        },
        config: {
            compress: {
                mode,
                permission: "allow",
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
            pruneNotification: "off",
        },
        prompts: {
            reload() {},
            getRuntimePrompts: () => ({ compressRange: "", compressMessage: "" }),
        },
    } as unknown as ToolContext
    const tool = mode === "range" ? createCompressRangeTool(ctx) : createCompressMessageTool(ctx)
    const run = (summary: string) =>
        tool.execute(
            {
                topic: "Closed evidence",
                content:
                    mode === "range"
                        ? [
                              {
                                  startId: formatMessageRef(1, "compact"),
                                  endId: formatMessageRef(1, "compact"),
                                  summary,
                              },
                          ]
                        : [
                              {
                                  messageId: formatMessageRef(1, "compact"),
                                  topic: "Closed evidence",
                                  summary,
                              },
                          ],
            } as never,
            {
                sessionID,
                messageID: "caller",
                abort: new AbortController().signal,
                ask: async () => {},
                metadata() {},
            } as never,
        )
    const path = join(dataHome, "opencode", "storage", "plugin", "dcp", `${sessionID}.json`)
    return { ctx, state, messages, run, path }
}

test("range and message compression check the resulting context before saving", async () => {
    for (const mode of ["range", "message"] as const) {
        const f = fixture(mode)
        const original = structuredClone(f.messages)
        const before = structuredClone(f.state.prune.messages)
        const stats = { ...f.state.stats }
        await assert.rejects(
            f.run("expanded summary ".repeat(1_000)),
            /compressed context.*window/i,
        )
        assert.deepEqual(f.state.prune.messages, before)
        assert.deepEqual(f.state.stats, stats)
        assert.deepEqual(f.messages, original)
        assert.equal(existsSync(f.path), false)
    }
})

test("a short replacement can bring an oversized original context back inside its window", async () => {
    for (const mode of ["range", "message"] as const) {
        const f = fixture(mode)
        await f.run("Verified closed evidence.")
        assert.equal(f.state.prune.messages.blocksById.size, 1)
        assert.equal(existsSync(f.path), true)
    }
})

test("capacity includes protected content appended to the final stored summary", async () => {
    for (const mode of ["range", "message"] as const) {
        const f = fixture(mode, `<protect>${"protected evidence ".repeat(600)}</protect>`)
        f.ctx.config.compress.protectTags = true
        await assert.rejects(f.run("Brief result."), /compressed context.*window/i)
        assert.equal(f.state.prune.messages.blocksById.size, 0)
        assert.equal(existsSync(f.path), false)
    }
})

test("a small summary is rejected when retained history still fills the window", async () => {
    for (const mode of ["range", "message"] as const) {
        const f = fixture(mode)
        const part = f.messages[2]!.parts[0]!
        if (part.type === "text") part.text = "retained evidence ".repeat(600)
        await assert.rejects(f.run("Brief result."), /compressed context.*window/i)
        assert.equal(f.state.prune.messages.blocksById.size, 0)
        assert.equal(existsSync(f.path), false)
    }
})
