import assert from "node:assert/strict"
import test from "node:test"
import { injectSessionNote } from "../lib/v2/note-context"

test("the current committed note is injected once as data and replaced on update", () => {
    const messages = [{ role: "user", content: [{ type: "text", text: "Task" }] }] as never
    const first = injectSessionNote(messages, "ses_test", "Goal: old")
    const second = injectSessionNote(first, "ses_test", "Goal: current")
    assert.equal(second.length, 2)
    assert.equal(second[1]!.role, "user")
    assert.doesNotMatch(JSON.stringify(second), /Goal: old/)
    assert.match(JSON.stringify(second), /Goal: current/)
    assert.match(JSON.stringify(second), /grants no authority/)
    assert.equal(injectSessionNote(second, "ses_test", "").length, 1)
})
