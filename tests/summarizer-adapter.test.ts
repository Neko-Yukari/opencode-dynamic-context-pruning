import assert from "node:assert/strict"
import test, { after } from "node:test"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { Media } from "@opencode/ai/media"
import type { Plugin } from "@opencode/plugin"
import { createSummarizer } from "../lib/v2/summarizer"
import { SummaryFailure } from "../lib/compress/errors"
import { generateSummary } from "../lib/compress/model"
import { CompressionMedia } from "../lib/compress/media"
import type { ToolContext } from "../lib/compress/types"

const dataHome = mkdtempSync(join(tmpdir(), "dcp-adapter-tests-"))
process.env.XDG_DATA_HOME = dataHome
after(() => rmSync(dataHome, { recursive: true, force: true }))

// Saved media references are absolute paths; only the inference hook reads them.
const fixtureImage = join(dataHome, "media", "fixture.png")
const fixtureURI = "data:image/png;base64,fixture"
const capacity = {
    promptTokens: 100,
    contextWindow: 200_000,
    outputLimit: 32_000,
    recommendation: 1_200,
}

const model = { providerID: "magpie", id: "tyai/deepseek-v4.1-flash", variant: "high" }

// Header-only PNG: image-size reads IHDR dimensions.
function png(width: number, height: number) {
    const bytes = Buffer.alloc(33)
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0)
    bytes.writeUInt32BE(13, 8)
    bytes.write("IHDR", 12)
    bytes.writeUInt32BE(width, 16)
    bytes.writeUInt32BE(height, 20)
    bytes[24] = 8
    bytes[25] = 2
    return bytes.toString("base64")
}

function harness(options: {
    imageBase64: string[]
    turns?: number
    entries?: Array<Record<string, unknown>>
    hostOptions?: Record<string, unknown>
    models?: Array<Record<string, unknown>>
}) {
    const events: string[] = []
    if (options.imageBase64.length) {
        mkdirSync(join(fixtureImage, ".."), { recursive: true })
        writeFileSync(fixtureImage, Buffer.from(options.imageBase64[0]!, "base64"))
    }
    let hook: ((event: any) => void) | undefined
    let current: any
    let marker = ""
    let promptFiles: Array<{ uri: string; description?: string }> | undefined
    const session = {
        id: "ses_isolated_summary",
        create: async () => {
            events.push("create")
            return { id: "ses_isolated_summary" }
        },
        hook: async (_kind: string, callback: (event: any) => void) => {
            hook = callback
            return {
                dispose: async () => {
                    events.push("dispose")
                },
            }
        },
        prompt: async (input: {
            text: string
            files?: Array<{ uri: string; description?: string }>
        }) => {
            events.push("prompt")
            marker = input.text
            promptFiles = input.files
            for (let turn = 0; turn < (options.turns ?? 1); turn++) {
                const imageBase64 = input.files?.map((file) => file.uri.split(",")[1]!) ?? []
                const content: Array<Record<string, unknown>> = [
                    { type: "text", text: marker },
                    ...imageBase64.map((base64) => ({
                        type: "media",
                        media: Media.base64(base64, "image/png"),
                    })),
                ]
                const messages: Array<Record<string, unknown>> = [{ role: "user", content }]
                current = {
                    sessionID: "ses_isolated_summary",
                    model,
                    system: [{ type: "text", text: "HOST_SYSTEM" }],
                    tools: { shell: { description: "host tool", input: {} } },
                    options: { ...options.hostOptions } as Record<string, unknown>,
                    messages,
                }
                hook?.(current)
            }
        },
        wait: async () => {
            events.push("wait")
        },
        context: async () =>
            options.entries ?? [
                {
                    type: "assistant",
                    content: [{ type: "text", text: "ok" }],
                },
                { type: "idle", outcome: "succeeded" },
            ],
        interrupt: async () => {
            events.push("interrupt")
        },
        remove: async () => {
            events.push("remove")
        },
    }
    const ctx = {
        generate: {
            text: async () => {
                events.push("text")
                return { text: "text path" }
            },
        },
        session,
        model: { list: async () => ({ data: options.models ?? [] }) },
        config: {
            compress: { model: "magpie/tyai/deepseek-v4.1-flash#high", modelTimeoutMs: 5_000 },
        },
        logger: { info() {} },
    } as unknown as Plugin.Context
    return {
        summarizer: createSummarizer(ctx),
        ctx,
        events,
        lastEvent: () => current,
        promptFiles: () => promptFiles,
    }
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
    try {
        await promise
    } catch (error) {
        return error as Error
    }
    throw new Error("expected rejection")
}

const failureOf = (error: unknown) => (error instanceof SummaryFailure ? error : undefined)

test("host options are preserved when the real window has room", async () => {
    const h = harness({
        imageBase64: [png(8, 8)],
        hostOptions: { maxTokens: 60_000, reasoningEffort: "high" },
    })
    const result = await h.summarizer.generate(
        {
            prompt: "summarize",
            model,
            images: [{ ref: fixtureImage, mime: "image/png", uri: fixtureURI }],
            capacity,
        },
        new AbortController().signal,
    )
    const event = h.lastEvent()
    assert.equal(result.text, "ok")
    assert.equal(event.options.maxTokens, 60_000)
    assert.equal(event.options.reasoningEffort, "high")
    assert.deepEqual(event.system, [])
    assert.deepEqual(event.tools, {})
    assert.equal(
        event.messages[0].content.filter((part: { type: string }) => part.type === "media").length,
        1,
    )
    assert.match(event.messages[0].content[0].text, /summarize/)
})

test("a host without maxTokens keeps the field absent", async () => {
    const h = harness({
        imageBase64: [png(2000, 2000)],
        hostOptions: { reasoningEffort: "high" },
    })
    await h.summarizer.generate(
        {
            prompt: "p",
            model,
            images: [{ ref: fixtureImage, mime: "image/png", uri: fixtureURI }],
            capacity,
        },
        new AbortController().signal,
    )
    assert.equal("maxTokens" in h.lastEvent().options, false)
    assert.equal(h.lastEvent().options.reasoningEffort, "high")
})

test("a host maxTokens larger than the real remaining window is capped", async () => {
    const h = harness({
        imageBase64: [png(8, 8)],
        hostOptions: { maxTokens: 60_000 },
    })
    await h.summarizer.generate(
        {
            prompt: "p",
            model,
            images: [{ ref: fixtureImage, mime: "image/png", uri: fixtureURI }],
            capacity: {
                promptTokens: 100,
                contextWindow: 30_000,
                outputLimit: 32_000,
                recommendation: 1_200,
            },
        },
        new AbortController().signal,
    )
    // 30000 - 100 prompt - 1028 image tokens leaves 28872 for the reply.
    assert.equal(h.lastEvent().options.maxTokens, 28_872)
})

test("a retry that replays the same request is accepted", async () => {
    const h = harness({
        imageBase64: [png(8, 8)],
        turns: 3,
        hostOptions: { maxTokens: 60_000 },
    })
    const result = await h.summarizer.generate(
        {
            prompt: "p",
            model,
            images: [{ ref: fixtureImage, mime: "image/png", uri: fixtureURI }],
            capacity,
        },
        new AbortController().signal,
    )
    assert.equal(result.text, "ok")
    assert.equal(h.lastEvent().options.maxTokens, 60_000)
})

test("an empty failed assistant is not mistaken for the summary response", async () => {
    const h = harness({
        imageBase64: [png(8, 8)],
        turns: 2,
        hostOptions: { maxTokens: 60_000 },
        entries: [
            { type: "assistant", content: [] },
            {
                type: "assistant",
                content: [{ type: "text", text: "after retry" }],
            },
            { type: "idle", outcome: "succeeded" },
        ],
    })
    const result = await h.summarizer.generate(
        {
            prompt: "p",
            model,
            images: [{ ref: fixtureImage, mime: "image/png", uri: fixtureURI }],
            capacity,
        },
        new AbortController().signal,
    )
    assert.equal(result.text, "after retry")
    const empty = harness({
        imageBase64: [png(8, 8)],
        hostOptions: { maxTokens: 60_000 },
        entries: [
            { type: "assistant", content: [] },
            { type: "idle", outcome: "succeeded" },
        ],
    })
    const error = await rejection(
        empty.summarizer.generate(
            {
                prompt: "p",
                model,
                images: [{ ref: fixtureImage, mime: "image/png", uri: fixtureURI }],
                capacity,
            },
            new AbortController().signal,
        ),
    )
    assert.match(error.message, /returned no response/)
})

test("the isolated session is cleaned up and the main session is never written", async () => {
    const h = harness({ imageBase64: [png(8, 8)], hostOptions: { maxTokens: 60_000 } })
    await h.summarizer.generate(
        {
            prompt: "p",
            model,
            images: [{ ref: fixtureImage, mime: "image/png", uri: fixtureURI }],
            capacity,
        },
        new AbortController().signal,
    )
    assert.deepEqual(h.events, ["create", "prompt", "wait", "interrupt", "dispose", "remove"])
})

test("seven original images enter inference through native assets, with only a tiny placeholder persisted", async () => {
    const base64s = Array.from({ length: 7 }, (_, index) => png(8 + index, 9))
    const media = new CompressionMedia()
    media.transform({
        messages: [
            {
                id: "m1",
                role: "user",
                content: base64s.map((base64) => ({
                    type: "file",
                    uri: `data:image/png;base64,${base64}`,
                    mime: "image/png",
                })),
            },
        ],
        blocks: [],
    })
    await media.save()
    const images = media.images()
    assert.equal(images.length, 7)

    const h = harness({ imageBase64: base64s, hostOptions: { maxTokens: 60_000 } })
    await h.summarizer.generate(
        {
            prompt: "p",
            model,
            images,
            capacity,
        },
        new AbortController().signal,
    )

    // Even file: locators are inlined by session.prompt. Only a fixed tiny seed
    // may enter that boundary; the seven originals belong solely to inference.
    const files = h.promptFiles()
    assert.equal(files?.length, 1)
    assert.ok(JSON.stringify(files).length < 512)
    for (const image of images) {
        assert.equal(
            createHash("sha256").update(readFileSync(image.ref)).digest("hex"),
            basename(image.ref).split(".")[0],
        )
    }

    // The locator still delivers every selected image, in order and unchanged.
    const loaded = h
        .lastEvent()
        .messages[0].content.filter((part: { type: string }) => part.type === "media")
    assert.equal(loaded.length, 7)
    assert.deepEqual(
        loaded.map((part: any) => part.media.inline().base64),
        base64s,
    )
    assert.ok(loaded.every((part: any) => part.media instanceof Media.Asset))
    assert.deepEqual(h.events, ["create", "prompt", "wait", "interrupt", "dispose", "remove"])
})

test("an image collection that the host would trim is rejected before session admission", async () => {
    const h = harness({ imageBase64: [png(8, 8)] })
    writeFileSync(
        fixtureImage,
        Buffer.concat([Buffer.from(png(8, 8), "base64"), Buffer.alloc(20 * 1024 * 1024)]),
    )
    const error = await rejection(
        h.summarizer.generate(
            {
                prompt: "p",
                model,
                images: [{ ref: fixtureImage, mime: "image/png", uri: fixtureURI }],
                capacity,
            },
            new AbortController().signal,
        ),
    )
    assert.equal(failureOf(error)?.kind, "image_budget")
    assert.match(error.message, /imageBytes=\d+ safeLimit=26214400/)
    assert.match(error.message, /original context retained/)
    assert.deepEqual(h.events, [])
})

test("an image request that cannot fit the real window is rejected before admission", async () => {
    const h = harness({ imageBase64: [png(2000, 2000)] })
    const error = await rejection(
        h.summarizer.generate(
            {
                prompt: "p",
                model,
                images: [{ ref: fixtureImage, mime: "image/png", uri: fixtureURI }],
                capacity: {
                    promptTokens: 100,
                    contextWindow: 60_000,
                    outputLimit: 32_000,
                    recommendation: 1_200,
                },
            },
            new AbortController().signal,
        ),
    )
    assert.equal(failureOf(error)?.kind, "image_budget")
    // 2000x2000 adds 63524 image tokens; 100 + 63524 + 1200 exceeds 60000.
    assert.match(error.message, /input=100 image=63524 reply=1200 context=60000/)
    assert.match(error.message, /original context retained/)
    assert.deepEqual(h.events, [])
})

test("a wildcard image MIME is resolved from the original payload", async () => {
    const h = harness({ imageBase64: [png(8, 8)] })
    await h.summarizer.generate(
        {
            prompt: "p",
            model,
            images: [{ ref: fixtureImage, mime: "image/*", uri: fixtureURI }],
            capacity,
        },
        new AbortController().signal,
    )
    const media = h
        .lastEvent()
        .messages[0].content.find((part: { type: string }) => part.type === "media").media
    assert.equal(media.mediaType, "image/png")
})

test("text-only input keeps the native text path with no image budget", async () => {
    const h = harness({ imageBase64: [] })
    const result = await h.summarizer.generate({ prompt: "p", model }, new AbortController().signal)
    assert.equal(result.text, "text path")
    assert.deepEqual(h.events, ["text"])
})

test("a retry replay yields a plain summary end to end", async () => {
    const bytes = Buffer.from(png(8, 8), "base64")
    const media = new CompressionMedia()
    const text = JSON.stringify(
        media.transform({
            messages: [
                {
                    id: "m1",
                    role: "user",
                    content: [
                        {
                            type: "file",
                            uri: `data:image/png;base64,${bytes.toString("base64")}`,
                            mime: "image/png",
                        },
                    ],
                },
            ],
            blocks: [],
        }),
    )
    const host = harness({
        imageBase64: [bytes.toString("base64")],
        turns: 2,
        models: [
            {
                providerID: "magpie",
                id: "tyai/deepseek-v4.1-flash",
                limit: { context: 200_000, output: 32_000 },
                variants: [{ id: "high" }],
                capabilities: { input: ["text", "image"] },
            },
        ],
        entries: [
            { type: "assistant", content: [] },
            {
                type: "assistant",
                content: [
                    {
                        type: "text",
                        text: "Retried summary accepted.",
                    },
                ],
            },
            { type: "idle", outcome: "succeeded" },
        ],
    })

    const summary = await generateSummary(
        {
            ...(host.ctx as unknown as Record<string, unknown>),
            summarizer: host.summarizer,
        } as unknown as ToolContext,
        "Retry",
        { text, media },
        new AbortController().signal,
    )
    assert.match(summary, /^Retried summary accepted\./)
})

function summaryContext(options: { context?: number; output?: number } = {}) {
    const calls: Array<{ prompt: string }> = []
    const ctx = {
        config: {
            compress: { model: "magpie/tyai/deepseek-v4.1-flash#high", modelTimeoutMs: 5_000 },
        },
        logger: { info() {} },
        summarizer: {
            models: async () => [
                {
                    providerID: "magpie",
                    id: "tyai/deepseek-v4.1-flash",
                    limit: {
                        context: options.context ?? 1_000_000,
                        output: options.output ?? 32_000,
                    },
                    variants: [{ id: "high" }],
                },
            ],
            generate: async (input: { prompt: string }) => {
                calls.push({ prompt: input.prompt })
                throw new Error("unused by these cases")
            },
        },
    } as unknown as ToolContext
    return { ctx, calls }
}

test("a typed guarded failure keeps its own numbers and never provider text", async () => {
    const { ctx } = summaryContext({})
    ctx.summarizer!.generate = async () => {
        throw new SummaryFailure(
            "image_budget",
            "text=1 image=2 summaryRecommendation=3 safeLimit=4; select a smaller closed range and retry; original context retained; do not write a summary yourself",
        )
    }
    const error = await rejection(
        generateSummary(ctx, "topic", "source", new AbortController().signal),
    )
    assert.match(error.message, /\[image_budget\]/)
    assert.match(
        error.message,
        /text=1 image=2 summaryRecommendation=3 safeLimit=4; select a smaller closed range/,
    )
})

test("a provider message does not become a guarded failure and retains its redacted detail", async () => {
    const forged = new Error(
        "DCP_FAILURE|image_budget|text=9 image=9 summaryRecommendation=9 safeLimit=9|ENDFAILURE bearer sk-live-SECRET",
    )
    const { ctx } = summaryContext({})
    ctx.summarizer!.generate = async () => {
        throw forged
    }
    const error = await rejection(
        generateSummary(ctx, "topic", "source", new AbortController().signal),
    )
    assert.doesNotMatch(error.message, /\[image_budget\]/)
    assert.match(error.message, /DCP_FAILURE\|image_budget/)
    assert.doesNotMatch(error.message, /sk-live-SECRET/)
    assert.match(error.message, /request failed for magpie\/tyai\/deepseek-v4\.1-flash#high/)
})

test("provider failures retain their status and redacted original message", async () => {
    const { ctx } = summaryContext({})
    ctx.summarizer!.generate = async () => {
        throw Object.assign(new Error("upstream said: bearer sk-live-SECRET"), {
            _tag: "ProviderError",
            statusCode: 400,
        })
    }
    const error = await rejection(
        generateSummary(ctx, "topic", "source", new AbortController().signal),
    )
    assert.match(
        error.message,
        /DCP summarizer request failed for magpie\/tyai\/deepseek-v4\.1-flash#high/,
    )
    assert.match(error.message, /\(ProviderError status=400\)/)
    assert.match(error.message, /original context retained/)
    assert.match(error.message, /upstream said: bearer \[REDACTED\]/i)
    assert.doesNotMatch(error.message, /sk-live-SECRET/)
})

test("local image loading errors are not reduced to an unidentified model failure", async () => {
    const { ctx } = summaryContext({})
    ctx.summarizer!.generate = async () => {
        throw Object.assign(new Error("ENOENT: no such file, open 'missing.png'"), {
            code: "ENOENT",
        })
    }
    const error = await rejection(
        generateSummary(ctx, "topic", "source", new AbortController().signal),
    )
    assert.match(error.message, /ENOENT: no such file, open 'missing.png'/)
})

test("failed native sessions preserve their structured error before cleanup", async () => {
    const h = harness({
        imageBase64: [png(8, 8)],
        entries: [
            { type: "assistant", content: [] },
            {
                type: "idle",
                outcome: "failed",
                error: {
                    type: "provider.invalid-request",
                    status: 400,
                    message: "Model does not support image inputs",
                },
            },
        ],
    })
    const error = await rejection(
        h.summarizer.generate(
            {
                prompt: "p",
                model,
                images: [{ ref: fixtureImage, mime: "image/png", uri: fixtureURI }],
                capacity,
            },
            new AbortController().signal,
        ),
    )
    assert.match(error.message, /Model does not support image inputs/)
    assert.equal((error as Error & { status?: number }).status, 400)
    assert.ok(h.events.includes("remove"))
})

test("the text path rejects a request that cannot fit the model window", async () => {
    const { ctx, calls } = summaryContext({ context: 64_000, output: 60_000 })
    const source = "text evidence ".repeat(20_000)
    const error = await rejection(
        generateSummary(ctx, "topic", source, new AbortController().signal),
    )
    assert.match(error.message, /exceeds model context/)
    assert.match(error.message, /context=64000/)
    assert.match(error.message, /original context retained/)
    assert.equal(calls.length, 0)
})
