import { createHash } from "node:crypto"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

// The host storage API is a plain key/value get/set (SQL select + upsert). It has no
// compare-and-swap, so callers must serialize per session. Concurrent plugin locations or
// processes using the same session can still lose a note update; that boundary is owned by
// the caller, not this module.
export const SUGGESTED_NOTE_CHARACTERS = 8000

const STORAGE_PREFIX = "dcp.note.v1."
const DRAFT_VERSION = 1
const MAX_SESSION_ID_LENGTH = 256
const MAX_REVIEW_KEY_LENGTH = 2048

export interface NotesStorage {
    get(key: string): Promise<unknown>
    set(key: string, value: unknown): Promise<void>
}

export interface NoteRecord {
    content: string
    revision: number
    reviewKey?: string
    reviewedAt?: number
    updatedAt: number
}

/**
 * Recovery-only copy of the stored note, exposed when a dirty draft is stale.
 * `currentPath` points at `current.md`; it is not note truth and must not be edited or committed.
 */
export interface NoteRecovery {
    currentPath: string
    instructions: string
}

export interface NoteReadResult {
    path: string
    revision: number
    characters: number
    suggestedCharacters: number
    dirty: boolean
    stale: boolean
    baseRevision: number | null
    exists: boolean
    /** Present only when the draft is dirty and stale; the same session directory as path. */
    currentPath?: string
    recovery?: NoteRecovery
}

export interface NoteWriteResult {
    path: string
    revision: number
    characters: number
    suggestedCharacters: number
    dirty: false
    stale: false
    changed: boolean
}

export interface Notes {
    path(sessionID: string): string
    read(sessionID: string): Promise<NoteReadResult>
    write(sessionID: string, reviewKey: string): Promise<NoteWriteResult>
    get(sessionID: string): Promise<NoteRecord | undefined>
    assertReviewed(sessionID: string, reviewKey: string): Promise<void>
}

interface DraftMetadata {
    version: number
    sessionID: string
    baseRevision: number
    baseHash: string
    projectDirectory: string
    updatedAt: number
}

interface SessionPaths {
    directory: string
    draft: string
    current: string
    metadata: string
}

/**
 * Creates the per-session note store. The formal note lives in host storage; the Markdown
 * draft lives under the OpenCode data directory (XDG_DATA_HOME or ~/.local/share) so it stays
 * stable when the workspace moves. `directory` is the host project path, recorded for
 * diagnostics only and never used to build a caller-supplied path.
 */
export function createNotes(storage: NotesStorage, directory: string): Notes {
    const root = join(resolveDataHome(), "opencode", "storage", "dcp-notes")
    let tempCounter = 0

    function pathsFor(sessionID: string): SessionPaths {
        const folder = sessionFolder(assertSessionID(sessionID))
        const sessionDirectory = join(root, folder)
        return {
            directory: sessionDirectory,
            draft: join(sessionDirectory, "note.md"),
            current: join(sessionDirectory, "current.md"),
            metadata: join(sessionDirectory, "note.meta.json"),
        }
    }

    function path(sessionID: string): string {
        return pathsFor(sessionID).draft
    }

    async function get(sessionID: string): Promise<NoteRecord | undefined> {
        const key = storageKey(assertSessionID(sessionID))
        return parseRecord(await storage.get(key))
    }

    async function read(sessionID: string): Promise<NoteReadResult> {
        const id = assertSessionID(sessionID)
        const paths = pathsFor(id)
        const note = await get(id)
        const formalContent = note?.content ?? ""
        const revision = note?.revision ?? 0
        const formalHash = hashContent(formalContent)
        const metadata = await readMetadata(paths.metadata, id)
        const draft = await ensureDraft(paths, formalContent)
        const sameAsFormal = draft === formalContent

        if (sameAsFormal) {
            // A clean draft is safe to rebase even when its sidecar is missing or old. Only
            // matching content can do this; a dirty stale draft is never overwritten.
            if (
                metadata === undefined ||
                metadata.baseRevision !== revision ||
                metadata.baseHash !== formalHash
            ) {
                await writeMetadata(
                    paths.metadata,
                    {
                        version: DRAFT_VERSION,
                        sessionID: id,
                        baseRevision: revision,
                        baseHash: formalHash,
                        projectDirectory: directory,
                        updatedAt: Date.now(),
                    },
                    tempCounter++,
                )
            }
            return {
                path: paths.draft,
                revision,
                characters: draft.length,
                suggestedCharacters: SUGGESTED_NOTE_CHARACTERS,
                dirty: false,
                stale: false,
                baseRevision: revision,
                exists: note !== undefined,
            }
        }

        const baseMatches =
            metadata !== undefined &&
            metadata.baseRevision === revision &&
            metadata.baseHash === formalHash
        const result: NoteReadResult = {
            path: paths.draft,
            revision,
            characters: draft.length,
            suggestedCharacters: SUGGESTED_NOTE_CHARACTERS,
            dirty: true,
            stale: !baseMatches,
            baseRevision: metadata?.baseRevision ?? null,
            exists: note !== undefined,
        }
        if (baseMatches) return result

        const currentPath = await refreshCurrent(paths.current, formalContent, tempCounter++)
        return {
            ...result,
            currentPath,
            recovery: {
                currentPath,
                instructions: staleRecoveryInstructions(revision, metadata?.baseRevision ?? null),
            },
        }
    }

    async function write(sessionID: string, reviewKey: string): Promise<NoteWriteResult> {
        const id = assertSessionID(sessionID)
        assertReviewKey(reviewKey)
        const paths = pathsFor(id)
        const note = await get(id)
        const draft = await readText(paths.draft)
        if (draft === undefined) {
            throw new Error(
                `DCP note draft not found at ${paths.draft}; read the note before committing.`,
            )
        }

        const formalContent = note?.content ?? ""
        const revision = note?.revision ?? 0
        const changed = draft !== formalContent
        if (changed) {
            const metadata = await readMetadata(paths.metadata, id)
            const baseMatches =
                metadata !== undefined &&
                metadata.baseRevision === revision &&
                metadata.baseHash === hashContent(formalContent)
            if (!baseMatches) {
                const basis =
                    metadata === undefined
                        ? "an unknown base revision"
                        : `revision ${metadata.baseRevision}`
                throw new Error(
                    `DCP note conflict: the draft at ${paths.draft} is based on ${basis}, but the stored note is revision ${revision}. The draft and stored note were left unchanged; re-read the note for the current.md recovery path and rewrite the draft before committing.`,
                )
            }
        }

        const nextRevision = note === undefined ? 1 : changed ? note.revision + 1 : note.revision
        const now = Date.now()
        const record: NoteRecord = {
            content: draft,
            revision: nextRevision,
            reviewKey,
            reviewedAt: now,
            updatedAt: now,
        }
        await storage.set(storageKey(id), record)
        try {
            await writeMetadata(
                paths.metadata,
                {
                    version: DRAFT_VERSION,
                    sessionID: id,
                    baseRevision: nextRevision,
                    baseHash: hashContent(draft),
                    projectDirectory: directory,
                    updatedAt: now,
                },
                tempCounter++,
            )
        } catch (error) {
            throw new Error(
                `DCP note was committed at revision ${nextRevision}, but its draft metadata at ${paths.metadata} could not be updated: ${errorMessage(error)}`,
            )
        }

        return {
            path: paths.draft,
            revision: nextRevision,
            characters: draft.length,
            suggestedCharacters: SUGGESTED_NOTE_CHARACTERS,
            dirty: false,
            stale: false,
            changed,
        }
    }

    async function assertReviewed(sessionID: string, reviewKey: string): Promise<void> {
        const id = assertSessionID(sessionID)
        assertReviewKey(reviewKey)
        const note = await get(id)
        if (note === undefined) {
            throw new Error(
                "DCP note review is required before this context reduction: this session has no stored note. Prepare a concise continuation checkpoint and commit once; unchanged or empty content is allowed when sufficient. Normal work does not require note maintenance.",
            )
        }
        if (note.reviewKey !== reviewKey) {
            throw new Error(
                "DCP note review is stale for this context reduction. Review the protected note and commit once, editing only facts needed after the selected history is removed. Unchanged content is allowed; normal work does not require note maintenance.",
            )
        }
        const actual = await readText(pathsFor(id).draft)
        if (actual !== undefined && actual !== note.content) {
            throw new Error(
                `DCP note review is blocked: the draft at ${pathsFor(id).draft} has uncommitted changes. Commit the draft or restore it to the stored note before compressing or releasing messages.`,
            )
        }
    }

    return { path, read, write, get, assertReviewed }
}

function resolveDataHome(): string {
    const configured = process.env.XDG_DATA_HOME?.trim()
    return configured !== undefined && configured.length > 0
        ? configured
        : join(homedir(), ".local", "share")
}

function storageKey(sessionID: string): string {
    return `${STORAGE_PREFIX}${sessionID}`
}

function assertSessionID(sessionID: string): string {
    if (
        typeof sessionID !== "string" ||
        sessionID.length === 0 ||
        sessionID.length > MAX_SESSION_ID_LENGTH
    ) {
        throw new Error("DCP note: invalid session ID.")
    }
    return sessionID
}

function sessionFolder(sessionID: string): string {
    // Hash the full ID so any session ID maps to a safe, stable directory name.
    const readable = sessionID.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 48)
    return `${readable}-${hashContent(sessionID).slice(0, 16)}`
}

function assertReviewKey(reviewKey: string): void {
    if (
        typeof reviewKey !== "string" ||
        reviewKey.length === 0 ||
        reviewKey.length > MAX_REVIEW_KEY_LENGTH
    ) {
        throw new Error("DCP note: review key must be a non-empty string.")
    }
}

function hashContent(content: string): string {
    return createHash("sha256").update(content, "utf8").digest("hex")
}

function parseRecord(value: unknown): NoteRecord | undefined {
    if (value === undefined) return undefined
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("DCP note record is corrupt: expected a JSON object.")
    }
    const record = value as Record<string, unknown>
    if (typeof record.content !== "string") {
        throw new Error("DCP note record is corrupt: content must be a string.")
    }
    if (!Number.isInteger(record.revision) || (record.revision as number) < 1) {
        throw new Error("DCP note record is corrupt: revision must be a positive integer.")
    }
    if (record.reviewKey !== undefined && typeof record.reviewKey !== "string") {
        throw new Error("DCP note record is corrupt: reviewKey must be a string.")
    }
    if (record.reviewedAt !== undefined && typeof record.reviewedAt !== "number") {
        throw new Error("DCP note record is corrupt: reviewedAt must be a number.")
    }
    if (record.updatedAt !== undefined && typeof record.updatedAt !== "number") {
        throw new Error("DCP note record is corrupt: updatedAt must be a number.")
    }
    return {
        content: record.content,
        revision: record.revision as number,
        reviewKey: record.reviewKey as string | undefined,
        reviewedAt: record.reviewedAt as number | undefined,
        updatedAt: (record.updatedAt as number | undefined) ?? 0,
    }
}

async function ensureDraft(paths: SessionPaths, content: string): Promise<string> {
    await mkdir(paths.directory, { recursive: true })
    const existing = await readText(paths.draft)
    if (existing !== undefined) return existing
    try {
        await writeFile(paths.draft, content, { encoding: "utf8", flag: "wx" })
        return content
    } catch (error) {
        // A different location may have created the canonical draft between read and write.
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
            const raced = await readText(paths.draft)
            if (raced !== undefined) return raced
        }
        throw error
    }
}

async function refreshCurrent(path: string, content: string, counter: number): Promise<string> {
    const temporary = `${path}.${process.pid}.${counter}.tmp`
    try {
        const existing = await readText(path)
        if (existing === content) return path
        await writeFile(temporary, content, "utf8")
        await rename(temporary, path)
        return path
    } catch (error) {
        await rm(temporary, { force: true }).catch(() => {})
        throw new Error(
            `DCP note recovery file at ${path} could not be refreshed; the draft was left unchanged: ${errorMessage(error)}`,
        )
    }
}

function staleRecoveryInstructions(revision: number, baseRevision: number | null): string {
    const basis = baseRevision === null ? "an unknown older revision" : `revision ${baseRevision}`
    return `Dirty stale draft: note.md is based on ${basis}, but the stored note is revision ${revision}. current.md contains the current stored note (revision ${revision}). Use your existing read/grep/patch tools to compare note.md and current.md and preserve useful draft edits. Do not edit current.md. To recover: rewrite note.md to match current.md, run dcp_note read so the clean draft rebases, then apply the merged edits to note.md and commit. A dirty draft is never rebased automatically.`
}

async function readMetadata(path: string, sessionID: string): Promise<DraftMetadata | undefined> {
    const text = await readText(path)
    if (text === undefined) return undefined
    try {
        const value = JSON.parse(text) as Partial<DraftMetadata>
        if (
            value.version === DRAFT_VERSION &&
            value.sessionID === sessionID &&
            typeof value.baseRevision === "number" &&
            Number.isInteger(value.baseRevision) &&
            value.baseRevision >= 0 &&
            typeof value.baseHash === "string" &&
            typeof value.projectDirectory === "string" &&
            typeof value.updatedAt === "number"
        ) {
            return value as DraftMetadata
        }
    } catch {
        // The sidecar is a cache of the draft baseline; the database is the truth. Treat a
        // corrupt sidecar like a missing one so a matching draft can be rebased and a dirty
        // draft still becomes an explicit stale conflict.
    }
    return undefined
}

async function writeMetadata(
    path: string,
    metadata: DraftMetadata,
    counter: number,
): Promise<void> {
    const temporary = `${path}.${process.pid}.${counter}.tmp`
    try {
        await writeFile(temporary, JSON.stringify(metadata, null, 2), "utf8")
        await rename(temporary, path)
    } catch (error) {
        await rm(temporary, { force: true }).catch(() => {})
        throw error
    }
}

async function readText(path: string): Promise<string | undefined> {
    try {
        return await readFile(path, "utf8")
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
        throw error
    }
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}
