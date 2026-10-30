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
    autoFoldTopic,
    prepareAutoFold,
    projectAutoFold,
    resolveAutoFold,
} from "../lib/compress/autofold"
import { foldPrepareTrigger, type IdleHookEvent } from "../lib/v2/fold-events"
import { IDLE_HOOK, registerIdlePrepare } from "../lib/v2/idle-hook"
import {
    wrapCompressedSummary,
    withCompressedBlockNote,
    COMPRESSED_BLOCK_HEADER,
    COMPRESSED_BLOCK_NOTE,
} from "../lib/compress/state"
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
                triggerTokens: 1_100,
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
                    triggerTokens: 104_096,
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
                triggerTokens: 104_096,
                keepRecentMessages: 3,
            },
        },
    })
    assert.deepEqual(valid, [])

    // Thresholds accept the same absolute/percentage specs as maxContextLimit.
    assert.deepEqual(
        validateConfigTypes({
            compress: {
                autoFold: {
                    enabled: true,
                    targetTokens: "100k/10%",
                    triggerTokens: "200k/20%",
                    minFoldTokens: "100k",
                    keepRecentMessages: 3,
                },
            },
        }),
        [],
    )

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
            compress: { autoFold: { enabled: true, targetTokens: 1, triggerTokens: -1 } },
        }).includes("compress.autoFold.triggerTokens"),
    )
    assert.ok(
        keys({
            compress: { autoFold: { enabled: true, targetTokens: 1, keepRecentMessages: 1.5 } },
        }).includes("compress.autoFold.keepRecentMessages"),
    )
    assert.ok(
        keys({ compress: { autoFold: { enabled: true, targetTokens: "100 k" } } }).includes(
            "compress.autoFold.targetTokens",
        ),
    )
})

test("auto-fold thresholds resolve absolute and percentage specs against the window", () => {
    const resolve = (
        overrides: Partial<PluginConfig["compress"]["autoFold"]>,
        window?: number,
    ) => {
        const state = createSessionState()
        state.modelContextLimit = window
        const config = buildConfig(overrides)
        const ctx = buildContext(`ses_autofold_resolve_${window ?? "none"}`, [], config, {
            state,
        })
        return resolveAutoFold(ctx)
    }

    // "100k/10%": 100k is smaller than 10% of a 1M window. Without an
    // explicit trigger the older target + growth model still decides when to fold.
    assert.deepEqual(
        resolve({ targetTokens: "100k/10%", triggerTokens: "200k/20%" }, 1_048_576)
            .autoFold,
        {
            targetTokens: 100_000,
            triggerTokens: 200_000,
            minFoldTokens: 0,
            keepRecentMessages: 2,
        },
    )

    // Same specs on a 200k window: both percentages win, so the target drops to
    // 10% and the trigger to 20% of the window.
    const narrow = resolve(
        { targetTokens: "100k/10%", triggerTokens: "200k/20%" },
        200_000,
    ).autoFold
    assert.deepEqual([narrow?.targetTokens, narrow?.triggerTokens], [20_000, 40_000])

    // Plain numbers keep their literal meaning and need no window.
    assert.deepEqual(
        resolve({ targetTokens: 1_000, triggerTokens: 1_100, minFoldTokens: 20_000 }).autoFold,
        {
            targetTokens: 1_000,
            triggerTokens: 1_100,
            minFoldTokens: 20_000,
            keepRecentMessages: 2,
        },
    )

    // An explicit trigger wins over target + growth: "200k/20%" is
    // 200k on a 1M window, because the lower of 200k and 20% wins.
    assert.equal(
        resolve({ targetTokens: "100k/10%", triggerTokens: "200k/20%" }, 1_048_576)
            .autoFold?.triggerTokens,
        200_000,
    )

    // 20% of a 500k window is smaller than 200k, so the trigger follows the window down.
    assert.equal(
        resolve({ targetTokens: "100k/10%", triggerTokens: "200k/20%" }, 500_000)
            .autoFold?.triggerTokens,
        100_000,
    )

    // A trigger that has to drop to the target's own size would fold forever.
    const noRoom = resolve({ targetTokens: 100_000, triggerTokens: "200k/20%" }, 400_000)
    assert.deepEqual([noRoom.autoFold, noRoom.reason], [undefined, "invalid-trigger"])

    // Nothing to resolve a percentage against: auto-fold is unavailable, not guessed.
    const unknownWindow = resolve({ targetTokens: "100k/10%" })
    assert.equal(unknownWindow.autoFold, undefined)
    assert.equal(unknownWindow.reason, "disabled")
})

test("percentage thresholds without a known model window never fold", async () => {
    const sessionID = `ses_autofold_nowindow_${Date.now()}`
    const rawMessages = buildHistory(sessionID, fourTurns(), 500_000)
    const logs: string[] = []
    const ctx = buildContext(
        sessionID,
        rawMessages,
        buildConfig({ targetTokens: "100k/10%" }),
        { logs },
    )
    assert.equal(ctx.state.modelContextLimit, undefined)

    const prepared = await prepareAutoFold({
        ctx,
        sessionID,
        messages: rawMessages,
    })

    assert.equal(prepared.prepared, false)
    assert.equal(prepared.reason, "disabled")
    assert.equal(ctx.state.preparedAutoFold, null)

    const folded = await projectAutoFold({ ctx, sessionID, messages: rawMessages })
    assert.equal(folded.folded, false)
    assert.equal(folded.reason, "disabled")
    // The reason is explainable in the debug log instead of silently skipped.
    assert.ok(
        logs.some(
            (line) =>
                line.startsWith("debug ") && line.includes("no known model context window"),
        ),
    )
})

test("percentage thresholds move the trigger line with the model window", async () => {
    const window = 1_048_576
    const config = buildConfig({
        targetTokens: "100k/10%",
        triggerTokens: "200k/20%",
    })
    config.compress.model = "test/model"

    const belowID = `ses_autofold_window_below_${Date.now()}`
    const belowMessages = buildHistory(belowID, fourTurns(), 199_989)
    const belowState = createSessionState()
    belowState.modelContextLimit = window
    const belowCtx = buildContext(belowID, belowMessages, config, { state: belowState })

    const skipped = await prepareAutoFold({
        ctx: belowCtx,
        sessionID: belowID,
        messages: belowMessages,
    })
    // 200k is the lower of 200k and 20% of the 1M window.
    assert.equal(skipped.contextTokens, 199_999)
    assert.equal(skipped.prepared, false)
    assert.equal(skipped.reason, "below-target")
    assert.equal(belowCtx.state.preparedAutoFold, null)

    const aboveID = `ses_autofold_window_above_${Date.now()}`
    const aboveMessages = buildHistory(aboveID, fourTurns(), 199_991)
    const aboveState = createSessionState()
    aboveState.modelContextLimit = window
    const counter = { calls: 0 }
    const aboveCtx = buildContext(aboveID, aboveMessages, config, {
        state: aboveState,
        summarizer: buildSummarizer(counter),
    })

    const prepared = await prepareAutoFold({
        ctx: aboveCtx,
        sessionID: aboveID,
        messages: aboveMessages,
    })
    assert.equal(prepared.contextTokens, 200_001)
    assert.equal(prepared.prepared, true)
    assert.equal(counter.calls, 1)
    assert.equal(aboveCtx.state.preparedAutoFold?.targetTokens, 100_000)
})

test("auto-fold is disabled by default and never prepares a fold", async () => {
    const sessionID = `ses_autofold_disabled_${Date.now()}`
    const rawMessages = buildHistory(sessionID, fourTurns(), 5000)
    const config = buildConfig()
    delete (config.compress as { autoFold?: unknown }).autoFold
    const ctx = buildContext(sessionID, rawMessages, config)

    const prepared = await prepareAutoFold({
        ctx,
        sessionID,
        messages: rawMessages,
    })

    assert.equal(prepared.prepared, false)
    assert.equal(prepared.reason, "disabled")
    assert.equal(ctx.state.preparedAutoFold, null)
})

test("auto-fold stays idle while the context is below target plus growth", async () => {
    const sessionID = `ses_autofold_below_${Date.now()}`
    const rawMessages = buildHistory(sessionID, fourTurns(), 5000)
    const ctx = buildContext(
        sessionID,
        rawMessages,
        buildConfig({ targetTokens: 100_000, triggerTokens: 104_096 }),
    )

    const prepared = await prepareAutoFold({
        ctx,
        sessionID,
        messages: rawMessages,
    })

    assert.equal(prepared.prepared, false)
    assert.equal(prepared.reason, "below-target")
    assert.equal(prepared.contextTokens, 5010)
    assert.equal(ctx.state.preparedAutoFold, null)
    // A request that is merely over budget never announces a fold.
})

test("an explicit trigger starts the fold regardless of the growth that was configured", async () => {
    const sessionID = `ses_autofold_trigger_${Date.now()}`
    const rawMessages = buildHistory(sessionID, fourTurns(), 5000)
    const run = async (triggerTokens: number) => {
        const config = buildConfig({ targetTokens: 1_000, triggerTokens })
        config.compress.model = "test/model"
        const counter = { calls: 0 }
        const ctx = buildContext(sessionID, rawMessages, config, {
            summarizer: buildSummarizer(counter),
        })
        const prepared = await prepareAutoFold({
            ctx,
            sessionID,
            messages: rawMessages,
        })
        return { prepared, calls: counter.calls }
    }

    // 5010 tokens is over a 2000 trigger even though it is nowhere near the 100k
    // growth the older model would have required.
    const folded = await run(2_000)
    assert.equal(folded.prepared.prepared, true)
    assert.equal(folded.calls, 1)

    // The same history stays idle when the trigger is above it.
    const skipped = await run(6_000)
    assert.equal(skipped.prepared.prepared, false)
    assert.equal(skipped.prepared.reason, "below-target")
    assert.equal(skipped.calls, 0)
})

test("skips a fold that cannot reclaim the minimum reduction", async () => {
    const sessionID = `ses_autofold_floor_${Date.now()}`
    const rawMessages = buildHistory(sessionID, fourTurns(), 5000)
    const counter = { calls: 0 }
    const ctx = buildContext(sessionID, rawMessages, buildConfig({ minFoldTokens: 100_000 }), {
        summarizer: buildSummarizer(counter),
    })

    const prepared = await prepareAutoFold({
        ctx,
        sessionID,
        messages: rawMessages,
    })

    assert.equal(prepared.prepared, false)
    assert.equal(prepared.reason, "below-floor")
    assert.equal(ctx.state.preparedAutoFold, null)
    // A fold that would barely dent the context must not spend a summarizer call.
    assert.equal(counter.calls, 0)
})

test("prepare authors the fold artifact without touching the request path", async () => {    const sessionID = `ses_autofold_prepare_${Date.now()}`
    const rawMessages = buildHistory(sessionID, fourTurns(), 5000)
    const config = buildConfig()
    config.compress.model = "test/model"
    const counter = { calls: 0 }
    const ctx = buildContext(sessionID, rawMessages, config, {
        summarizer: buildSummarizer(counter),
    })

    const prepared = await prepareAutoFold({
        ctx,
        sessionID,
        messages: rawMessages,
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
})

test("the hook projects a prepared artifact with zero summarizer calls", async () => {
    const sessionID = `ses_autofold_project_${Date.now()}`
    const rawMessages = buildHistory(sessionID, fourTurns(), 5000)
    const config = buildConfig()
    config.compress.model = "test/model"
    const counter = { calls: 0 }
    const ctx = buildContext(sessionID, rawMessages, config, {
        summarizer: buildSummarizer(counter),
    })

    await prepareAutoFold({ ctx, sessionID, messages: rawMessages })
    const prepareCalls = counter.calls
    const folded = await projectAutoFold({
        ctx,
        sessionID,
        messages: rawMessages,
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
})

test("a committed fold is reported only in the log, never in the conversation", async () => {
    const sessionID = `ses_autofold_captions_${Date.now()}`
    const rawMessages = buildHistory(sessionID, fourTurns(), 5000)
    const before = structuredClone(rawMessages)
    const config = buildConfig()
    config.compress.model = "test/model"
    const logs: string[] = []
    const ctx = buildContext(sessionID, rawMessages, config, {
        logs,
        summarizer: buildSummarizer({ calls: 0 }),
    })

    await prepareAutoFold({ ctx, sessionID, messages: rawMessages })
    const folded = await projectAutoFold({ ctx, sessionID, messages: rawMessages })

    assert.equal(folded.folded, true)
    assert.deepEqual(rawMessages, before)
    const applied = logs.find((line) => line.startsWith("info DCP auto-fold applied"))
    assert.ok(applied, logs.join("\n"))
    assert.match(applied, /"topic":"Folded findings retained"/)
    assert.match(applied, /"afterTokens":\d+/)
    assert.match(applied, /"compressedMessages":5/)
})

test("a failed fold leaves no notice and only logs", async () => {
    const sessionID = `ses_autofold_failcaption_${Date.now()}`
    const rawMessages = buildHistory(sessionID, fourTurns(), 5000)
    const config = buildConfig()
    config.compress.model = "test/model"
    const logs: string[] = []
    const ctx = buildContext(sessionID, rawMessages, config, {
        logs,
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
    assert.ok(logs.some((line) => line.startsWith("warn DCP auto-fold prepare failed")))
})

test("the completion topic skips host metadata and keeps version decimals intact", () => {
    // The supplied real-world shape: a host heading followed by the actual subject.
    assert.equal(
        autoFoldTopic([
            {
                body: "Auto-fold (DCP plugin on OpenCode host 2.2.1)\n\n通知时机调整：只在用户输入时附注。",
            },
        ]),
        "通知时机调整",
    )
    // A version is not a sentence stop.
    assert.equal(autoFoldTopic([{ body: "Bumped to 2.2.1. Then more." }]), "Bumped to 2.2.1")
    assert.equal(autoFoldTopic([{ body: "Fixed decimal 3.5 handling" }]), "Fixed decimal 3.5 handling")
    // A path-only metadata line is skipped, not rendered.
    assert.equal(
        autoFoldTopic([{ body: "D:\\RimWorld\\save\\game.rws\n地图加载修复" }]),
        "地图加载修复",
    )
    // Paths inside a topic are stripped.
    const pathTopic = autoFoldTopic([{ body: "修复 C:\\Users\\81004\\RimWorld\\save 的加载" }])
    assert.equal(pathTopic.includes("C:\\"), false)
    assert.ok(pathTopic.startsWith("修复"))
    // Markdown heading and list markers do not leak into the topic.
    assert.equal(autoFoldTopic([{ body: "## 通知时机调整\n正文" }]), "通知时机调整")
    assert.equal(autoFoldTopic([{ body: "   \n " }]), "")
    assert.equal(autoFoldTopic([]), "")
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
    const ctx = buildContext(sessionID, rawMessages, config, {
        summarizer: buildSummarizer(counter),
    })

    const first = await prepareAutoFold({
        ctx,
        sessionID,
        messages: rawMessages,
    })
    // A repeated terminal event for the same turn must not summarize again.
    const second = await prepareAutoFold({
        ctx,
        sessionID,
        messages: rawMessages,
    })

    assert.equal(first.prepared, true)
    assert.equal(second.prepared, false)
    assert.equal(second.reason, "already-prepared")
    assert.equal(counter.calls, 1)

    const folded = await projectAutoFold({
        ctx,
        sessionID,
        messages: rawMessages,
    })
    const repeated = await projectAutoFold({
        ctx,
        sessionID,
        messages: rawMessages,
    })

    assert.equal(folded.folded, true)
    assert.equal(repeated.folded, false)
    assert.equal(repeated.reason, "no-artifact")
    assert.equal(ctx.state.prune.messages.blocksById.size, 1)
})

test("a committed fold is not summarized again for the same turn", async () => {
    const sessionID = `ses_autofold_committed_${Date.now()}`
    const rawMessages = buildHistory(sessionID, fourTurns(), 5000)
    const config = buildConfig()
    config.compress.model = "test/model"
    const counter = { calls: 0 }
    const ctx = buildContext(sessionID, rawMessages, config, {
        summarizer: buildSummarizer(counter),
    })

    const prepared = await prepareAutoFold({ ctx, sessionID, messages: rawMessages })
    const folded = await projectAutoFold({ ctx, sessionID, messages: rawMessages })
    // The artifact is consumed by the commit; a repeated terminal event for the
    // same user message must not spend a second summarizer call.
    const repeated = await prepareAutoFold({ ctx, sessionID, messages: rawMessages })

    assert.equal(prepared.prepared, true)
    assert.equal(folded.folded, true)
    assert.equal(repeated.prepared, false)
    assert.equal(repeated.reason, "already-prepared")
    assert.equal(counter.calls, 1)
})

test("a failed summary leaves no artifact and no notice", async () => {
    const sessionID = `ses_autofold_failnotice_${Date.now()}`
    const rawMessages = buildHistory(sessionID, fourTurns(), 5000)
    const config = buildConfig()
    config.compress.model = "test/model"
    const logs: string[] = []
    const ctx = buildContext(sessionID, rawMessages, config, {
        logs,
        summarizer: {
            models: async () => [
                { providerID: "test", id: "model", limit: { context: 200_000, output: 32_000 } },
            ],
            generate: async () => {
                throw new Error("summarizer exploded\nat provider.test")
            },
        },
    })

    const first = await prepareAutoFold({
        ctx,
        sessionID,
        messages: rawMessages,
        trigger: "session.execution.succeeded",
    })
    // A retry may run again because no artifact was claimed, but it stays silent.
    const second = await prepareAutoFold({
        ctx,
        sessionID,
        messages: rawMessages,
        trigger: "session.idle",
    })

    assert.equal(first.prepared, false)
    assert.equal(second.prepared, false)
    assert.equal(ctx.state.preparedAutoFold, null)
    // The provider payload stays in the diagnostics log, not in chat.
    assert.ok(logs.some((line) => line.startsWith("warn DCP auto-fold prepare failed")))
})

test("prepare logs every attempt with its trigger and outcome", async () => {
    const sessionID = `ses_autofold_logs_${Date.now()}`
    const rawMessages = buildHistory(sessionID, fourTurns(), 5000)

    // The common steady state stays on the debug channel.
    const belowLogs: string[] = []
    const below = buildContext(
        sessionID,
        rawMessages,
        buildConfig({ targetTokens: 100_000, triggerTokens: 104_096 }),
        { logs: belowLogs },
    )
    await prepareAutoFold({
        ctx: below,
        sessionID,
        messages: rawMessages,
        trigger: "session.idle",
    })
    assert.equal(belowLogs.length, 1)
    assert.match(belowLogs[0]!, /^debug DCP auto-fold prepare /)
    assert.match(belowLogs[0]!, /"trigger":"session\.idle"/)
    assert.match(belowLogs[0]!, /"sessionID":"ses_autofold_logs_\d+"/)
    assert.match(belowLogs[0]!, /"prepared":false/)
    assert.match(belowLogs[0]!, /"reason":"below-target"/)

    // Every skip that is not the steady state, and every success, is info.
    const floorLogs: string[] = []
    const floor = buildContext(sessionID, rawMessages, buildConfig({ minFoldTokens: 100_000 }), {
        logs: floorLogs,
    })
    await prepareAutoFold({
        ctx: floor,
        sessionID,
        messages: rawMessages,
        trigger: "session.execution.failed",
    })
    assert.match(floorLogs[0]!, /^info DCP auto-fold prepare /)
    assert.match(floorLogs[0]!, /"reason":"below-floor"/)

    const config = buildConfig()
    config.compress.model = "test/model"
    const successLogs: string[] = []
    const success = buildContext(sessionID, rawMessages, config, {
        summarizer: buildSummarizer({ calls: 0 }),
        logs: successLogs,
    })
    await prepareAutoFold({
        ctx: success,
        sessionID,
        messages: rawMessages,
        trigger: "session.execution.succeeded",
    })
    const summary = successLogs.filter((line) => line.includes("DCP auto-fold prepare "))
    assert.equal(summary.length, 1)
    assert.match(summary[0]!, /^info DCP auto-fold prepare /)
    assert.match(summary[0]!, /"prepared":true/)
    assert.match(summary[0]!, /"reason":"prepared"/)
    assert.match(summary[0]!, /"preparedTokens":\d+/)
})

test("session.idle starts a prepare and repeated terminal events prepare once", async () => {
    const sessionID = `ses_autofold_dispatch_${Date.now()}`
    const rawMessages = buildHistory(sessionID, fourTurns(), 5000)
    const config = buildConfig()
    config.compress.model = "test/model"
    const counter = { calls: 0 }
    const ctx = buildContext(sessionID, rawMessages, config, {
        summarizer: buildSummarizer(counter),
    })
    const directory = "C:/Users/81004/opencode-dcp"

    // A turn that ends without a terminal execution event still falls idle.
    const events = [
        {
            type: "session.idle",
            data: { sessionID },
            location: { directory: "C:\\Users\\81004\\opencode-dcp\\" },
        },
        { type: "session.execution.succeeded", data: { sessionID } },
        { type: "session.execution.failed", data: { sessionID } },
        { type: "session.execution.interrupted", data: { sessionID } },
    ]
    const reasons: Array<string | undefined> = []
    for (const event of events) {
        const trigger = foldPrepareTrigger(event, directory)
        assert.equal(trigger, sessionID)
        const result = await prepareAutoFold({
            ctx,
            sessionID,
            messages: rawMessages,
            trigger: event.type,
        })
        reasons.push(result.reason)
    }

    // One summarizer call for all four turn-end events; no chat notice yet.
    assert.equal(counter.calls, 1)
    assert.deepEqual(reasons, [undefined, "already-prepared", "already-prepared", "already-prepared"])
    // Unrelated events and other directories never start a prepare.
    assert.equal(foldPrepareTrigger({ type: "session.status", data: { sessionID } }, directory), undefined)
    assert.equal(
        foldPrepareTrigger(
            { type: "session.idle", data: { sessionID }, location: { directory: "D:/other" } },
            directory,
        ),
        undefined,
    )
    assert.equal(foldPrepareTrigger({ type: "session.idle", data: {} }, directory), undefined)
})

test("the experimental.idle hook prepares once with its own trigger and background", async () => {
    const sessionID = `ses_autofold_idlehook_${Date.now()}`
    const rawMessages = buildHistory(sessionID, fourTurns(), 5000)
    const config = buildConfig()
    config.compress.model = "test/model"
    const counter = { calls: 0 }
    const logs: string[] = []
    const ctx = buildContext(sessionID, rawMessages, config, {
        summarizer: buildSummarizer(counter),
        logs,
    })
    let idle: ((event: IdleHookEvent) => Promise<void> | void) | undefined
    const registered: string[] = []
    const ready = await registerIdlePrepare({
        hook: async (name, callback) => {
            registered.push(name)
            idle = callback
            return {}
        },
        logger: ctx.logger,
        directory: "C:/Users/81004/opencode-dcp",
        prepare: async (target, event) => {
            assert.equal(event.background, true)
            await prepareAutoFold({
                ctx,
                sessionID: target,
                messages: rawMessages,
                trigger: IDLE_HOOK,
            })
        },
    })

    assert.equal(ready, true)
    assert.deepEqual(registered, ["experimental.idle"])
    await idle!({ sessionID, background: true })

    assert.equal(counter.calls, 1)
    assert.match(logs[0]!, /^debug DCP experimental\.idle hook fired /)
    assert.match(logs[0]!, /"background":true/)
    const prepareLine = logs.find((line) => line.includes("DCP auto-fold prepare "))
    assert.match(prepareLine!, /"trigger":"experimental\.idle"/)

    // A payload that names another directory never prepares here.
    await idle!({ sessionID, background: false, location: { directory: "D:\\other" } })
    assert.equal(counter.calls, 1)
    assert.ok(logs.some((line) => line.startsWith("debug DCP experimental.idle ignored")))
})

test("an idle hook and a terminal event for the same anchor prepare only once", async () => {
    const sessionID = `ses_autofold_idleonce_${Date.now()}`
    const rawMessages = buildHistory(sessionID, fourTurns(), 5000)
    const config = buildConfig()
    config.compress.model = "test/model"
    const counter = { calls: 0 }
    const ctx = buildContext(sessionID, rawMessages, config, {
        summarizer: buildSummarizer(counter),
    })
    let idle: ((event: IdleHookEvent) => Promise<void> | void) | undefined
    await registerIdlePrepare({
        hook: async (_name, callback) => {
            idle = callback
            return {}
        },
        logger: ctx.logger,
        directory: "C:/Users/81004/opencode-dcp",
        prepare: async (target) => {
            await prepareAutoFold({
                ctx,
                sessionID: target,
                messages: rawMessages,
                trigger: IDLE_HOOK,
            })
        },
    })

    await idle!({ sessionID, background: false })
    // The fallback event path still runs; it must find the prepared artifact.
    const second = await prepareAutoFold({
        ctx,
        sessionID,
        messages: rawMessages,
        trigger: "session.execution.succeeded",
    })

    assert.equal(second.prepared, false)
    assert.equal(second.reason, "already-prepared")
    assert.equal(counter.calls, 1)
})

test("an unknown idle hook kind only warns and keeps the event path available", async () => {
    const logs: string[] = []
    let prepared = 0
    const ready = await registerIdlePrepare({
        hook: async () => {
            throw new Error("unknown session hook kind")
        },
        logger: buildLogger(logs),
        directory: "C:/Users/81004/opencode-dcp",
        prepare: async () => {
            prepared++
        },
    })

    assert.equal(ready, false)
    assert.equal(prepared, 0)
    assert.match(logs[0]!, /^warn DCP experimental\.idle hook not registered /)
    assert.match(logs[0]!, /"error":"unknown session hook kind"/)
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

test("a rendered block carries the read-only note once, after its title", () => {
    const titled = wrapCompressedSummary(3, "body", "xml", "Auth")
    const rendered = withCompressedBlockNote(titled)
    assert.deepEqual(rendered.split("\n").slice(0, 4), [
        COMPRESSED_BLOCK_HEADER,
        "Title: Auth",
        COMPRESSED_BLOCK_NOTE,
        "body",
    ])
    // Deterministic and idempotent: the cached prefix never shifts.
    assert.equal(withCompressedBlockNote(rendered), rendered)
    assert.equal(withCompressedBlockNote(titled), rendered)

    const untitled = withCompressedBlockNote(wrapCompressedSummary(4, "body"))
    assert.equal(untitled.split("\n")[1], COMPRESSED_BLOCK_NOTE)
    // Text that is not a block is left alone.
    assert.equal(withCompressedBlockNote("plain"), "plain")
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

test("auto-fold runs in subagents only when allowSubAgents is enabled", async () => {
    const sessionID = `ses_autofold_blockers_${Date.now()}`
    const rawMessages = buildHistory(sessionID, fourTurns(), 5000)

    // The existing flag decides the subagent gate for both prepare and commit.
    const allowedConfig = buildConfig()
    allowedConfig.compress.model = "test/model"
    const allowed = buildContext(sessionID, rawMessages, allowedConfig, {
        summarizer: buildSummarizer({ calls: 0 }),
    })
    allowed.state.isSubAgent = true
    const allowedPrepared = await prepareAutoFold({
        ctx: allowed,
        sessionID,
        messages: rawMessages,
    })
    assert.equal(allowedPrepared.prepared, true)
    const allowedFolded = await projectAutoFold({
        ctx: allowed,
        sessionID,
        messages: rawMessages,
    })
    assert.equal(allowedFolded.folded, true)
    assert.equal(allowed.state.prune.messages.blocksById.size, 1)

    const blockedConfig = buildConfig()
    blockedConfig.experimental.allowSubAgents = false
    const subagent = buildContext(sessionID, rawMessages, blockedConfig)
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
    assert.equal(
        (await projectAutoFold({ ctx: subagent, sessionID, messages: rawMessages })).reason,
        "subagent",
    )

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
