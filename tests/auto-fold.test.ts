import assert from "node:assert/strict"
import test from "node:test"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { mkdirSync } from "node:fs"
import { createSessionState, type WithParts } from "../lib/state"
import type { PluginConfig } from "../lib/config"
import { Logger } from "../lib/logger"
import { runAutoFold } from "../lib/compress/autofold"
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
                { id: `${userID}-p`, messageID: userID, sessionID, type: "text", text: `${turn.user}${filler}` },
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

function buildContext(
    sessionID: string,
    rawMessages: WithParts[],
    config: PluginConfig,
    extra: { summarizer?: unknown } = {},
) {
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
        state: createSessionState(),
        logger: new Logger(false),
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

test("autoFold config keys and values are validated", () => {
    assert.deepEqual(getInvalidConfigKeys({ compress: { autoFold: {
        enabled: true,
        targetTokens: 100000,
        minGrowthTokens: 4096,
        keepRecentMessages: 3,
    } } }), [])

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
        keys({ compress: { autoFold: { enabled: true, targetTokens: 1, minGrowthTokens: -1 } } }).includes(
            "compress.autoFold.minGrowthTokens",
        ),
    )
    assert.ok(
        keys({ compress: { autoFold: { enabled: true, targetTokens: 1, keepRecentMessages: 1.5 } } }).includes(
            "compress.autoFold.keepRecentMessages",
        ),
    )
})

test("auto-fold is disabled by default and never creates a block", async () => {
    const sessionID = `ses_autofold_disabled_${Date.now()}`
    const rawMessages = buildHistory(sessionID, fourTurns(), 5000)
    const config = buildConfig()
    delete (config.compress as { autoFold?: unknown }).autoFold
    const ctx = buildContext(sessionID, rawMessages, config)

    const result = await runAutoFold({ ctx, sessionID, messages: rawMessages })

    assert.equal(result.folded, false)
    assert.equal(result.reason, "disabled")
    assert.equal(ctx.state.prune.messages.blocksById.size, 0)
})

test("auto-fold stays idle while the context is below target plus growth", async () => {
    const sessionID = `ses_autofold_below_${Date.now()}`
    const rawMessages = buildHistory(sessionID, fourTurns(), 5000)
    const ctx = buildContext(
        sessionID,
        rawMessages,
        buildConfig({ targetTokens: 100_000, minGrowthTokens: 4096 }),
    )

    const result = await runAutoFold({ ctx, sessionID, messages: rawMessages })

    assert.equal(result.folded, false)
    assert.equal(result.reason, "below-target")
    assert.equal(result.contextTokens, 5010)
    assert.equal(ctx.state.prune.messages.blocksById.size, 0)
})

test("auto-fold above target creates one ordinary compression block", async () => {
    const sessionID = `ses_autofold_block_${Date.now()}`
    const rawMessages = buildHistory(sessionID, fourTurns(), 5000)
    const ctx = buildContext(sessionID, rawMessages, buildConfig())

    const result = await runAutoFold({ ctx, sessionID, messages: rawMessages })

    assert.equal(result.folded, true)
    assert.deepEqual(result.blockIds, [1])
    const block = ctx.state.prune.messages.blocksById.get(1)!
    assert.equal(block.active, true)
    assert.equal(block.mode, "range")
    assert.equal(block.blockId, 1)
    assert.equal(block.anchorMessageId, "msg-user-1")
    assert.equal(block.startId, "m0001")
    assert.equal(block.endId, "m0005")
    assert.deepEqual(block.consumedBlockIds, [])
    assert.deepEqual(block.includedBlockIds, [])
    assert.deepEqual(block.effectiveMessageIds, [
        "msg-user-1",
        "msg-assistant-2",
        "msg-user-3",
        "msg-assistant-4",
        "msg-user-5",
    ])
    assert.ok(block.summaryTokens > 0)
    assert.ok(block.compressedTokens >= 0)
    assert.ok(ctx.state.stats.totalPruneTokens >= 0)
    // Without compress.model the summary is an honest digest, never a fake summary.
    assert.match(block.summary, /Mechanical digest \(no summarizer model configured/)
    // The fold must actually free resident context, not just reshuffle it.
    assert.ok((result.compressedTokens ?? 0) > block.summaryTokens)
    // The block is owned by the in-flight request message so block sync keeps it.
    assert.equal(block.compressMessageId, "msg-user-7")
    assert.equal(ctx.state.prune.messages.activeByAnchorMessageId.get("msg-user-1"), 1)
    for (const messageId of block.effectiveMessageIds) {
        assert.deepEqual(ctx.state.prune.messages.byMessageId.get(messageId)?.activeBlockIds, [1])
    }
})

test("auto-fold keeps the newest messages and the active turn intact", async () => {
    const sessionID = `ses_autofold_retain_${Date.now()}`
    const rawMessages = buildHistory(sessionID, fourTurns(), 5000)
    const ctx = buildContext(sessionID, rawMessages, buildConfig())

    const result = await runAutoFold({ ctx, sessionID, messages: rawMessages })

    assert.equal(result.folded, true)
    const block = ctx.state.prune.messages.blocksById.get(1)!
    // keepRecentMessages=2 protects the last assistant and the in-flight user message.
    assert.equal(block.effectiveMessageIds.includes("msg-assistant-6"), false)
    assert.equal(block.effectiveMessageIds.includes("msg-user-7"), false)
    assert.equal(block.effectiveMessageIds.includes("msg-user-5"), true)
    assert.equal(ctx.state.prune.messages.byMessageId.get("msg-assistant-6"), undefined)
    assert.equal(ctx.state.prune.messages.byMessageId.get("msg-user-7"), undefined)
    // Nothing at or after the active user turn may be folded.
    const activeIndex = rawMessages.findIndex((msg) => msg.info.id === "msg-user-7")
    for (const messageId of block.effectiveMessageIds) {
        const index = rawMessages.findIndex((msg) => msg.info.id === messageId)
        assert.ok(index < activeIndex)
    }
})

test("auto-fold runs at most one pass per request", async () => {
    const sessionID = `ses_autofold_once_${Date.now()}`
    const rawMessages = buildHistory(sessionID, fourTurns(), 5000)
    const ctx = buildContext(sessionID, rawMessages, buildConfig())

    const first = await runAutoFold({ ctx, sessionID, messages: rawMessages })
    const second = await runAutoFold({ ctx, sessionID, messages: rawMessages })

    assert.equal(first.folded, true)
    assert.equal(second.folded, false)
    assert.equal(second.reason, "already-folded")
    assert.equal(ctx.state.prune.messages.blocksById.size, 1)
})

test("auto-fold never recurses from its own summarizer request", async () => {
    const sessionID = `ses_autofold_reentry_${Date.now()}`
    const rawMessages = buildHistory(sessionID, fourTurns(), 5000)
    const config = buildConfig()
    config.compress.model = "test/model"
    let nested: Awaited<ReturnType<typeof runAutoFold>> | undefined
    const ctx = buildContext(sessionID, rawMessages, config, {
        summarizer: {
            models: async () => [
                { providerID: "test", id: "model", limit: { context: 200_000, output: 32_000 } },
            ],
            generate: async () => {
                // The host may fire the context hook for this internal call.
                nested = await runAutoFold({ ctx, sessionID, messages: rawMessages })
                return { text: "Nested-safe summary." }
            },
        },
    })

    const result = await runAutoFold({ ctx, sessionID, messages: rawMessages })

    assert.equal(result.folded, true)
    assert.equal(nested?.folded, false)
    assert.equal(nested?.reason, "in-flight")
    assert.equal(ctx.state.prune.messages.blocksById.size, 1)
})

test("auto-fold summary carries a visible title, the marker and the read footer", async () => {    const sessionID = `ses_autofold_title_${Date.now()}`
    const rawMessages = buildHistory(sessionID, fourTurns(), 5000)
    const config = buildConfig()
    config.compress.model = "test/model"
    const ctx = buildContext(sessionID, rawMessages, config, {
        summarizer: {
            models: async () => [
                { providerID: "test", id: "model", limit: { context: 200_000, output: 32_000 } },
            ],
            generate: async () => ({ text: "Folded findings retained." }),
        },
    })

    const result = await runAutoFold({ ctx, sessionID, messages: rawMessages })

    assert.equal(result.folded, true)
    const summary = ctx.state.prune.messages.blocksById.get(1)!.summary
    const lines = summary.split("\n")
    assert.equal(lines[0], COMPRESSED_BLOCK_HEADER)
    assert.match(lines[1] ?? "", /^Title: Auto-fold: 5k -> 1k$/)
    assert.match(summary, /Folded findings retained\./)
    assert.match(summary, /Originals: dcp_read\(\{"startId":"b1"\}\)/)
    assert.match(summary, /<dcp-message-id>b1<\/dcp-message-id>/)
    assert.equal(ctx.state.prune.messages.blocksById.get(1)!.topic, "Auto-fold: 5k -> 1k")
})

test("wrapCompressedSummary keeps the wrapper stable and titles single-line", () => {
    const untitled = wrapCompressedSummary(3, "body")
    assert.equal(
        untitled,
        `${COMPRESSED_BLOCK_HEADER}\nbody\n\nOriginals: dcp_read({"startId":"b3"})\n\n<dcp-message-id>b3</dcp-message-id>`,
    )

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

test("auto-fold fails open and leaves the original context untouched", async () => {
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

    const result = await runAutoFold({ ctx, sessionID, messages: rawMessages })

    assert.equal(result.folded, false)
    assert.match(result.error ?? "", /summarizer exploded/)
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
    subagent.state.sessionId = sessionID
    const subagentResult = await runAutoFold({
        ctx: subagent,
        sessionID,
        messages: rawMessages,
    })
    assert.equal(subagentResult.folded, false)
    assert.equal(subagentResult.reason, "subagent")
    assert.equal(subagent.state.prune.messages.blocksById.size, 0)

    const denied = buildContext(sessionID, rawMessages, buildConfig())
    denied.state.compressPermission = "deny"
    denied.state.sessionId = sessionID
    assert.equal((await runAutoFold({ ctx: denied, sessionID, messages: rawMessages })).reason, "permission")

    const ask = buildContext(sessionID, rawMessages, buildConfig())
    ask.state.compressPermission = "ask"
    ask.state.sessionId = sessionID
    assert.equal((await runAutoFold({ ctx: ask, sessionID, messages: rawMessages })).reason, "permission")

    const manual = buildContext(sessionID, rawMessages, buildConfig())
    manual.state.manualMode = "active"
    manual.state.sessionId = sessionID
    assert.equal((await runAutoFold({ ctx: manual, sessionID, messages: rawMessages })).reason, "manual")
})
