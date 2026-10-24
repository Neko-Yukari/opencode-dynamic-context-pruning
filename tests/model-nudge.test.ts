import assert from "node:assert/strict"
import test, { after } from "node:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { handleManualTriggerCommand, type ManualCommandContext } from "../lib/commands/manual"
import type { PluginConfig } from "../lib/config"
import { Logger } from "../lib/logger"
import { injectCompressNudges } from "../lib/messages/inject/inject"
import {
    CONTEXT_LIMIT_NUDGE,
    MODEL_SELECTION_CONTEXT_LIMIT_NUDGE,
} from "../lib/prompts/context-limit-nudge"
import { PromptStore } from "../lib/prompts/store"
import { createSessionState, type WithParts } from "../lib/state"

const root = mkdtempSync(join(tmpdir(), "dcp-model-nudge-"))
const previousConfigHome = process.env.XDG_CONFIG_HOME
const previousConfigDir = process.env.OPENCODE_CONFIG_DIR
process.env.XDG_CONFIG_HOME = join(root, "config")
delete process.env.OPENCODE_CONFIG_DIR

const overridePath = join(root, "config", "opencode", "dcp-prompts", "overrides")

// customPrompts disabled by default, matching the deployed configuration; the
// configured flag only picks which bundled nudge is the default.
function store(customPrompts = false, configuredModel = false) {
    return new PromptStore(
        new Logger(false),
        join(root, "workspace"),
        customPrompts,
        "compact",
        configuredModel,
    )
}

function writeOverride(content: string) {
    mkdirSync(overridePath, { recursive: true })
    writeFileSync(join(overridePath, "context-limit-nudge.md"), content, "utf-8")
}

function removeOverride() {
    rmSync(overridePath, { recursive: true, force: true })
}

function sessionFixture(configured = false) {
    const state = createSessionState("compact")
    // An active block makes the automatic block guidance part of the nudge.
    state.prune.messages.activeBlockIds.add(1)
    const config = {
        compress: {
            permission: "allow",
            mode: "range",
            minContextLimit: 0,
            maxContextLimit: 1,
            nudgeFrequency: 1,
            summaryBuffer: false,
            ...(configured ? { model: "test/model#high" } : {}),
        },
    } as PluginConfig
    const raw = [
        {
            info: { id: "msg_user", role: "user", time: { created: 1 } },
            parts: [{ type: "text", text: "Original question" }],
        },
        {
            info: {
                id: "msg_answer",
                role: "assistant",
                time: { created: 2 },
                tokens: { input: 100, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
            },
            parts: [{ type: "text", text: "Original answer" }],
        },
    ] as WithParts[]
    return { state, config, messages: structuredClone(raw) as WithParts[] }
}

test("configured default nudge keeps the summary with the summarizer", () => {
    const runtime = store(false, true).getRuntimePrompts()

    assert.equal(runtime.contextLimitNudge.trim(), MODEL_SELECTION_CONTEXT_LIMIT_NUDGE.trim())
    assert.match(runtime.contextLimitNudge, /Do not write or pass a summary yourself/)
    assert.match(runtime.contextLimitNudge, /startId, endId/)
    assert.match(runtime.contextLimitNudge, /do not substitute a summary of your own/)
    assert.doesNotMatch(runtime.contextLimitNudge, /Your summary MUST cover/)
    assert.doesNotMatch(runtime.contextLimitNudge, /You MUST use the .compress. tool now/)
})

test("configured default reaches the real context-limit injection", () => {
    const prompts = store(false, true)
    const { state, config, messages } = sessionFixture(true)

    injectCompressNudges(state, config, new Logger(false), messages, prompts.getRuntimePrompts())

    const injected = JSON.stringify(messages)
    assert.match(injected, /COMPRESS AT A SAFE BOUNDARY/)
    assert.match(injected, /preserved by the configured summarizer/)
    assert.doesNotMatch(injected, /include each required placeholder exactly once/)
})

test("a user context-limit override still wins in configured mode and survives reload", () => {
    writeOverride("CUSTOM_CONTEXT_LIMIT_OVERRIDE\n")
    try {
        const prompts = store(true, true)
        assert.match(prompts.getRuntimePrompts().contextLimitNudge, /CUSTOM_CONTEXT_LIMIT_OVERRIDE/)
        assert.doesNotMatch(
            prompts.getRuntimePrompts().contextLimitNudge,
            /COMPRESS AT A SAFE BOUNDARY/,
        )

        // Removing the override falls back to the configured default after reload.
        removeOverride()
        prompts.reload()
        assert.equal(
            prompts.getRuntimePrompts().contextLimitNudge.trim(),
            MODEL_SELECTION_CONTEXT_LIMIT_NUDGE.trim(),
        )
    } finally {
        removeOverride()
    }
})

test("an override identical to the legacy default is still applied verbatim", () => {
    writeOverride(`${CONTEXT_LIMIT_NUDGE.trim()}\n`)
    try {
        const runtime = store(true, true).getRuntimePrompts()
        assert.equal(runtime.contextLimitNudge.trim(), CONTEXT_LIMIT_NUDGE.trim())
        assert.doesNotMatch(runtime.contextLimitNudge, /COMPRESS AT A SAFE BOUNDARY/)
    } finally {
        removeOverride()
    }
})

test("unconfigured mode keeps the existing nudge and injection unchanged", () => {
    const prompts = store(false, false)
    const runtime = prompts.getRuntimePrompts()

    assert.equal(runtime.contextLimitNudge, CONTEXT_LIMIT_NUDGE)
    assert.match(runtime.contextLimitNudge, /Your summary MUST cover/)
    assert.match(runtime.contextLimitNudge, /You MUST use the .compress. tool now/)

    const { state, config, messages } = sessionFixture(false)
    injectCompressNudges(state, config, new Logger(false), messages, runtime)
    const injected = JSON.stringify(messages)
    assert.match(injected, /MAX CONTEXT LIMIT REACHED/)
    assert.match(injected, /include each required placeholder exactly once in the summary/)
    assert.doesNotMatch(injected, /preserved by the configured summarizer/)
})

test("manual compression uses the configured selection-only trigger text", async () => {
    const configured = await handleManualTriggerCommand(
        { ...sessionFixture(true), logger: new Logger(false) } as ManualCommandContext,
        "compress",
    )
    assert.ok(configured)
    assert.match(configured, /Select older, genuinely finished closed ranges/)
    assert.match(configured, /do not write or pass one yourself/)
    assert.match(configured, /If no safely closed range exists, continue without compressing/)
    assert.match(configured, /preserved by the configured summarizer/)
    assert.doesNotMatch(configured, /You must now use the compress tool/)
    assert.doesNotMatch(configured, /high-fidelity technical summary/)
    assert.doesNotMatch(configured, /include each required placeholder exactly once/)

    const legacy = await handleManualTriggerCommand(
        { ...sessionFixture(false), logger: new Logger(false) } as ManualCommandContext,
        "compress",
    )
    assert.ok(legacy)
    assert.match(legacy, /You must now use the compress tool/)
    assert.match(legacy, /high-fidelity technical summary/)
    assert.match(legacy, /include each required placeholder exactly once in the summary/)
    assert.doesNotMatch(legacy, /Select older, genuinely finished closed ranges/)
})

after(() => {
    if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = previousConfigHome
    if (previousConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
    else process.env.OPENCODE_CONFIG_DIR = previousConfigDir
    rmSync(root, { recursive: true, force: true })
})
