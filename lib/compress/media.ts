import { createHash } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { mapMedia, type MediaSource } from "../media"

const extensions: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/bmp": "bmp",
    "image/svg+xml": "svg",
    "application/pdf": "pdf",
}

export class CompressionMedia {
    private assets = new Map<string, MediaSource & { ref: string; bytes?: Buffer }>()

    transform(value: unknown): unknown {
        return mapMedia(value, (source) => this.reference(source))
    }

    private reference({ uri, mime }: MediaSource): string {
        const previous = this.assets.get(uri)
        if (previous) return previous.ref
        let ref = uri
        let bytes: Buffer | undefined
        if (/^data:/i.test(uri)) {
            const match =
                /^data:([^;,]+)(?:;[\w.+-]+=[^;,\s]+)*;base64,([A-Za-z0-9+/]*={0,2})$/i.exec(uri)
            if (!match) throw new Error("DCP invalid inline media; original context retained")
            mime = match[1]!.toLowerCase()
            bytes = Buffer.from(match[2]!, "base64")
            if (
                !bytes.length ||
                bytes.toString("base64").replace(/=+$/, "") !== match[2]!.replace(/=+$/, "")
            )
                throw new Error("DCP invalid media encoding; original context retained")
            const digest = createHash("sha256").update(bytes).digest("hex")
            ref = join(
                process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"),
                "opencode",
                "storage",
                "plugin",
                "dcp",
                "media",
                `${digest}.${extensions[mime] ?? "bin"}`,
            )
        }
        if (!ref)
            throw new Error("DCP media has no retrievable reference; original context retained")
        this.assets.set(uri, { ref, mime, uri, bytes })
        return ref
    }

    async save(): Promise<void> {
        for (const { ref, bytes } of this.assets.values()) {
            if (!bytes) continue
            await mkdir(join(ref, ".."), { recursive: true, mode: 0o700 })
            await writeFile(ref, bytes, { mode: 0o600 })
        }
    }

    appendReferences(summary: string): string {
        if (!this.assets.size) return summary
        const refs = [
            ...new Map([...this.assets.values()].map((asset) => [asset.ref, asset])).values(),
        ]
        return (
            summary +
            "\n\nAttachment references retained (reference-only; contents were not inspected by the summarizer):\n" +
            refs.map(({ ref, mime }) => `- ${mime}: ${JSON.stringify(ref)}`).join("\n")
        )
    }
}
