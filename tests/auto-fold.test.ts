import assert from "node:assert/strict"
import test from "node:test"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { mkdirSync } from "node:fs"
import {
    createSessionState,
    ensureSessionInitialized,
    loadSessionState,
    type WithParts,
} from "../lib/state"
import type { PluginConfig } from "../lib/config"
import type { Logger } from "../lib/logger"
import {
    AUTO_FOLD_NOTICE_PREFIX,
    AUTO_FOLD_START_NOTICE,
    prepareAutoFold,
    projectAutoFold,
    type AutoFoldNotice,
} from "../lib/compress/autofold"
import { wrapCompressedSummary, COMPRESSED_BLOCK_HEADER } from "../lib/compress/state"
import { getInvalidConfigKeys, validateConfigTypes } from "../lib/config"

const testDataHome = join(tmpdir(), `opencode-dcp-autofold-data-${process.pid}`)
const testConfigHome = join(tmpdir(), `opencode-dcp-autofold-config-${process.pid}`)

process.env.XDG_DATA_HOME = testDataHome
process.env.XDG_CONFIG_HOME = testConfigHome

mkdirSync(testDataHome, { recursive: true })
mkdirSync(testConfigHome, { recursive: true })

function buildConfig(overrides: Partial<PluginConfig["compress"]["autoFold"]> = {}): PluginConfig {
    return {
        enabled: true,
        debug: false,
        pruneNotification: "off",
        pruneNotificationType: "chat",
        commands: {
            enabled: true,
            protectedTools: [],
        },
        manualMode: {
            enabled: false,
            automaticStrategies: true,
        },
        turnProtection: {
            enabled: false,
            turns: 4,
        },
        experimental: {
            allowSubAgents: true,
            customPrompts: false,
        },
        protectedFilePatterns: [],
        compress: {
            mode: "range",
            permission: "allow",
            showCompression: false,
            summaryBuffer: true,
            autoFold: {
                enabled: true,
                targetTokens: 1000,
                minGrowthTokens: 100,
                minFoldTokens: 0,
                keepRecentMessages: 2,
                ...overrides,
            },
            maxContextLimit: 150000,
            minContextLimit: 50000,
            nudgeFrequency: 5,
            iterationNudgeThreshold: 15,
            nudgeForce: "soft",
            protectedTools: [],
            protectTags: false,
            protectUserMessages: false,
        },
        strategies: {
            deduplication: {
                enabled: true,
                protectedTools: [],
            },
            purgeErrors: {
                enabled: true,
                turns: 4,
                protectedTools: [],
            },
        },
    }
}

interface Turn {
    user: string
    assistant: string
}

function buildHistory(sessionID: string, turns: Turn[], reportedInput: number): WithParts[] {
    const messages: WithParts[] = []
    // Real history carries real weight; a few hundred tokens per message keeps the
    // fold a genuine reduction instead of a token-neutral reshuffle.
    const filler = " detail".repeat(800)
    let created = 0
    for (const turn of turns) {
        created++
        const userID = `msg-user-${created}`
        messages.push({
            info: {
                id: userID,
                role: "user",
                sessionID,
                agent: "assistant",
                model: { providerID: "test", modelID: "model" },
                time: { created },
            } as WithParts["info"],
            parts: [
                {
                    id: `${userID}-p`,
                    messageID: userID,
                    sessionID,
                    type: "text",
                    text: `${turn.user}${filler}`,
                },
            ],
        })
        created++
        const assistantID = `msg-assistant-${created}`
        messages.push({
            info: {
                id: assistantID,
                role: "assistant",
                sessionID,
                agent: "assistant",
                time: { created },
            } as WithParts["info"],
            parts: [
                {
                    id: `${assistantID}-p`,
                    messageID: assistantID,
                    sessionID,
                    type: "text",
                    text: `${turn.assistant}${filler}`,
                },
            ],
        })
    }

    // The request being forwarded is the newest user message.
    created++
    const pendingID = `msg-user-${created}`
    messages.push({
        info: {
            id: pendingID,
            role: "user",
            sessionID,
            agent: "assistant",
            model: { providerID: "test", modelID: "model" },
            time: { created },
        } as WithParts["info"],
        parts: [
            {
                id: `${pendingID}-p`,
                messageID: pendingID,
                sessionID,
                type: "text",
                text: `Active in-flight request${filler}`,
            },
        ],
    })

    // analyzeContextTokens reads the reported usage of the newest assistant reply.
    const lastAssistant = [...messages].reverse().find((msg) => msg.info.role === "assistant")!
    ;(lastAssistant.info as unknown as { tokens: unknown }).tokens = {
        input: reportedInput,
        output: 10,
        reasoning: 0,
        cache: { read: 0, write: 0 },
    }
    return messages
}

function fourTurns(): Turn[] {
    return [
        { user: "First request about the release pipeline", assistant: "Investigated step one" },
        { user: "Second request about tests", assistant: "Checked the test harness" },
        { user: "Third request about docs", assistant: "Drafted the README section" },
    ]
}

function buildLogger(logs: string[]): Logger {
    const record = (level: string) => (message: string, data?: unknown) => {
        const extra = data === undefined ? "" : " " + JSON.stringify(data)
        logs.push(level + " " + message + extra)
        return Promise.resolve()
    }
    return {
        enabled: false,
        info: record("info"),
        warn: record("warn"),
        debug: record("debug"),
        error: record("error"),
        saveContext: async () => {},
    } as unknown as Logger
}

interface ContextExtras {
    summarizer?: unknown
    notify?: (notice: AutoFoldNotice) => Promise<unknown>
    logs?: string[]
    state?: ReturnType<typeof createSessionState>
}

function buildContext(
    sessionID: string,
    rawMessages: WithParts[],
    config: PluginConfig,
    extra: ContextExtras = {},
) {
    const state = extra.state ?? createSessionState()
    state.sessionId = sessionID
    return {
        client: {
            session: {
                messages: async () => ({ data: rawMessages }),
                get: async () => ({ data: {} }),
                prompt: async () => ({}),
            },
            tui: {
                showToast: async () => {},
            },
        },
        state,
        logger: buildLogger(extra.logs ?? []),
        config,
        prompts: {
            reload() {},
            getRuntimePrompts() {
                return { compressRange: "", compressMessage: "", system: "" }
            },
        },
        ...(extra.summarizer ? { summarizer: extra.summarizer } : {}),
    } as any
}

function buildNotices() {
    const notices: AutoFoldNotice[] = []
    return {
        notices,
        notify: async (notice: AutoFoldNotice) => {
            notices.push(notice)
        },
        start: () => notices.filter((notice) => notice.text === AUTO_FOLD_START_NOTICE),
        end: () => notices.filter((notice) => notice.text.startsWith(AUTO_FOLD_NOTICE_PREFIX)),
    }
}

function buildSummarizer(counter: { calls: number }, text = "Folded findings retained.") {
    return {
        models: async () => [
            { providerID: "test", id: "model", limit: { context: 200_000, output: 32_000 } },
        ],
        generate: async () => {
            counter.calls++
            return { text }
        },
    }
}

test("autoFold config keys and values are validated", () => {
    assert.deepEqual(
        getInvalidConfigKeys({
            compress: {
                autoFold: {
                    enabled: true,
                    targetTokens: 100000,
                    minGrowthTokens: 4096,
                    keepRecentMessages: 3,
                },
            },
        }),
        [],
    )

    const valid = validateConfigTypes({
        compress: {
            autoFold: {
                enabled: true,
                targetTokens: 100000,
                minGrowthTokens: 4096,
                keepRecentMessages: 3,
            },
        },
    })
    assert.deepEqual(valid, [])

    const keys = (config: Record<string, unknown>) =>
        validateConfigTypes(config).map((error) => error.key)

    assert.ok(keys({ compress: { autoFold: true } }).includes("compress.autoFold"))
    assert.ok(
        keys({ compress: { autoFold: { enabled: "yes" } } }).includes("compress.autoFold.enabled"),
    )
    assert.ok(
        keys({ compress: { autoFold: { enabled: true } } }).includes(
            "compress.autoFold.targetTokens",
        ),
    )
    assert.ok(
        keys({ compress: { autoFold: { enabled: true, targetTokens: 0 } } }).includes(
            "compress.autoFold.targetTokens",
        ),
    )
    assert.ok(
        keys({
            compress: { autoFold: { enabled: true, targetTokens: 1, minGrowthTokens: -1 } },
        }).includes("compress.autoFold.minGrowthTokens"),
    )
    assert.ok(
        keys({
            compress: { autoFold: { enabled: true, targetTokens: 1, keepRecentMessages: 1.5 } },
        }).includes("compress.autoFold.keepRecentMessages"),
    )
})

test("auto-fold is disabled by default and never prepares a fold", async () => {
    const sessionID = `ses_autofold_disabled_${Date.now()}`
    const rawMessages = buildHistory(sessionID, fourTurns(), 5000)
    const config = buildConfig()
    delete (config.compress as { autoFold?: unknown }).autoFold
    const notices = buildNotices()
    const ctx = buildContext(sessionID, rawMessages, config)

    const prepared = await prepareAutoFold({
        ctx,
        sessionID,
        messages: rawMessages,
        notify: notices.notify,
    })

    assert.equal(prepared.prepared, false)
    assert.equal(prepared.reason, "disabled")
    assert.equal(ctx.state.preparedAutoFold, null)
    assert.equal(notices.notices.length, 0)
})

test("auto-fold stays idle while the context is below target plus growth", async () => {
    const sessionID = `ses_autofold_below_${Date.now()}`
    const rawMessages = buildHistory(sessionID, fourTurns(), 5000)
    const notices = buildNotices()
    const ctx = buildContext(
        sessionID,
        rawMessages,
        buildConfig({ targetTokens: 100_000, minGrowthTokens: 4096 }),
    )

    const prepared = await prepareAutoFold({
        ctx,
        sessionID,
        messages: rawMessages,
        notify: notices.notify,
    })

    assert.equal(prepared.prepared, false)
    assert.equal(prepared.reason, "below-target")
    assert.equal(prepared.contextTokens, 5010)
    assert.equal(ctx.state.preparedAutoFold, null)
    // A request that is merely over budget never announces a fold.
    assert.equal(notices.notices.length, 0)
})

test("skips a fold that cannot reclaim the minimum reduction", async () => {
    const sessionID = `ses_autofold_floor_${Date.now()}`
    const rawMessages = buildHistory(sessionID, fourTurns(), 5000)
    const notices = buildNotices()
    const counter = { calls: 0 }
    const ctx = buildContext(sessionID, rawMessages, buildConfig({ minFoldTokens: 100_000 }), {
        summarizer: buildSummarizer(counter),
    })

    const prepared = await prepareAutoFold({
        ctx,
        sessionID,
        messages: rawMessages,
        notify: notices.notify,
    })

    assert.equal(prepared.prepared, false)
    assert.equal(prepared.reason, "below-floor")
    assert.equal(ctx.state.preparedAutoFold, null)
    // A fold that would barely dent the context must not spend a summarizer call.
    assert.equal(counter.calls, 0)
    assert.equal(notices.notices.length, 0)
})

test("prepare authors the fold artifact without touching the request path", async () => {    const sessionID = `ses_autofold_prepare_${Date.now()}`
    const rawMessages = buildHistory(sessionID, fourTurns(), 5000)
    const config = buildConfig()
    config.compress.model = "test/model"
    const counter = { calls: 0 }
    const notices = buildNotices()
    const ctx = buildContext(sessionID, rawMessages, config, {
        summarizer: buildSummarizer(counter),
    })

    const prepared = await prepareAutoFold({
        ctx,
        sessionID,
        messages: rawMessages,
        notify: notices.notify,
    })

    assert.equal(prepared.prepared, true)
    assert.equal(counter.calls, 1)
    const artifact = ctx.state.preparedAutoFold!
    assert.equal(artifact.version, 1)
    assert.equal(artifact.sessionID, sessionID)
    assert.equal(artifact.topic, "Auto-fold: 5k -> 1k")
    assert.equal(artifact.anchorUserId, "msg-user-7")
    assert.equal(artifact.ranges.length, 1)
    assert.equal(artifact.ranges[0]!.startId, "m0001")
    assert.equal(artifact.ranges[0]!.endId, "m0005")
    assert.deepEqual(artifact.ranges[0]!.messageIds, [
        "msg-user-1",
        "msg-assistant-2",
        "msg-user-3",
        "msg-assistant-4",
        "msg-user-5",
    ])
    assert.match(artifact.ranges[0]!.body, /Folded findings retained\./)
    // Preparing must not create blocks or claim any message.
    assert.equal(ctx.state.prune.messages.blocksById.size, 0)
    assert.equal(ctx.state.prune.messages.nextBlockId, 1)
    assert.equal(ctx.state.prune.messages.byMessageId.size, 0)
    // The artifact survives a restart because it is persisted with the session.
    const persisted = await loadSessionState(sessionID, ctx.logger)
    assert.equal(persisted?.autoFold?.topic, "Auto-fold: 5k -> 1k")
    assert.equal(persisted?.autoFold?.ranges.length, 1)
    // One start notice, and no end notice before the fold is committed.
    assert.equal(notices.start().length, 1)
    assert.equal(notices.start()[0]!.text, AUTO_FOLD_START_NOTICE)
    assert.equal(notices.end().length, 0)
})

test("the hook projects a prepared artifact with zero summarizer calls", async () => {
    const sessionID = `ses_autofold_project_${Date.now()}`
    const rawMessages = buildHistory(sessionID, fourTurns(), 5000)
    const config = buildConfig()
    config.compress.model = "test/model"
    const counter = { calls: 0 }
    const notices = buildNotices()
    const ctx = buildContext(sessionID, rawMessages, config, {
        summarizer: buildSummarizer(counter),
    })

    await prepareAutoFold({ ctx, sessionID, messages: rawMessages, notify: notices.notify })
    const prepareCalls = counter.calls
    const folded = await projectAutoFold({
        ctx,
        sessionID,
        messages: rawMessages,
        notify: notices.notify,
    })

    assert.equal(folded.folded, true)
    assert.deepEqual(folded.blockIds, [1])
    // Substituting a prepared fold cannot call the summarizer again.
    assert.equal(counter.calls, prepareCalls)
    const block = ctx.state.prune.messages.blocksById.get(1)!
    assert.equal(block.active, true)
    assert.equal(block.mode, "range")
    assert.equal(block.anchorMessageId, "msg-user-1")
    assert.equal(block.startId, "m0001")
    assert.equal(block.endId, "m0005")
    assert.equal(block.compressMessageId, "msg-user-7")
    const summary = block.summary.split("\n")
    assert.equal(summary[0], COMPRESSED_BLOCK_HEADER)
    assert.equal(summary[1], "Title: Auto-fold: 5k -> 1k")
    assert.match(block.summary, /Folded findings retained\./)
    assert.match(block.summary, /Originals: dcp_read\(\{"startId":"b1"\}\)/)
    // The artifact is consumed exactly once.
    assert.equal(ctx.state.preparedAutoFold, null)
    assert.equal(notices.end().length, 1)
    const notice = notices.end()[0]!
    assert.ok(notice.text.startsWith(AUTO_FOLD_NOTICE_PREFIX))
    const detail = notice.text.slice(AUTO_FOLD_NOTICE_PREFIX.length)
    // The end notice reports what the fold did, not the text of a folded message.
    assert.match(detail, /^\d+(\.\d+)?[kM]? → \d+(\.\d+)?[kM]?，折叠 5 条消息（1 段）$/)
})

test("the hook skips and logs when no prepared artifact exists", async () => {
    const sessionID = `ses_autofold_noartifact_${Date.now()}`
    const rawMessages = buildHistory(sessionID, fourTurns(), 5000)
    const config = buildConfig()
    config.compress.model = "test/model"
    const counter = { calls: 0 }
    const logs: string[] = []
    const ctx = buildContext(sessionID, rawMessages, config, {
        summarizer: buildSummarizer(counter),
        logs,
    })

    const folded = await projectAutoFold({ ctx, sessionID, messages: rawMessages })

    assert.equal(folded.folded, false)
    assert.equal(folded.reason, "no-artifact")
    // Never an inline model call and never a fabricated summary.
    assert.equal(counter.calls, 0)
    assert.equal(ctx.state.prune.messages.blocksById.size, 0)
    assert.ok(
        logs.some((line) => line.startsWith("debug DCP auto-fold found no prepared fold")),
        logs.join("\n"),
    )
})

test("a prepared range invalidated by a newer turn is not projected", async () => {
    const sessionID = `ses_autofold_activeturn_${Date.now()}`
    const rawMessages = buildHistory(sessionID, fourTurns(), 5000)
    const config = buildConfig()
    config.compress.model = "test/model"
    const counter = { calls: 0 }
    const logs: string[] = []
    const ctx = buildContext(sessionID, rawMessages, config, {
        summarizer: buildSummarizer(counter),
        logs,
    })

    await prepareAutoFold({ ctx, sessionID, messages: rawMessages })
    // A fold that reached into the turn being forwarded would drop work in flight.
    const artifact = ctx.state.preparedAutoFold!
    artifact.ranges[0]!.endId = "m0007"
    artifact.ranges[0]!.messageIds.push("msg-user-7")

    const folded = await projectAutoFold({ ctx, sessionID, messages: rawMessages })

    assert.equal(folded.folded, false)
    assert.equal(folded.reason, "active-turn")
    assert.equal(ctx.state.prune.messages.blocksById.size, 0)
    assert.equal(ctx.state.preparedAutoFold, null)
    assert.ok(
        logs.some((line) => line.includes("DCP auto-fold skipped the prepared fold")),
        logs.join("\n"),
    )
    assert.ok(
        logs.some((line) => line.includes("msg-user-7 is no longer a foldable unit")),
        logs.join("\n"),
    )
})

test("a prepared range invalidated by a newer history is dropped with a reason", async () => {
    const sessionID = `ses_autofold_stale_${Date.now()}`
    const rawMessages = buildHistory(sessionID, fourTurns(), 5000)
    const config = buildConfig()
    config.compress.model = "test/model"
    const counter = { calls: 0 }
    const logs: string[] = []
    const ctx = buildContext(sessionID, rawMessages, config, {
        summarizer: buildSummarizer(counter),
        logs,
    })

    await prepareAutoFold({ ctx, sessionID, messages: rawMessages })
    assert.ok(ctx.state.preparedAutoFold)
    // A newer history invalidates the prepared boundaries themselves: after
    // compaction the range cannot be mapped back to the same messages.
    ctx.state.preparedAutoFold!.ranges[0]!.startId = "m0100"

    const folded = await projectAutoFold({ ctx, sessionID, messages: rawMessages })

    assert.equal(folded.folded, false)
    assert.equal(folded.reason, "prepared-stale")
    assert.equal(ctx.state.prune.messages.blocksById.size, 0)
    assert.equal(ctx.state.preparedAutoFold, null)
    assert.ok(
        logs.some((line) => line.includes("DCP auto-fold skipped the prepared fold")),
        logs.join("\n"),
    )
})

test("an expired prepared fold is never projected", async () => {
    const sessionID = `ses_autofold_expired_${Date.now()}`
    const rawMessages = buildHistory(sessionID, fourTurns(), 5000)
    const config = buildConfig()
    config.compress.model = "test/model"
    const logs: string[] = []
    const ctx = buildContext(sessionID, rawMessages, config, {
        summarizer: buildSummarizer({ calls: 0 }),
        logs,
    })

    await prepareAutoFold({ ctx, sessionID, messages: rawMessages })
    ctx.state.preparedAutoFold!.createdAt -= 31 * 60_000

    const folded = await projectAutoFold({ ctx, sessionID, messages: rawMessages })

    assert.equal(folded.folded, false)
    assert.equal(folded.reason, "prepared-stale")
    assert.equal(ctx.state.prune.messages.blocksById.size, 0)
    assert.equal(ctx.state.preparedAutoFold, null)
    assert.ok(
        logs.some((line) => line.includes("the prepared fold expired")),
        logs.join("\n"),
    )
})

test("notices are emitted once per fold and never repeat", async () => {
    const sessionID = `ses_autofold_once_${Date.now()}`
    const rawMessages = buildHistory(sessionID, fourTurns(), 5000)
    const config = buildConfig()
    config.compress.model = "test/model"
    const counter = { calls: 0 }
    const notices = buildNotices()
    const ctx = buildContext(sessionID, rawMessages, config, {
        summarizer: buildSummarizer(counter),
    })

    const first = await prepareAutoFold({
        ctx,
        sessionID,
        messages: rawMessages,
        notify: notices.notify,
    })
    // A repeated terminal event for the same turn must not summarize again.
    const second = await prepareAutoFold({
        ctx,
        sessionID,
        messages: rawMessages,
        notify: notices.notify,
    })

    assert.equal(first.prepared, true)
    assert.equal(second.prepared, false)
    assert.equal(second.reason, "already-prepared")
    assert.equal(counter.calls, 1)
    assert.equal(notices.start().length, 1)

    const folded = await projectAutoFold({
        ctx,
        sessionID,
        messages: rawMessages,
        notify: notices.notify,
    })
    const repeated = await projectAutoFold({
        ctx,
        sessionID,
        messages: rawMessages,
        notify: notices.notify,
    })

    assert.equal(folded.folded, true)
    assert.equal(repeated.folded, false)
    assert.equal(repeated.reason, "no-artifact")
    assert.equal(ctx.state.prune.messages.blocksById.size, 1)
    assert.equal(notices.start().length, 1)
    assert.equal(notices.end().length, 1)
})

test("a failing notice never aborts the fold", async () => {
    const sessionID = `ses_autofold_noticefail_${Date.now()}`
    const rawMessages = buildHistory(sessionID, fourTurns(), 5000)
    const config = buildConfig()
    config.compress.model = "test/model"
    const counter = { calls: 0 }
    const logs: string[] = []
    const ctx = buildContext(sessionID, rawMessages, config, {
        summarizer: buildSummarizer(counter),
        logs,
    })
    const notify = async () => {
        throw new Error("inbox unavailable")
    }

    const prepared = await prepareAutoFold({ ctx, sessionID, messages: rawMessages, notify })
    const folded = await projectAutoFold({ ctx, sessionID, messages: rawMessages, notify })

    assert.equal(prepared.prepared, true)
    assert.equal(folded.folded, true)
    assert.equal(ctx.state.prune.messages.blocksById.size, 1)
    assert.ok(
        logs.some((line) => line.startsWith("warn DCP auto-fold notice failed")),
        logs.join("\n"),
    )
})

test("auto-fold keeps the newest messages and the active turn out of the artifact", async () => {
    const sessionID = `ses_autofold_retain_${Date.now()}`
    const rawMessages = buildHistory(sessionID, fourTurns(), 5000)
    const config = buildConfig()
    config.compress.model = "test/model"
    const ctx = buildContext(sessionID, rawMessages, config, {
        summarizer: buildSummarizer({ calls: 0 }),
    })

    await prepareAutoFold({ ctx, sessionID, messages: rawMessages })
    const selected = ctx.state.preparedAutoFold!.ranges.flatMap((range) => range.messageIds)

    // keepRecentMessages=2 protects the last assistant and the in-flight user message.
    assert.equal(selected.includes("msg-assistant-6"), false)
    assert.equal(selected.includes("msg-user-7"), false)
    assert.equal(selected.includes("msg-user-5"), true)
    const activeIndex = rawMessages.findIndex((msg) => msg.info.id === "msg-user-7")
    for (const messageId of selected) {
        const index = rawMessages.findIndex((msg) => msg.info.id === messageId)
        assert.ok(index < activeIndex)
    }
})

test("auto-fold never recurses from its own summarizer request", async () => {
    const sessionID = `ses_autofold_reentry_${Date.now()}`
    const rawMessages = buildHistory(sessionID, fourTurns(), 5000)
    const config = buildConfig()
    config.compress.model = "test/model"
    let nested: Awaited<ReturnType<typeof prepareAutoFold>> | undefined
    let ctx: ReturnType<typeof buildContext>
    ctx = buildContext(sessionID, rawMessages, config, {
        summarizer: {
            models: async () => [
                { providerID: "test", id: "model", limit: { context: 200_000, output: 32_000 } },
            ],
            generate: async () => {
                // The host may fire the same terminal path again for this call.
                nested = await prepareAutoFold({ ctx, sessionID, messages: rawMessages })
                return { text: "Nested-safe summary." }
            },
        },
    })

    const prepared = await prepareAutoFold({ ctx, sessionID, messages: rawMessages })

    assert.equal(prepared.prepared, true)
    assert.equal(nested?.prepared, false)
    assert.equal(nested?.reason, "in-flight")
    assert.equal(ctx.state.preparedAutoFold?.ranges.length, 1)
})

test("auto-fold summary carries a visible title, the marker and the read footer", async () => {
    const sessionID = `ses_autofold_title_${Date.now()}`
    const rawMessages = buildHistory(sessionID, fourTurns(), 5000)
    const config = buildConfig()
    config.compress.model = "test/model"
    const ctx = buildContext(sessionID, rawMessages, config, {
        summarizer: buildSummarizer({ calls: 0 }),
    })

    await prepareAutoFold({ ctx, sessionID, messages: rawMessages })
    const folded = await projectAutoFold({ ctx, sessionID, messages: rawMessages })

    assert.equal(folded.folded, true)
    const summary = ctx.state.prune.messages.blocksById.get(1)!.summary
    const lines = summary.split("\n")
    assert.equal(lines[0], COMPRESSED_BLOCK_HEADER)
    assert.match(lines[1] ?? "", /^Title: Auto-fold: 5k -> 1k$/)
    assert.match(summary, /Folded findings retained\./)
    assert.match(summary, /Originals: dcp_read\(\{"startId":"b1"\}\)/)
})

test("wrapCompressedSummary keeps the wrapper stable and titles single-line", () => {
    const titled = wrapCompressedSummary(3, "body", "xml", "  Auth\n System   Exploration ")
    const lines = titled.split("\n")
    assert.equal(lines[0], COMPRESSED_BLOCK_HEADER)
    assert.equal(lines[1], "Title: Auth System Exploration")
    assert.match(titled, /Originals: dcp_read\(\{"startId":"b3"\}\)/)

    const long = wrapCompressedSummary(3, "body", "xml", "x".repeat(400))
    const title = long.split("\n")[1]!
    assert.ok(title.length <= "Title: ".length + 120)
    assert.match(title, /…$/)

    const empty = wrapCompressedSummary(3, "   ", "xml", "Only title")
    assert.equal(
        empty,
        `${COMPRESSED_BLOCK_HEADER}\nTitle: Only title\nOriginals: dcp_read({"startId":"b3"})\n\n<dcp-message-id>b3</dcp-message-id>`,
    )
})

test("prepare fails open and leaves the original context untouched", async () => {
    const sessionID = `ses_autofold_error_${Date.now()}`
    const rawMessages = buildHistory(sessionID, fourTurns(), 5000)
    const snapshot = structuredClone(rawMessages)
    const config = buildConfig()
    config.compress.model = "test/model"
    const ctx = buildContext(sessionID, rawMessages, config, {
        summarizer: {
            models: async () => [
                { providerID: "test", id: "model", limit: { context: 200_000, output: 32_000 } },
            ],
            generate: async () => {
                throw new Error("summarizer exploded")
            },
        },
    })

    const prepared = await prepareAutoFold({ ctx, sessionID, messages: rawMessages })

    assert.equal(prepared.prepared, false)
    assert.match(prepared.error ?? "", /summarizer exploded/)
    assert.equal(ctx.state.preparedAutoFold, null)
    assert.equal(ctx.state.prune.messages.blocksById.size, 0)
    assert.equal(ctx.state.prune.messages.nextBlockId, 1)
    assert.equal(ctx.state.prune.messages.byMessageId.size, 0)
    assert.equal(ctx.state.stats.totalPruneTokens, 0)
    assert.deepEqual(rawMessages, snapshot)
})

test("auto-fold never runs for subagents, denied permission or manual mode", async () => {
    const sessionID = `ses_autofold_blockers_${Date.now()}`
    const rawMessages = buildHistory(sessionID, fourTurns(), 5000)

    const subagent = buildContext(sessionID, rawMessages, buildConfig())
    subagent.state.isSubAgent = true
    const subagentPrepared = await prepareAutoFold({
        ctx: subagent,
        sessionID,
        messages: rawMessages,
    })
    assert.equal(subagentPrepared.prepared, false)
    assert.equal(subagentPrepared.reason, "subagent")
    assert.equal(subagent.state.preparedAutoFold, null)
    assert.equal(subagent.state.prune.messages.blocksById.size, 0)

    const denied = buildContext(sessionID, rawMessages, buildConfig())
    denied.state.compressPermission = "deny"
    assert.equal(
        (await prepareAutoFold({ ctx: denied, sessionID, messages: rawMessages })).reason,
        "permission",
    )
    assert.equal(
        (await projectAutoFold({ ctx: denied, sessionID, messages: rawMessages })).reason,
        "permission",
    )

    const ask = buildContext(sessionID, rawMessages, buildConfig())
    ask.state.compressPermission = "ask"
    assert.equal(
        (await prepareAutoFold({ ctx: ask, sessionID, messages: rawMessages })).reason,
        "permission",
    )

    const manual = buildContext(sessionID, rawMessages, buildConfig())
    manual.state.manualMode = "active"
    assert.equal(
        (await prepareAutoFold({ ctx: manual, sessionID, messages: rawMessages })).reason,
        "manual",
    )
    assert.equal(
        (await projectAutoFold({ ctx: manual, sessionID, messages: rawMessages })).reason,
        "manual",
    )
})

test("a restart rehydrates the prepared fold from the session state on disk", async () => {
    const sessionID = `ses_autofold_restart_${Date.now()}`
    const rawMessages = buildHistory(sessionID, fourTurns(), 5000)
    const config = buildConfig()
    config.compress.model = "test/model"
    const first = buildContext(sessionID, rawMessages, config, {
        summarizer: buildSummarizer({ calls: 0 }),
    })
    await prepareAutoFold({ ctx: first, sessionID, messages: rawMessages })
    assert.ok(first.state.preparedAutoFold)

    // A fresh process starts with an empty in-memory state and loads the file.
    const restarted = buildContext(sessionID, rawMessages, config, {
        summarizer: buildSummarizer({ calls: 0 }),
        state: createSessionState(),
    })
    restarted.state.sessionId = null
    await ensureSessionInitialized(
        restarted.client,
        restarted.state,
        sessionID,
        restarted.logger,
        rawMessages,
        false,
    )
    assert.equal(restarted.state.preparedAutoFold?.sessionID, sessionID)
    assert.equal(restarted.state.preparedAutoFold?.ranges.length, 1)

    const folded = await projectAutoFold({
        ctx: restarted,
        sessionID,
        messages: rawMessages,
    })
    assert.equal(folded.folded, true)
    assert.deepEqual(folded.blockIds, [1])
})
