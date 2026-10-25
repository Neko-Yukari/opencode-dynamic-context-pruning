import { randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import * as imageSize from "image-size"
import type { Plugin } from "@opencode/plugin"
import type { Media } from "@opencode/ai/media"
import type { ContentPart } from "@opencode/ai/schema/messages"
import type { ToolContext } from "../compress/types"
import { SummaryFailure } from "../compress/errors"

function modelRef(model: { providerID: string; id: string; variant?: string }) {
    return `${model.providerID}/${model.id}${model.variant ? `#${model.variant}` : ""}`.replace(
        /\|/g,
        "_",
    )
}

type ContextMessage = { readonly role: string; readonly content: ReadonlyArray<ContentPart> }

// Retries and RecoverFull rebuild the same request until an assistant reply has
// output; the failed empty assistant is dropped, so the rendered context must
// match the first attempt exactly. Continuations append an assistant or synthetic
// user turn and therefore differ here. Media is compared by real inline mime and
// base64: stringifying the Asset class would serialize empty objects.
function contextBaseline(messages: ReadonlyArray<ContextMessage>): string[] {
    return messages.map((message) =>
        JSON.stringify([
            message.role,
            ...message.content.map((part) => {
                if (part.type === "text") return ["text", part.text]
                if (part.type === "media") {
                    const inline = part.media.inline()
                    if (!inline)
                        throw new Error(
                            "DCP image dimensions unavailable; original context retained",
                        )
                    return ["media", inline.mime, inline.base64]
                }
                return [part.type]
            }),
        ]),
    )
}

function sameContext(baseline: string[], current: string[]) {
    return (
        baseline.length === current.length &&
        baseline.every((message, index) => message === current[index])
    )
}

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
            const budget = input.imageBudget
            if (!budget) throw new Error("DCP image summarizer requires the internal image budget")
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
            let calls = 0
            let baseline: string[] | undefined
            let imageTokens = 0
            let failure: SummaryFailure | undefined
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
                    if (
                        event.model.providerID !== input.model.providerID ||
                        event.model.id !== input.model.id ||
                        (input.model.variant !== undefined &&
                            event.model.variant !== input.model.variant)
                    ) {
                        failure = new SummaryFailure(
                            "model_mismatch",
                            `expected=${modelRef(input.model)} actual=${modelRef(event.model)}; original context retained; do not write a summary yourself`,
                        )
                        throw failure
                    }
                    calls += 1
                    const current = contextBaseline(event.messages)
                    if (baseline === undefined) baseline = current
                    else if (!sameContext(baseline, current)) {
                        failure = new SummaryFailure(
                            "unexpected_turn",
                            `calls=${calls} request content changed; original context retained; do not write a summary yourself`,
                        )
                        throw failure
                    }
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
                    if (seeds.length !== 1)
                        throw new Error("DCP native session did not load the image seed")
                    // Importing another copy of @opencode/ai fails the host's
                    // instanceof schema. Use its supplied instance's public constructor.
                    const Asset = seeds[0]!.media.constructor as new (
                        input: Media.Asset.Input,
                    ) => Media.Asset
                    const images: ContentPart[] = sources.map((source) => ({
                        type: "media",
                        media: new Asset(source),
                    }))
                    imageTokens = estimateImageTokens(images)
                    // The host may delete maxTokens (its own provider contract) and may
                    // also cap output because reasoning shares that window. Without a
                    // numeric cap, reserve the full model output and add no field; with
                    // one, keep the smallest of cap, model limit and remaining window.
                    const hostLimit = event.options.maxTokens
                    const remaining = budget.context - budget.input - imageTokens
                    const outputLimit = Math.min(
                        budget.output,
                        hostLimit ?? budget.output,
                        remaining,
                    )
                    if (
                        !Number.isSafeInteger(outputLimit) ||
                        outputLimit < budget.summary ||
                        (hostLimit === undefined && remaining < budget.output)
                    ) {
                        failure = new SummaryFailure(
                            "image_budget",
                            `text=${budget.input} image=${imageTokens} summaryOutputReserve=${budget.summary} safeLimit=${budget.context}; select a smaller closed range and retry; original context retained; do not write a summary yourself`,
                        )
                        throw failure
                    }
                    if (hostLimit !== undefined)
                        event.options = { ...event.options, maxTokens: outputLimit }
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
                    if (
                        calls < 1 ||
                        !response ||
                        assistants.some((entry) =>
                            entry.content.some((part) => part.type === "tool"),
                        ) ||
                        entries.some(
                            (entry) => entry.type === "idle" && entry.outcome !== "succeeded",
                        )
                    )
                        throw new Error(
                            "DCP native image summarizer did not complete a tool-free response",
                        )
                    return { text, imageTokens }
                } catch (error) {
                    // The host may report a hook failure later as a generic session
                    // error; keep our own guarded diagnostic instead.
                    if (signal.aborted) throw signal.reason
                    if (failure) throw failure
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

// Native attachment loading has decoded the image before this hook. Estimate
// from actual dimensions, not compressed byte size; keep a generous margin for
// different providers' patch/tile tokenizers. This is a guard, not a billing count.
export function estimateImageTokens(parts: ContentPart[]): number {
    let total = 0
    for (const part of parts) {
        if (part.type !== "media") continue
        const inline = part.media.inline()
        if (!inline) throw new Error("DCP image dimensions unavailable; original context retained")
        const { width, height } = imageSize.imageSize(Buffer.from(inline.base64, "base64"))
        if (!(width > 0 && height > 0))
            throw new Error("DCP image dimensions unavailable; original context retained")
        total += Math.ceil(width / 16) * Math.ceil(height / 16) * 4 + 1024
    }
    return total
}
