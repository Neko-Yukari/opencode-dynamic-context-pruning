import { createHash } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import * as imageSize from "image-size"
import { mapMedia, type MediaSource } from "../media"
import type { SummaryImage } from "./types"

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
    private assets = new Map<string, SummaryImage & { bytes?: Buffer; referenceOnly: boolean }>()

    transform(value: unknown): unknown {
        return mapMedia(value, (source) => this.reference(source))
    }

    private reference({ uri, mime, embedded }: MediaSource): string {
        const previous = this.assets.get(uri)
        if (previous) {
            if (!embedded) previous.referenceOnly = false
            return previous.ref
        }
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
        // Text can quote documentation URLs or obsolete paths. Only carried inline
        // bytes or actual attachment parts supply images for inference.
        this.assets.set(uri, { ref, mime, uri, bytes, referenceOnly: embedded === true })
        return ref
    }

    images(): SummaryImage[] {
        return [...new Map([...this.assets.values()].map((asset) => [asset.ref, asset])).values()]
            .filter((asset) => {
                if (asset.referenceOnly) return false
                if (!asset.mime.startsWith("image/")) return false
                if (!asset.bytes) return true
                const { width, height } = imageSize.imageSize(asset.bytes)
                return width > 0 && height > 0
            })
            .map(({ ref, mime, uri }) => ({ ref, mime, uri }))
    }

    async save(): Promise<void> {
        for (const { ref, bytes } of this.assets.values()) {
            if (!bytes) continue
            await mkdir(join(ref, ".."), { recursive: true, mode: 0o700 })
            await writeFile(ref, bytes, { mode: 0o600 })
        }
    }

    appendReferences(summary: string, inspected: boolean): string {
        if (!this.assets.size) return summary
        const refs = [
            ...new Map([...this.assets.values()].map((asset) => [asset.ref, asset])).values(),
        ]
        return (
            summary +
            "\n\nMedia references retained (" +
            (inspected
                ? "images supplied to summarizer; other attachments reference-only"
                : "reference-only; visual contents were not inspected by the summarizer") +
            "):\n" +
            refs.map(({ ref, mime }) => `- ${mime}: ${JSON.stringify(ref)}`).join("\n")
        )
    }
}
