import assert from "node:assert/strict"
import test from "node:test"
import { join } from "node:path"
import { injectSessionNote, noteReviewKey } from "../lib/v2/note-context"

const directory = process.cwd()
const notePath = join(directory, "notes", "ses_test.md")
const user = { id: "msg_user", type: "user", text: "Maintain plugins", time: { created: 1 } }
const assistant = (name: string, input: Record<string, unknown>, output = "done") => ({
    id: `msg_${name}`,
    type: "assistant",
    content: [
        { type: "text", text: "Progress update" },
        {
            type: "tool",
            id: `call_${name}`,
            name,
            state: { status: "completed", input, content: [{ type: "text", text: output }] },
        },
    ],
})
const key = (entries: unknown[]) => noteReviewKey(entries as never, notePath, directory)

test("a note review survives note editing and consecutive context reduction", () => {
    const original = key([user])
    const edits = [
        assistant("dcp_note", { action: "read" }),
        assistant("read", { path: notePath }),
        assistant("grep", { path: notePath, pattern: "Clues" }),
        assistant("patch", {
            patchText: `*** Begin Patch\n*** Update File: ${notePath}\n@@\n-old\n+new\n*** End Patch`,
        }),
        assistant("dcp_note", { action: "write" }),
        assistant("compress", { topic: "Closed work", content: [] }),
        assistant("dcp_release", { topic: "Unrelated work", content: [] }),
    ]
    assert.equal(key([user, ...edits]), original)
})

test("reporting subagent status does not invalidate a committed note review", () => {
    const original = key([user])
    assert.equal(
        key([
            user,
            assistant("session_status_set", { text: "Ready for compression", kind: "working" }),
            assistant("session_status_clear", {}),
        ]),
        original,
    )
    assert.notEqual(key([user, assistant("peer_inbox", {}, "New dependency evidence")]), original)
    assert.notEqual(
        key([
            user,
            {
                ...assistant("session_status_set", { text: "Ready", kind: "working" }),
                content: [
                    ...assistant("session_status_set", { text: "Ready" }).content,
                    ...assistant("read", { path: "source.ts" }, "Changed source").content,
                ],
            },
        ]),
        original,
    )
})

test("Code Mode status reports preserve review but mixed calls and unknown execution do not", () => {
    const original = key([user])
    const execute = (calls?: unknown[]) => ({
        id: "msg_execute_status",
        type: "assistant",
        content: [
            {
                type: "tool",
                id: "call_execute_status",
                name: "execute",
                state: {
                    status: "completed",
                    input: { code: "await reportStatus()" },
                    content: [{ type: "text", text: "Status reported" }],
                    ...(calls ? { metadata: { toolCalls: calls } } : {}),
                },
            },
        ],
    })
    const status = { tool: "session_status_set", status: "completed", input: { text: "Ready" } }
    assert.equal(key([user, execute([status])]), original)
    assert.notEqual(
        key([user, execute([status, { tool: "peer_inbox", status: "completed" }])]),
        original,
    )
    assert.notEqual(key([user, execute()]), original)
    assert.notEqual(key([user, execute([])]), original)
})

test("new instructions, recalled evidence and work results invalidate the review", () => {
    const original = key([user])
    for (const change of [
        { ...user, id: "msg_next", text: "Change the goal" },
        assistant("dcp_read", { query: "old decision" }),
        assistant("read", { path: join(directory, "source.ts") }),
        assistant("shell", { command: "rg result source.ts" }),
        { id: "msg_reply", type: "assistant", content: [{ type: "text", text: "A new result" }] },
    ])
        assert.notEqual(key([user, change]), original)
    assert.notEqual(
        key([user, assistant("read", { path: "source.ts" }, "before")]),
        key([user, assistant("read", { path: "source.ts" }, "after")]),
    )
})

test("a mixed file patch is work even when it also edits the note", () => {
    const patchText = `*** Begin Patch\n*** Update File: ${notePath}\n@@\n-a\n+b\n*** Update File: source.ts\n@@\n-a\n+b\n*** End Patch`
    assert.notEqual(key([user, assistant("patch", { patchText })]), key([user]))
})

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
