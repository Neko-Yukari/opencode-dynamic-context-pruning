import assert from "node:assert/strict"
import test from "node:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Plugin } from "@opencode/plugin"

/**
 * Setup must survive a host that rejects the 2.2.1-only hook kind. The rejection
 * is injected at `session.hook`, the only place setup can observe it.
 */
test("setup warns instead of failing when the host rejects experimental.idle", async () => {
    const root = await mkdtemp(join(tmpdir(), "dcp-idle-hook-"))
    const configHome = join(root, "config")
    const directory = join(root, "project")
    await mkdir(join(directory, ".opencode"), { recursive: true })
    await writeFile(
        join(directory, ".opencode", "dcp.jsonc"),
        JSON.stringify({
            enabled: true,
            debug: true,
            compress: {
                autoFold: {
                    enabled: true,
                    targetTokens: 100_000,
                    minFoldTokens: 0,
                    keepRecentMessages: 3,
                },
            },
        }),
    )

    const previousConfigHome = process.env.XDG_CONFIG_HOME
    process.env.XDG_CONFIG_HOME = configHome
    try {
        // Import after the environment is set: lib/config captures the global
        // config directory when the module loads.
        const { setup } = await import("../lib/v2")

        const hooks: string[] = []
        const ctx = {
            location: { directory },
            storage: {
                get: async () => undefined,
                set: async () => {},
                remove: async () => {},
                scan: async () => ({ entries: [] }),
            },
            rpc: {
                register: async () => ({ dispose: async () => {} }),
            },
            model: {
                transform: async (callback: (editor: { list(): never[] }) => void) => {
                    callback({ list: () => [] })
                    return { dispose: async () => {} }
                },
            },
            event: {
                subscribe: () => ({ [Symbol.asyncIterator]: async function* () {} }),
            },
            session: {
                hook: async (name: string) => {
                    hooks.push(name)
                    if (name === "experimental.idle") throw new Error("unknown session hook kind")
                    return { dispose: async () => {} }
                },
            },
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
        } as unknown as Plugin.Context

        const cleanup = await setup(ctx)

        assert.equal(typeof cleanup, "function")
        // The prompt hook is registered first; the rejected idle hook is attempted
        // next, and the event-path hooks remain.
        assert.deepEqual(hooks, ["prompt", "experimental.idle", "context", "compaction"])
        const logFile = join(
            configHome,
            "opencode",
            "logs",
            "dcp",
            "daily",
            `${new Date().toISOString().split("T")[0]}.log`,
        )
        const log = await readFile(logFile, "utf8")
        assert.match(log, /WARN .*DCP experimental\.idle hook not registered/)
        if (typeof cleanup === "function") await cleanup()
    } finally {
        if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME
        else process.env.XDG_CONFIG_HOME = previousConfigHome
        await rm(root, { recursive: true, force: true })
    }
})
