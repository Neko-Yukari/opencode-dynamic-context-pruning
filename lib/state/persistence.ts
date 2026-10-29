/**
 * State persistence module for DCP plugin.
 * Persists pruned tool IDs across sessions so they survive OpenCode restarts.
 * Storage location: ~/.local/share/opencode/storage/plugin/dcp/{sessionId}.json
 */

import * as fs from "fs/promises"
import { existsSync } from "fs"
import { homedir } from "os"
import { join } from "path"
import type {
    CompressionBlock,
    PreparedAutoFold,
    PrunedMessageEntry,
    SessionState,
    SessionStats,
} from "./types"
import type { Logger } from "../logger"
import { serializePruneMessagesState, serializeMessageIdState } from "./utils"
import type { PersistedMessageIdState } from "./utils"
export type { PersistedMessageIdState } from "./utils"

/** Prune state as stored on disk */
export interface PersistedPruneMessagesState {
    byMessageId: Record<string, PrunedMessageEntry>
    blocksById: Record<string, CompressionBlock>
    activeBlockIds: number[]
    activeByAnchorMessageId: Record<string, number>
    nextBlockId: number
    nextRunId: number
}

export interface PersistedPrune {
    tools?: Record<string, number>
    messages?: PersistedPruneMessagesState
}

export interface PersistedNudges {
    contextLimitAnchors: string[]
    turnNudgeAnchors?: string[]
    iterationNudgeAnchors?: string[]
}

export interface PersistedSessionState {
    sessionName?: string
    manualMode?: boolean
    prune: PersistedPrune
    nudges: PersistedNudges
    stats: SessionStats
    lastUpdated: string
    // Optional so older files keep loading.
    messageIds?: PersistedMessageIdState
    lastCompaction?: number
    /** Summarized auto-fold waiting for the next request after a restart. */
    autoFold?: PreparedAutoFold | null
}

const STORAGE_DIR = join(
    process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"),
    "opencode",
    "storage",
    "plugin",
    "dcp",
)

async function ensureStorageDir(): Promise<void> {
    await fs.mkdir(STORAGE_DIR, { recursive: true })
}

function getSessionFilePath(sessionId: string): string {
    return join(STORAGE_DIR, `${sessionId}.json`)
}

async function writePersistedSessionState(
    sessionId: string,
    state: PersistedSessionState,
    logger: Logger,
): Promise<void> {
    await ensureStorageDir()

    const filePath = getSessionFilePath(sessionId)
    const content = JSON.stringify(state, null, 2)
    const temporary = `${filePath}.${process.pid}.tmp`
    try {
        await fs.writeFile(temporary, content, "utf-8")
        await fs.rename(temporary, filePath)
    } finally {
        await fs.rm(temporary, { force: true })
    }

    logger.info("Saved session state to disk", {
        sessionId,
        totalTokensSaved: state.stats.totalPruneTokens,
    })
}

export async function saveSessionState(
    sessionState: SessionState,
    logger: Logger,
    sessionName?: string,
): Promise<void> {
    if (!sessionState.sessionId) return
    const state: PersistedSessionState = {
        sessionName: sessionName,
        manualMode: !!sessionState.manualMode,
        prune: {
            tools: Object.fromEntries(sessionState.prune.tools),
            messages: serializePruneMessagesState(sessionState.prune.messages),
        },
        nudges: {
            contextLimitAnchors: Array.from(sessionState.nudges.contextLimitAnchors),
            turnNudgeAnchors: Array.from(sessionState.nudges.turnNudgeAnchors),
            iterationNudgeAnchors: Array.from(sessionState.nudges.iterationNudgeAnchors),
        },
        stats: sessionState.stats,
        messageIds: serializeMessageIdState(sessionState),
        lastCompaction: sessionState.lastCompaction,
        autoFold: sessionState.preparedAutoFold ?? null,
        lastUpdated: new Date().toISOString(),
    }
    await writePersistedSessionState(sessionState.sessionId, state, logger)
}

export async function loadSessionState(
    sessionId: string,
    logger: Logger,
): Promise<PersistedSessionState | null> {
    const filePath = getSessionFilePath(sessionId)
    if (!existsSync(filePath)) return null
    const state = JSON.parse(await fs.readFile(filePath, "utf-8")) as PersistedSessionState
    logger.info("Loaded session state from disk", { sessionId })
    return state
}

function emptyPersistedState(manualMode: boolean): PersistedSessionState {
    return {
        manualMode,
        prune: {
            tools: {},
            messages: {
                byMessageId: {},
                blocksById: {},
                activeBlockIds: [],
                activeByAnchorMessageId: {},
                nextBlockId: 1,
                nextRunId: 1,
            },
        },
        nudges: {
            contextLimitAnchors: [],
            turnNudgeAnchors: [],
            iterationNudgeAnchors: [],
        },
        stats: {
            pruneTokenCounter: 0,
            totalPruneTokens: 0,
        },
        lastUpdated: new Date().toISOString(),
    }
}

export async function loadManualModeSetting(
    sessionId: string,
    logger: Logger,
): Promise<boolean | undefined> {
    const state = await loadSessionState(sessionId, logger)
    return state?.manualMode
}

export async function saveManualModeSetting(
    sessionId: string,
    manualMode: boolean,
    logger: Logger,
): Promise<void> {
    const existing = await loadSessionState(sessionId, logger)
    const state = existing ?? emptyPersistedState(manualMode)
    state.manualMode = manualMode
    state.lastUpdated = new Date().toISOString()
    await writePersistedSessionState(sessionId, state, logger)
}

export interface AggregatedStats {
    totalTokens: number
    totalTools: number
    totalMessages: number
    sessionCount: number
}

export async function loadAllSessionStats(logger: Logger): Promise<AggregatedStats> {
    const result: AggregatedStats = {
        totalTokens: 0,
        totalTools: 0,
        totalMessages: 0,
        sessionCount: 0,
    }

    if (!existsSync(STORAGE_DIR)) return result
    const files = await fs.readdir(STORAGE_DIR)
    for (const file of files.filter((name) => name.endsWith(".json"))) {
        const state = JSON.parse(
            await fs.readFile(join(STORAGE_DIR, file), "utf-8"),
        ) as PersistedSessionState
        if (state.stats.totalPruneTokens) {
            result.totalTokens += state.stats.totalPruneTokens
            result.totalTools += state.prune.tools ? Object.keys(state.prune.tools).length : 0
            result.totalMessages += state.prune.messages?.byMessageId
                ? Object.keys(state.prune.messages.byMessageId).length
                : 0
            result.sessionCount++
        }
    }
    logger.debug("Loaded all-time stats", result)
    return result
}
