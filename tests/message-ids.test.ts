import assert from "node:assert/strict"
import test from "node:test"
import { Logger } from "../lib/logger"
import { assignMessageRefs } from "../lib/message-ids"
import { checkSession, createSessionState, type WithParts } from "../lib/state"

test("native compaction clears aliases while preserving their high-water counter", async () => {
    const sessionID = `ses_message_ids_after_compaction_${Date.now()}`
    const messages = [
        {
            info: {
                id: "msg_summary",
                role: "assistant",
                sessionID,
                summary: true,
                time: { created: 2 },
            },
            parts: [],
        },
        {
            info: {
                id: "msg_followup",
                role: "user",
                sessionID,
                time: { created: 3 },
            },
            parts: [{ type: "text", id: "part_followup", text: "Continue" }],
        },
    ] as WithParts[]
    const state = createSessionState("compact")
    state.sessionId = sessionID
    state.messageIds.byRawId.set("msg_old", "@9999@")
    state.messageIds.byRef.set("@9999@", "msg_old")
    state.messageIds.nextRef = 10000

    await checkSession({}, state, new Logger(false), messages, false)

    assert.equal(state.lastCompaction, 2)
    assert.equal(state.messageIds.byRawId.size, 0)
    assert.equal(state.messageIds.byRef.size, 0)
    assert.equal(state.messageIds.nextRef, 10000)
    assert.equal(assignMessageRefs(state, messages), 2)
    assert.equal(state.messageIds.byRawId.get("msg_summary"), "@10000@")
    assert.equal(state.messageIds.byRawId.get("msg_followup"), "@10001@")
    assert.equal(state.messageIds.byRef.has("@9999@"), false)
    assert.equal(state.messageIds.nextRef, 10002)
})
