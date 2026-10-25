import type { CompressionBlock, SessionState } from "../state"
import { resolveAnchorMessageId, resolveBoundaryIds, resolveSelection } from "./search"
import type { IdFormat } from "../message-ids"
import type {
    BoundaryReference,
    CompressRangeArgsInput,
    CompressRangeToolArgs,
    InjectedSummaryResult,
    ParsedBlockPlaceholder,
    ResolvedRangeCompression,
    SearchContext,
} from "./types"

const BLOCK_PLACEHOLDER_REGEX = /\(b(\d+)\)|\{block_(\d+)\}/gi

export function validateSelectionArgs(args: {
    topic?: string
    content?: Array<{ startId?: string; endId?: string }>
}): void {
    if (typeof args.topic !== "string" || args.topic.trim().length === 0) {
        throw new Error("topic is required and must be a non-empty string")
    }

    if (!Array.isArray(args.content) || args.content.length === 0) {
        throw new Error("content is required and must be a non-empty array")
    }

    for (let index = 0; index < args.content.length; index++) {
        const entry = args.content[index]
        const prefix = `content[${index}]`

        if (typeof entry?.startId !== "string" || entry.startId.trim().length === 0) {
            throw new Error(`${prefix}.startId is required and must be a non-empty string`)
        }

        if (typeof entry?.endId !== "string" || entry.endId.trim().length === 0) {
            throw new Error(`${prefix}.endId is required and must be a non-empty string`)
        }
    }
}

export function validateArgs(args: CompressRangeToolArgs): void {
    validateSelectionArgs(args)

    for (let index = 0; index < args.content.length; index++) {
        const entry = args.content[index]
        const prefix = `content[${index}]`

        if (typeof entry?.summary !== "string" || entry.summary.trim().length === 0) {
            throw new Error(`${prefix}.summary is required and must be a non-empty string`)
        }
    }
}

export function resolveRanges(
    args: CompressRangeArgsInput,
    searchContext: SearchContext,
    state: SessionState,
): ResolvedRangeCompression[] {
    return args.content.map((entry, index) => {
        const normalizedEntry = {
            startId: entry.startId.trim(),
            endId: entry.endId.trim(),
            summary: entry.summary ?? "",
        }

        const { startReference, endReference } = resolveBoundaryIds(
            searchContext,
            state,
            normalizedEntry.startId,
            normalizedEntry.endId,
        )
        const selection = resolveSelection(searchContext, startReference, endReference)

        return {
            index,
            entry: normalizedEntry,
            selection,
            anchorMessageId: resolveAnchorMessageId(startReference),
        }
    })
}

export function validateNonOverlapping(plans: ResolvedRangeCompression[]): void {
    const sortedPlans = [...plans].sort(
        (left, right) =>
            left.selection.startReference.rawIndex - right.selection.startReference.rawIndex ||
            left.selection.endReference.rawIndex - right.selection.endReference.rawIndex ||
            left.index - right.index,
    )

    const issues: string[] = []

    for (let index = 1; index < sortedPlans.length; index++) {
        const previous = sortedPlans[index - 1]
        const current = sortedPlans[index]

        if (current.selection.startReference.rawIndex > previous.selection.endReference.rawIndex) {
            continue
        }

        issues.push(
            `content[${previous.index}] (${previous.entry.startId}..${previous.entry.endId}) overlaps content[${current.index}] (${current.entry.startId}..${current.entry.endId}). Overlapping ranges cannot be compressed in the same batch.`,
        )
    }

    if (issues.length > 0) {
        throw new Error(
            issues.length === 1 ? issues[0] : issues.map((issue) => `- ${issue}`).join("\n"),
        )
    }
}

export function parseBlockPlaceholders(
    summary: string,
    format: IdFormat = "xml",
): ParsedBlockPlaceholder[] {
    const placeholders: ParsedBlockPlaceholder[] = []
    const regex = format === "compact" ? /@b([1-9]\d*)@/gi : new RegExp(BLOCK_PLACEHOLDER_REGEX)

    let match: RegExpExecArray | null
    while ((match = regex.exec(summary)) !== null) {
        const full = match[0]
        const blockIdPart = match[1] || match[2]
        const parsed = Number.parseInt(blockIdPart, 10)

        placeholders.push({
            raw: full,
            blockId: parsed,
            startIndex: match.index,
            endIndex: match.index + full.length,
        })
    }

    return placeholders
}

// Selected blocks are rewritten, not expanded: drop model-emitted placeholders so
// no stale block body or dangling marker survives into the new summary.
export function stripBlockPlaceholders(
    summary: string,
    placeholders: ParsedBlockPlaceholder[],
): string {
    let result = ""
    let cursor = 0
    for (const placeholder of placeholders) {
        result += summary.slice(cursor, placeholder.startIndex)
        cursor = placeholder.endIndex
    }
    result += summary.slice(cursor)
    return result.replace(/[ \t]+\n/g, "\n").trim()
}
