import childProcess from "node:child_process"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { existsSync } from "node:fs"
import { join, resolve } from "node:path"
import { sourceText, type OriginalRecord } from "./readback-sgrep"

function binaryName() {
    return process.platform === "win32" ? "rg.exe" : "rg"
}

function resolveRgBinary(): string {
    const suffix = process.platform === "win32" ? ".exe" : ""
    const explicit = process.env.DCP_RG_BIN
    if (explicit) return explicit
    const bins = [
        join(homedir(), ".cache", "opencode", "bin"),
        join(homedir(), ".local", "share", "opencode", "bin"),
        join(homedir(), ".cargo", "bin"),
        join(homedir(), ".local", "bin"),
    ]
    return bins.map((dir) => join(dir, `rg${suffix}`)).find(existsSync) ?? binaryName()
}

export async function searchWithRg(
    records: OriginalRecord[],
    query: string,
    limit: number,
    caseSensitive: boolean,
    signal?: AbortSignal,
) {
    if (records.length === 0) return []
    signal?.throwIfAborted()
    const directory = await mkdtemp(join(tmpdir(), "dcp-rg-"))
    try {
        const sources = new Map<string, { record: OriginalRecord; lines: string[] }>()
        for (const [index, record] of records.entries()) {
            signal?.throwIfAborted()
            const file = join(directory, `source-${index}.txt`)
            const text = sourceText(record)
            await writeFile(file, text, { mode: 0o600 })
            sources.set(resolve(file), { record, lines: text.split("\n") })
        }
        const output = await new Promise<string>((accept, reject) => {
            childProcess.execFile(
                resolveRgBinary(),
                [
                    "--json",
                    "--line-number",
                    "--no-heading",
                    "--color",
                    "never",
                    "--max-count",
                    String(limit),
                    ...(caseSensitive ? [] : ["-i"]),
                    "--",
                    query,
                    ".",
                ],
                {
                    cwd: directory,
                    signal,
                    timeout: 30_000,
                    maxBuffer: 4 * 1024 * 1024,
                    encoding: "utf8",
                    windowsHide: true,
                },
                (error, stdout) => {
                    if (error) {
                        if (error.code === 1) return accept("")
                        return reject(
                            new Error(
                                `DCP rg search failed (${error.code ?? "process error"}). Check DCP_RG_BIN or PATH. No semantic fallback was used.`,
                            ),
                        )
                    }
                    accept(stdout)
                },
            )
        })
        signal?.throwIfAborted()
        const hits: Array<{
            path: string
            line: number
            text: string
        }> = []
        for (const line of output.split(/\r?\n/)) {
            if (!line.trim()) continue
            let event: unknown
            try {
                event = JSON.parse(line)
            } catch {
                throw new Error("DCP rg returned invalid JSON results")
            }
            if (!event || typeof event !== "object") continue
            const value = event as { type?: unknown; data?: Record<string, unknown> }
            if (value.type !== "match" || !value.data) continue
            const pathValue = value.data.path
            const path =
                typeof pathValue === "string"
                    ? pathValue
                    : pathValue && typeof pathValue === "object" && "text" in pathValue
                      ? (pathValue as { text?: unknown }).text
                      : undefined
            const lineNumber = value.data.line_number
            if (
                typeof path !== "string" ||
                typeof lineNumber !== "number" ||
                !Number.isSafeInteger(lineNumber) ||
                lineNumber < 1
            )
                throw new Error("DCP rg returned an invalid match")
            const source = sources.get(resolve(directory, path))
            if (!source || lineNumber > source.lines.length)
                throw new Error("DCP rg returned a source outside the selected originals")
            hits.push({
                path,
                line: lineNumber,
                text: source.lines[lineNumber - 1]!.slice(0, 640),
            })
            if (hits.length >= limit) break
        }
        return hits.map((hit) => {
            const source = sources.get(resolve(directory, hit.path))!
            return {
                sourceId: source.record.sourceId,
                ref: source.record.ref,
                role: source.record.role,
                lineStart: hit.line,
                lineEnd: hit.line,
                text: hit.text,
            }
        })
    } finally {
        await rm(directory, { recursive: true, force: true })
    }
}
