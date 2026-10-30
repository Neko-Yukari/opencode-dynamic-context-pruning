import assert from "node:assert/strict"
import test from "node:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Plugin } from "@opencode/plugin"

/**
 * Drive the real setup hooks: a fold committed between turns reaches the next
 * request only as its summary block. Nothing is attached to the user's prompt,
 * no fold statement enters the context, sessions never see each other's blocks,
 * and repeating the request yields byte-identical messages (stable cache prefix).
 */
test("a committed fold reaches the next request only as its own summary block", async () => {
    const root = await mkdtemp(join(tmpdir(), "dcp-notice-isolation-"))
    const configHome = join(root, "config")
    const dataHome = join(root, "data")
    const directory = join(root, "project")
    await mkdir(join(directory, ".opencode"), { recursive: true })
    await writeFile(
        join(directory, ".opencode", "dcp.jsonc"),
        JSON.stringify({
            enabled: true,
            debug: true,
            experimental: { allowSubAgents: true },
            compress: {
                autoFold: {
                    enabled: true,
                    targetTokens: 1_000,
                    triggerTokens: 1_100,
                    minFoldTokens: 0,
                    keepRecentMessages: 2,
                },
                model: "test/model",
            },
        }),
    )

    const previousConfigHome = process.env.XDG_CONFIG_HOME
    const previousDataHome = process.env.XDG_DATA_HOME
    process.env.XDG_CONFIG_HOME = configHome
    process.env.XDG_DATA_HOME = dataHome
    try {
        const sessions = new Map<string, any[]>([
            ["ses_alpha", buildHistory("ses_alpha", "ALPHA")],
            ["ses_beta", buildHistory("ses_beta", "BETA")],
            ["ses_child", buildHistory("ses_child", "CHILD")],
        ])
        const markers = new Map([
            ["ses_alpha", "ALPHA"],
            ["ses_beta", "BETA"],
            ["ses_child", "CHILD"],
        ])

        const hooks = new Map<string, (event: any) => unknown>()
        const makeContext = () =>
            ({
                location: { directory },
                storage: {
                    get: async () => undefined,
                    set: async () => {},
                    remove: async () => {},
                    scan: async () => ({ entries: [] }),
                },
                rpc: { register: async () => ({ dispose: async () => {} }) },
                model: {
                    transform: async (callback: (editor: { list(): never[] }) => void) => {
                        callback({ list: () => [] })
                        return { dispose: async () => {} }
                    },
                    list: async () => ({
                        data: [
                            {
                                providerID: "test",
                                id: "model",
                                limit: { context: 200_000, output: 32_000 },
                            },
                        ],
                    }),
                },
                generate: {
                    text: async (input: { prompt: string }) => {
                        const marker =
                            [...markers].find(([, value]) => input.prompt.includes(value))?.[1] ??
                            "UNKNOWN"
                        return {
                            text: `Auto-fold (DCP plugin on OpenCode host 2.2.1)\n\n${marker} 主题：压缩这一段。`,
                        }
                    },
                },
                event: {
                    subscribe: () => ({ [Symbol.asyncIterator]: async function* () {} }),
                },
                session: {
                    hook: async (name: string, callback: (event: any) => unknown) => {
                        hooks.set(name, callback)
                        return { dispose: async () => {} }
                    },
                    get: async ({ sessionID }: { sessionID: string }) => ({
                        id: sessionID,
                        parentID: sessionID === "ses_child" ? "ses_alpha" : undefined,
                        agent: "build",
                        model: { providerID: "test", id: "model" },
                        permissions: [],
                    }),
                    context: async ({ sessionID }: { sessionID: string }) =>
                        sessions.get(sessionID) ?? [],
                },
                agent: { get: async () => ({ data: { permissions: [] } }) },
                tool: {
                    transform: async (callback: (editor: { add(): void }) => void) => {
                        callback({ add() {} })
                        return { dispose: async () => {} }
                    },
                },
                command: {
                    transform: async (callback: (editor: { add(): void }) => void) => {
                        callback({ add() {} })
                        return { dispose: async () => {} }
                    },
                },
            }) as unknown as Plugin.Context

        const { setup } = await import("../lib/v2")
        const cleanup = await setup(makeContext())
        assert.equal(typeof cleanup, "function")

        // The fold statement is no longer attached to user prompts.
        assert.equal(hooks.has("prompt"), false)

        // Prepare and commit every session between turns.
        for (const sessionID of sessions.keys())
            await hooks.get("experimental.idle")!({ sessionID, background: [] })

        const request = async (sessionID: string) => {
            const event = {
                sessionID,
                agent: "build",
                model: { providerID: "test", id: "model" },
                system: [{ type: "text", text: "host system" }],
                tools: {},
                messages: native(sessions.get(sessionID)!),
            }
            await hooks.get("context")!(event)
            return event
        }

        for (const [sessionID, marker] of markers) {
            const first = await request(sessionID)
            const text = JSON.stringify(first.messages)
            assert.match(text, /\[Compressed conversation section\]/)
            assert.match(text, /Read-only history inserted by the context manager/)
            assert.match(text, new RegExp(`${marker} 主题`))
            for (const [, other] of markers)
                if (other !== marker) assert.equal(text.includes(`${other} 主题`), false)
            assert.equal(text.includes("自动压缩"), false)
            assert.equal(text.includes("dcp-nudge"), false)
            // The newest user message is passed through as the user wrote it.
            const lastUser = first.messages.findLast((message: any) => message.role === "user")!
            assert.match(lastUser.content[0].text, new RegExp(`^${marker} user 3`))
            // Auto-fold mode replaces the long manual-compression guidance.
            const system = first.system.map((part: { text: string }) => part.text).join("\n")
            assert.match(system, /Context is managed automatically/)
            assert.equal(system.includes("COMPRESS WHEN"), false)

            const second = await request(sessionID)
            assert.deepEqual(second.messages, first.messages)
            assert.deepEqual(second.system, first.system)
        }

        if (typeof cleanup === "function") await cleanup()
    } finally {
        if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME
        else process.env.XDG_CONFIG_HOME = previousConfigHome
        if (previousDataHome === undefined) delete process.env.XDG_DATA_HOME
        else process.env.XDG_DATA_HOME = previousDataHome
        await rm(root, { recursive: true, force: true })
    }
})

function native(entries: any[]) {
    return entries.map((entry) => ({
        id: entry.id,
        role: entry.type,
        content: entry.type === "user" ? [{ type: "text", text: entry.text }] : entry.content,
    }))
}

function buildHistory(sessionID: string, marker: string): any[] {
    const filler = " detail".repeat(800)
    const entries: any[] = []
    for (const turn of [1, 2, 3]) {
        entries.push({
            type: "user",
            id: `msg-${sessionID}-user-${turn}`,
            text: `${marker} user ${turn}${filler}`,
            time: { created: turn * 2 - 1 },
            agent: "build",
            model: { providerID: "test", id: "model" },
        })
        entries.push({
            type: "assistant",
            id: `msg-${sessionID}-assistant-${turn}`,
            content: [{ type: "text", text: `${marker} assistant ${turn}${filler}` }],
            tokens: { input: 20_000, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: turn * 2 },
            agent: "build",
            model: { providerID: "test", id: "model" },
            status: "completed",
        })
    }
    return entries
}
