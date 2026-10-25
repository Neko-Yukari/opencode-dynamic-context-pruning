import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import test from "node:test"
import { createNotes, SUGGESTED_NOTE_CHARACTERS, type Notes, type NotesStorage } from "../lib/notes"

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

async function withDataHome<T>(root: string, operation: () => Promise<T>): Promise<T> {
    const previous = process.env.XDG_DATA_HOME
    process.env.XDG_DATA_HOME = root
    try {
        return await operation()
    } finally {
        if (previous === undefined) delete process.env.XDG_DATA_HOME
        else process.env.XDG_DATA_HOME = previous
    }
}

async function makeRoot(): Promise<string> {
    return mkdtemp(join(tmpdir(), "dcp-notes-"))
}

async function createInstance(root: string, storage: NotesStorage): Promise<Notes> {
    return withDataHome(root, async () => createNotes(storage, "C:/project"))
}

test("read exposes a stable path and does not create a draft from get", async () => {
    const root = await makeRoot()
    try {
        const storage = new MemoryStorage()
        const notes = await createInstance(root, storage)
        const path = notes.path("ses_parent")

        await assert.rejects(stat(path), /ENOENT/)
        assert.equal(await notes.get("ses_parent"), undefined)
        await assert.rejects(stat(path), /ENOENT/)

        const first = await notes.read("ses_parent")
        assert.equal(first.path, path)
        assert.equal(first.exists, false)
        assert.equal(first.revision, 0)
        assert.equal(first.baseRevision, 0)
        assert.equal(first.characters, 0)
        assert.equal(first.suggestedCharacters, SUGGESTED_NOTE_CHARACTERS)
        assert.equal(first.dirty, false)
        assert.equal(first.stale, false)
        assert.equal(await readFile(path, "utf8"), "")
        assert.equal(await notes.get("ses_parent"), undefined)
        await assert.rejects(notes.assertReviewed("ses_parent", "review-1"), /no stored note/)
    } finally {
        await rm(root, { recursive: true, force: true })
    }
})

test("unchanged commit attests a new review without advancing revision", async () => {
    const root = await makeRoot()
    try {
        const storage = new MemoryStorage()
        const notes = await createInstance(root, storage)
        const first = await notes.read("ses_parent")
        await writeFile(first.path, "handoff facts", "utf8")

        const committed = await notes.write("ses_parent", "review-1")
        assert.equal(committed.revision, 1)
        assert.equal(committed.characters, "handoff facts".length)
        assert.equal(committed.changed, true)
        assert.equal(committed.dirty, false)

        const record = await notes.get("ses_parent")
        assert.equal(record?.content, "handoff facts")
        assert.equal(record?.revision, 1)
        assert.equal(record?.reviewKey, "review-1")
        await notes.assertReviewed("ses_parent", "review-1")

        const unchanged = await notes.write("ses_parent", "review-2")
        assert.equal(unchanged.revision, 1)
        assert.equal(unchanged.changed, false)
        assert.equal((await notes.get("ses_parent"))?.content, "handoff facts")
        assert.equal((await notes.get("ses_parent"))?.reviewKey, "review-2")
        await notes.assertReviewed("ses_parent", "review-2")
        await assert.rejects(notes.assertReviewed("ses_parent", "review-1"), /stale/)
    } finally {
        await rm(root, { recursive: true, force: true })
    }
})

test("dirty draft survives repeated reads and blocks review", async () => {
    const root = await makeRoot()
    try {
        const storage = new MemoryStorage()
        const notes = await createInstance(root, storage)
        const first = await notes.read("ses_parent")
        await writeFile(first.path, "stored note", "utf8")
        await notes.write("ses_parent", "review-1")

        await writeFile(first.path, "edited but not committed", "utf8")
        const second = await notes.read("ses_parent")
        const third = await notes.read("ses_parent")
        for (const result of [second, third]) {
            assert.equal(result.path, first.path)
            assert.equal(result.revision, 1)
            assert.equal(result.dirty, true)
            assert.equal(result.stale, false)
            assert.equal(result.baseRevision, 1)
            assert.equal(result.currentPath, undefined)
            assert.equal(result.recovery, undefined)
        }
        await assert.rejects(stat(join(dirname(first.path), "current.md")), /ENOENT/)
        assert.equal(await readFile(first.path, "utf8"), "edited but not committed")
        assert.equal((await notes.get("ses_parent"))?.content, "stored note")
        await assert.rejects(notes.assertReviewed("ses_parent", "review-1"), /uncommitted/)
    } finally {
        await rm(root, { recursive: true, force: true })
    }
})

test("stale draft conflicts instead of overwriting a newer note", async () => {
    const rootA = await makeRoot()
    const rootB = await makeRoot()
    try {
        const storage = new MemoryStorage()
        const notesA = await createInstance(rootA, storage)

        const initial = await notesA.read("ses_stale")
        await writeFile(initial.path, "old content", "utf8")
        await notesA.write("ses_stale", "review-1")

        const notesB = await createInstance(rootB, storage)
        const other = await notesB.read("ses_stale")
        assert.equal(await readFile(other.path, "utf8"), "old content")
        await writeFile(other.path, "new content", "utf8")
        await notesB.write("ses_stale", "review-2")
        assert.equal((await notesA.get("ses_stale"))?.content, "new content")

        const stale = await notesA.read("ses_stale")
        assert.equal(stale.revision, 2)
        assert.equal(stale.dirty, true)
        assert.equal(stale.stale, true)
        assert.equal(stale.baseRevision, 1)
        await assert.rejects(notesA.write("ses_stale", "review-3"), /conflict/)
        assert.equal(await readFile(stale.path, "utf8"), "old content")
        assert.equal((await notesA.get("ses_stale"))?.content, "new content")
        assert.equal((await notesA.get("ses_stale"))?.reviewKey, "review-2")
        await assert.rejects(notesA.assertReviewed("ses_stale", "review-2"), /uncommitted/)
        await assert.rejects(notesA.assertReviewed("ses_stale", "review-3"), /stale/)

        // Recovery: rewriting the draft to the current stored note makes the baseline safe.
        await writeFile(stale.path, "new content", "utf8")
        const recovered = await notesA.write("ses_stale", "review-3")
        assert.equal(recovered.revision, 2)
        assert.equal(recovered.changed, false)
        await notesA.assertReviewed("ses_stale", "review-3")
    } finally {
        await rm(rootA, { recursive: true, force: true })
        await rm(rootB, { recursive: true, force: true })
    }
})

test("failed database write preserves the draft and leaves the note unchanged", async () => {
    const root = await makeRoot()
    try {
        const storage = new MemoryStorage()
        const notes = await createInstance(root, storage)
        const first = await notes.read("ses_parent")
        await writeFile(first.path, "pending content", "utf8")

        storage.failSet = true
        await assert.rejects(notes.write("ses_parent", "review-1"), /simulated storage failure/)
        assert.equal(await notes.get("ses_parent"), undefined)
        assert.equal(await readFile(first.path, "utf8"), "pending content")
        const afterFailure = await notes.read("ses_parent")
        assert.equal(afterFailure.dirty, true)
        assert.equal(afterFailure.stale, false)
        assert.equal(afterFailure.revision, 0)

        storage.failSet = false
        const committed = await notes.write("ses_parent", "review-1")
        assert.equal(committed.revision, 1)
        assert.equal((await notes.get("ses_parent"))?.content, "pending content")
    } finally {
        await rm(root, { recursive: true, force: true })
    }
})

test("the suggested size is advisory and never truncates", async () => {
    const root = await makeRoot()
    try {
        const storage = new MemoryStorage()
        const notes = await createInstance(root, storage)
        const long = "x".repeat(SUGGESTED_NOTE_CHARACTERS + 4000)
        const first = await notes.read("ses_parent")
        await writeFile(first.path, long, "utf8")

        const reread = await notes.read("ses_parent")
        assert.equal(reread.characters, long.length)
        assert.equal(reread.characters > reread.suggestedCharacters, true)
        assert.equal(reread.suggestedCharacters, SUGGESTED_NOTE_CHARACTERS)

        const committed = await notes.write("ses_parent", "review-1")
        assert.equal(committed.characters, long.length)
        assert.equal((await notes.get("ses_parent"))?.content, long)
    } finally {
        await rm(root, { recursive: true, force: true })
    }
})

test("parent and child sessions keep separate drafts and records", async () => {
    const root = await makeRoot()
    try {
        const storage = new MemoryStorage()
        const notes = await createInstance(root, storage)
        const parent = await notes.read("ses_parent")
        const child = await notes.read("ses_child")
        assert.notEqual(parent.path, child.path)

        await writeFile(parent.path, "parent note", "utf8")
        await writeFile(child.path, "child note", "utf8")
        await notes.write("ses_parent", "parent-review")
        await notes.write("ses_child", "child-review")

        assert.equal((await notes.get("ses_parent"))?.content, "parent note")
        assert.equal((await notes.get("ses_child"))?.content, "child note")
        assert.equal((await notes.get("ses_parent"))?.reviewKey, "parent-review")
        assert.equal((await notes.get("ses_child"))?.reviewKey, "child-review")
        await notes.assertReviewed("ses_parent", "parent-review")
        await notes.assertReviewed("ses_child", "child-review")
        await assert.rejects(notes.assertReviewed("ses_parent", "child-review"), /stale/)
        await assert.rejects(notes.assertReviewed("ses_child", "parent-review"), /stale/)
    } finally {
        await rm(root, { recursive: true, force: true })
    }
})

test("note and an unfinished draft persist across a module restart", async () => {
    const root = await makeRoot()
    try {
        const storage = new MemoryStorage()
        const firstProcess = await createInstance(root, storage)
        const first = await firstProcess.read("ses_parent")
        await writeFile(first.path, "durable note", "utf8")
        await firstProcess.write("ses_parent", "review-1")

        await writeFile(first.path, "draft after restart", "utf8")

        const secondProcess = await createInstance(root, storage)
        assert.equal((await secondProcess.get("ses_parent"))?.content, "durable note")
        assert.equal((await secondProcess.get("ses_parent"))?.revision, 1)
        assert.equal(secondProcess.path("ses_parent"), first.path)
        const reread = await secondProcess.read("ses_parent")
        assert.equal(reread.dirty, true)
        assert.equal(reread.stale, false)
        assert.equal(reread.revision, 1)
        assert.equal(reread.baseRevision, 1)
        assert.equal(await readFile(reread.path, "utf8"), "draft after restart")
        await assert.rejects(secondProcess.assertReviewed("ses_parent", "review-1"), /uncommitted/)
        await secondProcess.write("ses_parent", "review-2")
        assert.equal((await secondProcess.get("ses_parent"))?.content, "draft after restart")
        assert.equal((await secondProcess.get("ses_parent"))?.revision, 2)
        await secondProcess.assertReviewed("ses_parent", "review-2")
    } finally {
        await rm(root, { recursive: true, force: true })
    }
})

test("corrupt stored records are reported instead of silently reset", async () => {
    const root = await makeRoot()
    try {
        const storage = new MemoryStorage()
        const notes = await createInstance(root, storage)
        const first = await notes.read("ses_parent")
        await writeFile(first.path, "note", "utf8")
        await notes.write("ses_parent", "review-1")

        const [key] = [...storage.values.keys()]
        assert.equal(typeof key, "string")
        await storage.set(key!, { content: 5, revision: 1 })
        await assert.rejects(notes.get("ses_parent"), /corrupt/)
    } finally {
        await rm(root, { recursive: true, force: true })
    }
})

test("invalid session IDs and review keys fail explicitly", async () => {
    const root = await makeRoot()
    try {
        const storage = new MemoryStorage()
        const notes = await createInstance(root, storage)
        assert.throws(() => notes.path(""), /invalid session ID/)
        await assert.rejects(notes.read(""), /invalid session ID/)
        const first = await notes.read("ses_parent")
        await writeFile(first.path, "note", "utf8")
        await assert.rejects(notes.write("ses_parent", ""), /review key/)
        await assert.rejects(notes.assertReviewed("ses_parent", ""), /review key/)
    } finally {
        await rm(root, { recursive: true, force: true })
    }
})

test("stale dirty draft exposes current.md and explicit rebase preserves both sources", async () => {
    const rootA = await makeRoot()
    const rootB = await makeRoot()
    try {
        const storage = new MemoryStorage()
        const notesA = await createInstance(rootA, storage)

        const initial = await notesA.read("ses_recover")
        await writeFile(initial.path, "draft A only", "utf8")
        await notesA.write("ses_recover", "review-1")

        const notesB = await createInstance(rootB, storage)
        const other = await notesB.read("ses_recover")
        await writeFile(other.path, "stored B", "utf8")
        await notesB.write("ses_recover", "review-2")

        const metaPath = join(dirname(initial.path), "note.meta.json")
        const metaBefore = await readFile(metaPath, "utf8")

        const stale = await notesA.read("ses_recover")
        const currentPath = stale.currentPath!
        assert.equal(stale.dirty, true)
        assert.equal(stale.stale, true)
        assert.equal(stale.revision, 2)
        assert.equal(stale.baseRevision, 1)
        assert.equal(currentPath, stale.recovery?.currentPath)
        assert.equal(dirname(currentPath), dirname(stale.path))
        assert.equal(basename(currentPath), "current.md")
        assert.equal(await readFile(stale.path, "utf8"), "draft A only")
        assert.equal(await readFile(currentPath, "utf8"), "stored B")
        assert.equal(await readFile(metaPath, "utf8"), metaBefore)
        assert.match(stale.recovery?.instructions ?? "", /current\.md/)
        assert.match(stale.recovery?.instructions ?? "", /dcp_note read/)
        assert.match(stale.recovery?.instructions ?? "", /preserve useful draft edits/)
        assert.match(stale.recovery?.instructions ?? "", /never rebased automatically/)

        // A failed current.md refresh leaves note.md and the sidecar untouched.
        await rm(currentPath, { force: true })
        await mkdir(currentPath)
        await assert.rejects(notesA.read("ses_recover"), /could not be refreshed/)
        assert.equal(await readFile(stale.path, "utf8"), "draft A only")
        assert.equal(await readFile(metaPath, "utf8"), metaBefore)
        await rm(currentPath, { recursive: true, force: true })

        // The next stale read refreshes the same current.md from the newer stored note.
        await writeFile(other.path, "stored C", "utf8")
        await notesB.write("ses_recover", "review-3")
        const refreshed = await notesA.read("ses_recover")
        assert.equal(refreshed.revision, 3)
        assert.equal(refreshed.stale, true)
        assert.equal(refreshed.currentPath, currentPath)
        assert.equal(await readFile(currentPath, "utf8"), "stored C")
        assert.equal(await readFile(refreshed.path, "utf8"), "draft A only")
        assert.equal(await readFile(metaPath, "utf8"), metaBefore)

        // A dirty stale draft still cannot overwrite the current record.
        await assert.rejects(notesA.write("ses_recover", "review-4"), /conflict/)
        assert.equal(await readFile(refreshed.path, "utf8"), "draft A only")
        assert.equal(await readFile(currentPath, "utf8"), "stored C")
        assert.equal(await readFile(metaPath, "utf8"), metaBefore)

        // Explicit recovery: align note.md to current.md, then read rebases the clean draft.
        await writeFile(refreshed.path, await readFile(currentPath, "utf8"), "utf8")
        const rebased = await notesA.read("ses_recover")
        assert.equal(rebased.dirty, false)
        assert.equal(rebased.stale, false)
        assert.equal(rebased.revision, 3)
        assert.equal(rebased.baseRevision, 3)
        assert.equal(rebased.currentPath, undefined)
        assert.equal(rebased.recovery, undefined)
        assert.equal(await readFile(rebased.path, "utf8"), "stored C")

        // Apply merged edits, commit, and leave current.md as the recovery snapshot.
        await writeFile(rebased.path, "stored C + merged A", "utf8")
        const committed = await notesA.write("ses_recover", "review-4")
        assert.equal(committed.revision, 4)
        assert.equal((await notesA.get("ses_recover"))?.content, "stored C + merged A")
        assert.equal(await readFile(currentPath, "utf8"), "stored C")
        await notesA.assertReviewed("ses_recover", "review-4")
    } finally {
        await rm(rootA, { recursive: true, force: true })
        await rm(rootB, { recursive: true, force: true })
    }
})
