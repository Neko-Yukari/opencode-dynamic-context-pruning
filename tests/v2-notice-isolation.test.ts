import assert from "node:assert/strict"
import test from "node:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Plugin } from "@opencode/plugin"

/**
 * The prompt hook is shared by every session in the process. Drive the real
 * setup hooks for two interleaved sessions and prove that each state's pending
 * completion statement is attached only to its own next prompt, including after
 * a persisted reload.
 */
test("interleaved sessions attach only their own completion statement", async () => {
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

        // Prepare and commit both sessions before either prompt arrives.
        await hooks.get("experimental.idle")!({ sessionID: "ses_alpha", background: [] })
        await hooks.get("experimental.idle")!({ sessionID: "ses_beta", background: [] })
        await hooks.get("experimental.idle")!({ sessionID: "ses_child", background: [] })

        const alpha = {
            sessionID: "ses_alpha",
            messageID: "msg_alpha_next",
            prompt: { text: "继续 A" },
            delivery: "steer",
        }
        await hooks.get("prompt")!(alpha)
        const beta = {
            sessionID: "ses_beta",
            messageID: "msg_beta_next",
            prompt: { text: "继续 B" },
            delivery: "steer",
        }
        await hooks.get("prompt")!(beta)

        assert.match(alpha.prompt.text, /^自动压缩已应用：ALPHA 主题｜/)
        assert.equal(alpha.prompt.text.includes("BETA"), false)
        assert.match(beta.prompt.text, /^自动压缩已应用：BETA 主题｜/)
        assert.equal(beta.prompt.text.includes("ALPHA"), false)

        const child = {
            sessionID: "ses_child",
            messageID: "msg_child_next",
            prompt: { text: "继续 child" },
            delivery: "steer",
        }
        await hooks.get("prompt")!(child)
        assert.match(child.prompt.text, /^自动压缩已应用：CHILD 主题｜/)
        assert.equal(child.prompt.text.includes("ALPHA"), false)
        assert.equal(child.prompt.text.includes("BETA"), false)

        // Alpha's message becoming durable consumes only Alpha's statement.
        sessions.get("ses_alpha")!.push({
            type: "user",
            id: "msg_alpha_next",
            text: alpha.prompt.text,
            time: { created: 100 },
            agent: "build",
            model: { providerID: "test", id: "model" },
        })
        await hooks.get("context")!({
            sessionID: "ses_alpha",
            agent: "build",
            model: { providerID: "test", id: "model" },
            system: [],
            tools: {},
            messages: [],
        })

        if (typeof cleanup === "function") await cleanup()

        // A fresh setup (new sessions map) rehydrates the persisted state.
        const hooksAfterReload = new Map<string, (event: any) => unknown>()
        const contextAfterReload = makeContext() as any
        contextAfterReload.session.hook = async (
            name: string,
            callback: (event: any) => unknown,
        ) => {
            hooksAfterReload.set(name, callback)
            return { dispose: async () => {} }
        }
        const cleanupAfterReload = await setup(contextAfterReload)
        const alphaAfter = {
            sessionID: "ses_alpha",
            messageID: "msg_alpha_again",
            prompt: { text: "再看 A" },
            delivery: "steer",
        }
        await hooksAfterReload.get("prompt")!(alphaAfter)
        assert.equal(alphaAfter.prompt.text, "再看 A")

        const betaAfter = {
            sessionID: "ses_beta",
            messageID: "msg_beta_again",
            prompt: { text: "再看 B" },
            delivery: "steer",
        }
        await hooksAfterReload.get("prompt")!(betaAfter)
        assert.match(betaAfter.prompt.text, /^自动压缩已应用：BETA 主题｜/)
        assert.equal(betaAfter.prompt.text.includes("ALPHA"), false)

        const childAfter = {
            sessionID: "ses_child",
            messageID: "msg_child_again",
            prompt: { text: "再看 child" },
            delivery: "steer",
        }
        await hooksAfterReload.get("prompt")!(childAfter)
        assert.match(childAfter.prompt.text, /^自动压缩已应用：CHILD 主题｜/)
        assert.equal(childAfter.prompt.text.includes("ALPHA"), false)
        assert.equal(childAfter.prompt.text.includes("BETA"), false)

        if (typeof cleanupAfterReload === "function") await cleanupAfterReload()
    } finally {
        if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME
        else process.env.XDG_CONFIG_HOME = previousConfigHome
        if (previousDataHome === undefined) delete process.env.XDG_DATA_HOME
        else process.env.XDG_DATA_HOME = previousDataHome
        await rm(root, { recursive: true, force: true })
    }
})

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
