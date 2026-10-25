import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import {
    consumeNoteInjection,
    createNotes,
    markNoteInjection,
    SUGGESTED_NOTE_CHARACTERS,
    type NotesStorage,
} from "../lib/notes"

test("note injection is consumed once per successful operation", () => {
    const sessionID = "ses_injection_once"
    assert.equal(consumeNoteInjection(sessionID), false)
    markNoteInjection(sessionID)
    assert.equal(consumeNoteInjection(sessionID), true)
    assert.equal(consumeNoteInjection(sessionID), false)
})

class MemoryStorage implements NotesStorage {
    readonly values = new Map<string, unknown>()
    failSet = false

    async get(key: string): Promise<unknown> {
        return this.values.get(key)
    }

    async set(key: string, value: unknown): Promise<void> {
        if (this.failSet) throw new Error("simulated storage failure")
        this.values.set(key, structuredClone(value))
    }
}

async function fixture() {
    const root = await mkdtemp(join(tmpdir(), "dcp-notes-"))
    const previous = process.env.XDG_DATA_HOME
    process.env.XDG_DATA_HOME = root
    const storage = new MemoryStorage()
    const notes = createNotes(storage)
    if (previous === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = previous
    return { root, storage, notes }
}

test("reading exposes a stable draft without changing the stored note", async () => {
    const { root, notes } = await fixture()
    try {
        const path = notes.path("ses_parent")
        assert.equal(await notes.get("ses_parent"), undefined)
        await assert.rejects(stat(path), /ENOENT/)
        const first = await notes.read("ses_parent")
        assert.equal(first.path, path)
        assert.equal(first.revision, 0)
        assert.equal(first.exists, false)
        assert.equal(first.dirty, false)
        assert.equal(await readFile(path, "utf8"), "")
        await writeFile(path, "pending facts", "utf8")
        assert.equal((await notes.read("ses_parent")).dirty, true)
        assert.equal(await readFile(path, "utf8"), "pending facts")
        assert.equal(await notes.get("ses_parent"), undefined)
    } finally {
        await rm(root, { recursive: true, force: true })
    }
})

test("explicit commits update the note and unchanged commits preserve its revision", async () => {
    const { root, notes } = await fixture()
    try {
        const draft = await notes.read("ses_parent")
        await writeFile(draft.path, "handoff facts", "utf8")
        const committed = await notes.write("ses_parent")
        assert.equal(committed.revision, 1)
        assert.equal(committed.changed, true)
        assert.equal((await notes.get("ses_parent"))?.content, "handoff facts")
        const unchanged = await notes.write("ses_parent")
        assert.equal(unchanged.revision, 1)
        assert.equal(unchanged.changed, false)
        await writeFile(draft.path, "updated facts", "utf8")
        assert.equal((await notes.write("ses_parent")).revision, 2)
    } finally {
        await rm(root, { recursive: true, force: true })
    }
})

test("database failures preserve the draft and the previous stored note", async () => {
    const { root, storage, notes } = await fixture()
    try {
        const draft = await notes.read("ses_parent")
        await writeFile(draft.path, "stored facts", "utf8")
        await notes.write("ses_parent")
        await writeFile(draft.path, "pending facts", "utf8")
        storage.failSet = true
        await assert.rejects(notes.write("ses_parent"), /simulated storage failure/)
        assert.equal((await notes.get("ses_parent"))?.content, "stored facts")
        assert.equal(await readFile(draft.path, "utf8"), "pending facts")
    } finally {
        await rm(root, { recursive: true, force: true })
    }
})

test("the suggested size never truncates and sessions keep separate drafts", async () => {
    const { root, notes } = await fixture()
    try {
        const parent = await notes.read("ses_parent")
        const child = await notes.read("ses_child")
        assert.notEqual(parent.path, child.path)
        const content = "x".repeat(SUGGESTED_NOTE_CHARACTERS + 4000)
        await writeFile(parent.path, content, "utf8")
        await writeFile(child.path, "child facts", "utf8")
        assert.equal((await notes.write("ses_parent")).characters, content.length)
        await notes.write("ses_child")
        assert.equal((await notes.get("ses_parent"))?.content, content)
        assert.equal((await notes.get("ses_child"))?.content, "child facts")
    } finally {
        await rm(root, { recursive: true, force: true })
    }
})

test("a missing draft and a stored note without text fail at their input boundaries", async () => {
    const { root, storage, notes } = await fixture()
    try {
        await assert.rejects(notes.write("ses_parent"), /ENOENT/)
        await storage.set("dcp.note.v1.ses_parent", { content: 5, revision: 1 })
        await assert.rejects(notes.get("ses_parent"), /content must be a string/)
    } finally {
        await rm(root, { recursive: true, force: true })
    }
})
