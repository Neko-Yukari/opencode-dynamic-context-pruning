import assert from "node:assert/strict"
import test from "node:test"
import type { Logger } from "../lib/logger"
import { createNotifier } from "../lib/v2/notify"

function buildLogger(): Logger {
    return {
        enabled: false,
        info: async () => {},
        warn: async () => {},
        debug: async () => {},
        error: async () => {},
        saveContext: async () => {},
    } as unknown as Logger
}

test("auto-fold notices use the host message shape peer messages use", async () => {
    const calls: Array<Record<string, unknown>> = []
    const ctx = {
        session: {
            synthetic: async (input: Record<string, unknown>) => {
                calls.push(input)
                return {}
            },
        },
    } as never

    const notify = createNotifier(ctx, buildLogger())
    await notify({
        sessionID: "ses_notice_shape",
        text: "自动压缩: release pipeline fold",
        description: "自动压缩",
        metadata: { source: "dcp.autofold", event: "end" },
    })

    assert.equal(calls.length, 1)
    const input = calls[0]!
    // The chat renders this as its own message row instead of a toast: a
    // synthetic session message delivered without waking a new turn.
    assert.match(String(input.id), /^msg_[a-f0-9]{32}$/)
    assert.equal(input.sessionID, "ses_notice_shape")
    assert.equal(input.text, "自动压缩: release pipeline fold")
    assert.equal(input.delivery, "steer")
    assert.equal(input.resume, false)
    assert.deepEqual(input.metadata, { source: "dcp.autofold", event: "end" })
})
