import assert from "node:assert/strict"
import test from "node:test"
import type { PluginConfig } from "../lib/config"
import { Logger } from "../lib/logger"
import { compressNudge } from "../lib/messages/inject/inject"
import type { RuntimePrompts } from "../lib/prompts/store"
import { createSessionState, type WithParts } from "../lib/state"

function fixture(autoFold = false, maxContextLimit = 1) {
    const state = createSessionState("compact")
    const config = {
        compress: {
            permission: "allow",
            mode: "range",
            minContextLimit: 0,
            maxContextLimit,
            nudgeFrequency: 1,
            iterationNudgeThreshold: 100,
            summaryBuffer: false,
            ...(autoFold ? { autoFold: { enabled: true } } : {}),
        },
    } as PluginConfig
    const prompts = {
        contextLimitNudge: "<dcp-system-reminder>NUDGE_LIMIT</dcp-system-reminder>",
        turnNudge: "<dcp-system-reminder>NUDGE_TURN</dcp-system-reminder>",
        iterationNudge: "<dcp-system-reminder>NUDGE_ITERATION</dcp-system-reminder>",
    } as RuntimePrompts
    const user = (id: string, created: number) => ({
        info: {
            id,
            role: "user",
            time: { created },
            model: { providerID: "lab", modelID: "model" },
        },
        parts: [{ type: "text", text: "Question" }],
    })
    const messages = [
        user("msg_user", 1),
        {
            info: {
                id: "msg_answer",
                role: "assistant",
                time: { created: 2 },
                tokens: { input: 100, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
            },
            parts: [{ type: "text", text: "Original answer" }],
        },
        user("msg_next", 3),
    ] as WithParts[]
    return { state, config, prompts, messages, logger: new Logger(false) }
}

test("a nudge is returned for this request and never written into history", () => {
    const { state, config, prompts, messages, logger } = fixture()
    const before = structuredClone(messages)

    const nudge = compressNudge(state, config, logger, messages, prompts)

    assert.match(nudge, /NUDGE_LIMIT/)
    assert.deepEqual(messages, before)
})

test("compaction requests carry no nudge and leave anchors unchanged", () => {
    const { state, config, prompts, messages, logger } = fixture()
    compressNudge(state, config, logger, messages, prompts)
    const anchors = structuredClone(state.nudges)

    assert.equal(compressNudge(state, config, logger, messages, prompts, undefined, false), "")
    assert.deepEqual(state.nudges, anchors)
})

test("with auto-fold enabled only the context-limit nudge remains", () => {
    const below = fixture(true, 1_000_000)
    assert.equal(
        compressNudge(below.state, below.config, below.logger, below.messages, below.prompts),
        "",
    )

    const over = fixture(true)
    assert.match(
        compressNudge(over.state, over.config, over.logger, over.messages, over.prompts),
        /NUDGE_LIMIT/,
    )

    const manual = fixture(false, 1_000_000)
    assert.match(
        compressNudge(manual.state, manual.config, manual.logger, manual.messages, manual.prompts),
        /NUDGE_TURN/,
    )
})
