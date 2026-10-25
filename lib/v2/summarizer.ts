import { randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import * as imageSize from "image-size"
import type { Plugin } from "@opencode/plugin"
import type { Media } from "@opencode/ai/media"
import type { ContentPart } from "@opencode/ai/schema/messages"
import type { ToolContext } from "../compress/types"
import { SummaryFailure } from "../compress/errors"

// session.prompt materializes even file: attachments before persisting and
// broadcasting them. Admit only this 1px seed to obtain the host's Asset class;
// original images are attached exclusively to the transient inference request.
const seedImage =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
// OpenCode 2.1 trims inline images above this request total after context hooks.
// Reject first so a summary cannot claim to have inspected silently removed images.
const hostImageBytesLimit = 25 * 1024 * 1024

export function createSummarizer(ctx: Plugin.Context): NonNullable<ToolContext["summarizer"]> {
    return {
        models: async (signal) => (await ctx.model.list(undefined, { signal })).data,
        generate: async (input, signal) => {
            if (!input.images?.length) return ctx.generate.text(input, { signal })
            signal.throwIfAborted()
            const sources = await Promise.all(
                input.images.map(async (image) => {
                    // Inline originals were saved by CompressionMedia. Preserve the
                    // host attachment contract for other sources: file: URIs only.
                    if (!/^data:/i.test(image.uri) && !/^file:/i.test(image.uri))
                        throw new Error("DCP image source must be inline or a file URI")
                    const data = await readFile(
                        /^data:/i.test(image.uri) ? image.ref : new URL(image.uri),
                        { signal },
                    )
                    const detected =
                        image.mime === "image/*" ? imageSize.imageSize(data).type : undefined
                    const mediaType = detected
                        ? `image/${detected === "jpg" ? "jpeg" : detected === "svg" ? "svg+xml" : detected}`
                        : image.mime
                    return { source: { type: "bytes" as const, data, mediaType } }
                }),
            )
            const imageBytes = sources.reduce(
                (total, asset) => total + Math.ceil(asset.source.data.byteLength / 3) * 4,
                0,
            )
            if (imageBytes > hostImageBytesLimit)
                throw new SummaryFailure(
                    "image_budget",
                    `imageBytes=${imageBytes} safeLimit=${hostImageBytesLimit}; select a smaller closed range and retry; original context retained; do not write a summary yourself`,
                )
            const capacity = input.capacity!
            const imageTokens = sources.reduce((total, asset) => {
                const { width, height } = imageSize.imageSize(asset.source.data)
                return total + Math.ceil(width / 16) * Math.ceil(height / 16) * 4 + 1024
            }, 0)
            const replyTokens = Math.min(capacity.recommendation, capacity.outputLimit)
            if (capacity.promptTokens + imageTokens + replyTokens > capacity.contextWindow)
                throw new SummaryFailure(
                    "image_budget",
                    `input=${capacity.promptTokens} image=${imageTokens} reply=${replyTokens} context=${capacity.contextWindow}; select a smaller closed range; original context retained; do not write a summary yourself`,
                )
            signal.throwIfAborted()
            const marker = `DCP_MEDIA_${randomUUID()}`
            const session = await ctx.session.create(
                {
                    title: "DCP image summarizer",
                    model: input.model,
                    permissions: [{ action: "*", resource: "*", effect: "deny" }],
                },
                { signal },
            )
            let registration: { dispose(): Promise<void> } | undefined
            let interrupted: Promise<unknown> | undefined
            const abort = () => {
                interrupted = ctx.session.interrupt({ sessionID: session.id })
                // Consume an early rejection until finally awaits cleanup.
                void interrupted.catch(() => {})
            }
            signal.addEventListener("abort", abort, { once: true })
            try {
                registration = await ctx.session.hook("context", (event) => {
                    if (event.sessionID !== session.id) return
                    const seeds = event.messages
                        .filter(
                            (message) =>
                                message.role === "user" &&
                                message.content.some(
                                    (part) => part.type === "text" && part.text.includes(marker),
                                ),
                        )
                        .flatMap((message) =>
                            message.content.filter((part) => part.type === "media"),
                        )
                    const seed = seeds[0]
                    if (!seed) throw new Error("DCP native session did not load the image seed")
                    // Importing another copy of @opencode/ai fails the host's
                    // instanceof schema. Use its supplied instance's public constructor.
                    const Asset = seed.media.constructor as new (
                        input: Media.Asset.Input,
                    ) => Media.Asset
                    const images: ContentPart[] = sources.map((source) => ({
                        type: "media",
                        media: new Asset(source),
                    }))
                    // Cap only a host-supplied maxTokens by the real remaining window;
                    // absent stays absent and other host options are untouched.
                    const hostLimit = event.options.maxTokens
                    if (hostLimit !== undefined) {
                        const remaining =
                            capacity.contextWindow - capacity.promptTokens - imageTokens
                        event.options = {
                            ...event.options,
                            maxTokens: Math.min(hostLimit, remaining),
                        }
                    }
                    event.system = []
                    event.tools = {}
                    event.messages = [
                        {
                            role: "user",
                            content: [
                                { type: "text", text: input.prompt },
                                ...images.flatMap((part, index) => [
                                    {
                                        type: "text" as const,
                                        text: `Image reference: ${input.images![index]!.ref}`,
                                    },
                                    part,
                                ]),
                            ],
                        },
                    ]
                })
                signal.throwIfAborted()
                try {
                    await ctx.session.prompt(
                        {
                            sessionID: session.id,
                            text: marker,
                            files: [{ uri: seedImage, description: "DCP inference image seed" }],
                            resume: true,
                        },
                        { signal },
                    )
                    await ctx.session.wait({ sessionID: session.id }, { signal })
                    signal.throwIfAborted()
                    const entries = await ctx.session.context({ sessionID: session.id }, { signal })
                    const failed = entries.findLast(
                        (entry) => entry.type === "idle" && entry.outcome === "failed",
                    )
                    if (failed?.type === "idle" && failed.error)
                        throw Object.assign(new Error(failed.error.message), failed.error)
                    const assistants = entries.filter((entry) => entry.type === "assistant")
                    // A failed attempt leaves an assistant without parts; only the last
                    // assistant that actually has body text is the summary response.
                    const response = assistants
                        .filter((entry) =>
                            entry.content.some((part) => part.type === "text" && part.text.trim()),
                        )
                        .at(-1)
                    const text = (response?.content ?? [])
                        .flatMap((part) => (part.type === "text" ? [part.text] : []))
                        .join("")
                    if (!response)
                        throw new Error("DCP native image summarizer returned no response")
                    return { text }
                } catch (error) {
                    if (signal.aborted) throw signal.reason
                    throw error
                }
            } finally {
                signal.removeEventListener("abort", abort)
                try {
                    await interrupted
                    await ctx.session.interrupt({ sessionID: session.id })
                } finally {
                    try {
                        await registration?.dispose()
                    } finally {
                        await ctx.session.remove({ sessionID: session.id })
                    }
                }
            }
        },
    }
}
