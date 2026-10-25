import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

export const SUGGESTED_NOTE_CHARACTERS = 8000
const STORAGE_PREFIX = "dcp.note.v1."
const pendingInjection = new Set<string>()

/** Request one note injection after a successful compression or release. */
export function markNoteInjection(sessionID: string | null | undefined) {
    if (sessionID) pendingInjection.add(sessionID)
}

/** Consume the one-shot injection for a session. */
export function consumeNoteInjection(sessionID: string) {
    return pendingInjection.delete(sessionID)
}

export interface NotesStorage {
    get(key: string): Promise<unknown>
    set(key: string, value: unknown): Promise<void>
}

export interface NoteRecord {
    content: string
    revision: number
    updatedAt: number
}

export interface NoteReadResult {
    path: string
    revision: number
    characters: number
    suggestedCharacters: number
    dirty: boolean
    exists: boolean
}

export interface NoteWriteResult {
    path: string
    revision: number
    characters: number
    suggestedCharacters: number
    changed: boolean
}

export interface Notes {
    path(sessionID: string): string
    read(sessionID: string): Promise<NoteReadResult>
    write(sessionID: string): Promise<NoteWriteResult>
    get(sessionID: string): Promise<NoteRecord | undefined>
}

export function createNotes(storage: NotesStorage): Notes {
    const root = join(
        process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"),
        "opencode",
        "storage",
        "dcp-notes",
    )

    function path(sessionID: string): string {
        const readable = sessionID.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 48)
        const hash = createHash("sha256").update(sessionID).digest("hex").slice(0, 16)
        return join(root, `${readable}-${hash}`, "note.md")
    }

    async function get(sessionID: string): Promise<NoteRecord | undefined> {
        const value = await storage.get(`${STORAGE_PREFIX}${sessionID}`)
        if (value === undefined) return undefined
        const record = value as NoteRecord
        if (typeof record?.content !== "string")
            throw new Error("DCP note record is corrupt: content must be a string.")
        return record
    }

    async function read(sessionID: string): Promise<NoteReadResult> {
        const draftPath = path(sessionID)
        const note = await get(sessionID)
        const content = note?.content ?? ""
        const draft = await readText(draftPath)
        if (draft === undefined) {
            await mkdir(join(draftPath, ".."), { recursive: true })
            await writeFile(draftPath, content, "utf8")
        }
        return {
            path: draftPath,
            revision: note?.revision ?? 0,
            characters: (draft ?? content).length,
            suggestedCharacters: SUGGESTED_NOTE_CHARACTERS,
            dirty: draft !== undefined && draft !== content,
            exists: note !== undefined,
        }
    }

    async function write(sessionID: string): Promise<NoteWriteResult> {
        const draftPath = path(sessionID)
        const draft = await readFile(draftPath, "utf8")
        const note = await get(sessionID)
        const changed = draft !== (note?.content ?? "")
        const revision = note === undefined ? 1 : changed ? note.revision + 1 : note.revision
        await storage.set(`${STORAGE_PREFIX}${sessionID}`, {
            content: draft,
            revision,
            updatedAt: Date.now(),
        } satisfies NoteRecord)
        return {
            path: draftPath,
            revision,
            characters: draft.length,
            suggestedCharacters: SUGGESTED_NOTE_CHARACTERS,
            changed,
        }
    }

    return { path, read, write, get }
}

async function readText(path: string): Promise<string | undefined> {
    try {
        return await readFile(path, "utf8")
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
        throw error
    }
}
