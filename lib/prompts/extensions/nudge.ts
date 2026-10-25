import type { SessionState } from "../../state"
import { formatBlockRef } from "../../message-ids"

export function buildCompressedBlockGuidance(state: SessionState, configured = false): string {
    const refs = Array.from(state.prune.messages.activeBlockIds)
        .filter((id) => state.prune.messages.blocksById.get(id)?.released !== true)
        .filter((id) => Number.isInteger(id) && id > 0)
        .sort((a, b) => a - b)
        .map((id) => formatBlockRef(id, state.idFormat))
    const releasedCount = Array.from(state.prune.messages.activeBlockIds).filter(
        (id) =>
            Number.isInteger(id) &&
            id > 0 &&
            state.prune.messages.blocksById.get(id)?.released === true,
    ).length
    const blockCount = refs.length
    const blockList = blockCount > 0 ? refs.join(", ") : "none"
    const releasedLine =
        releasedCount > 0 ? [`- Released ranges (hidden, no summary): ${releasedCount}`] : []

    return [
        "Compressed block context:",
        `- Active compressed blocks in this session: ${blockCount} (${blockList}${releasedCount > 0 ? "; summary-bearing only" : ""})`,
        ...releasedLine,
        "- If a completed block is no longer needed at all, dcp_release removes it from context one-way; inspect it first with dcp_read, since release cannot be undone.",
        configured
            ? "- Existing blocks listed above are preserved by the configured summarizer when a selected range includes them; you do not insert or pass placeholder text."
            : `- If your selected compression range includes any listed block, include each required placeholder exactly once in the summary using \`${state.idFormat === "compact" ? "@b1@" : "(bN)"}\`.`,
    ].join("\n")
}

export function renderMessagePriorityGuidance(priorityLabel: string, refs: string[]): string {
    const refList = refs.length > 0 ? refs.join(", ") : "none"

    return [
        "Message priority context:",
        "- Higher-priority older messages consume more context and should be compressed right away if it is safe to do so.",
        `- ${priorityLabel}-priority message IDs before this point: ${refList}`,
    ].join("\n")
}

export function appendGuidanceToDcpTag(nudgeText: string, guidance: string): string {
    if (!guidance.trim()) {
        return nudgeText
    }

    const closeTag = "</dcp-system-reminder>"
    const closeTagIndex = nudgeText.lastIndexOf(closeTag)

    if (closeTagIndex === -1) {
        return nudgeText
    }

    const beforeClose = nudgeText.slice(0, closeTagIndex).trimEnd()
    const afterClose = nudgeText.slice(closeTagIndex)
    return `${beforeClose}\n\n${guidance}\n${afterClose}`
}
