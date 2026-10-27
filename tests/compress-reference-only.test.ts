import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Plugin } from "@opencode/plugin"
import { CompressionMedia } from "../lib/compress/media"
import { generateSummary } from "../lib/compress/model"
import type { ToolContext } from "../lib/compress/types"
import { createSummarizer } from "../lib/v2/summarizer"

test("large image, PDF and binary attachments remain retrievable without being resent", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dcp-reference-only-"))
    const previous = process.env.XDG_DATA_HOME
    process.env.XDG_DATA_HOME = directory
    try {
        const media = new CompressionMedia()
        const payloads = [
            { mime: "image/png", bytes: Buffer.alloc(7 * 1024 * 1024, 1) },
            { mime: "image/jpeg", bytes: Buffer.alloc(7 * 1024 * 1024, 2) },
            { mime: "application/pdf", bytes: Buffer.from("%PDF-1.7\nexisting document") },
            { mime: "application/octet-stream", bytes: Buffer.from([0, 1, 2, 255]) },
        ]
        const source = payloads.map(({ mime, bytes }) => ({
            type: "file",
            mime,
            uri: `data:${mime};base64,${bytes.toString("base64")}`,
        }))
        const mapped = media.transform(source) as Array<{ ref: string; mime: string }>
        let requests = 0
        const native = {
            model: {
                list: async () => ({
                    data: [
                        {
                            providerID: "test",
                            id: "vision-capable",
                            limit: { context: 1_000_000, output: 1024 },
                            capabilities: { input: ["text", "image"] },
                        },
                    ],
                }),
            },
            generate: {
                text: async (input: Record<string, unknown>) => {
                    requests++
                    assert.deepEqual(Object.keys(input).sort(), ["model", "prompt"])
                    const prompt = input.prompt as string
                    assert.ok(prompt.includes("All attachments are reference-only"))
                    assert.ok(prompt.includes("image/png"))
                    assert.ok(prompt.includes("application/pdf"))
                    assert.ok(prompt.includes("application/octet-stream"))
                    assert.ok(!prompt.includes("data:"))
                    assert.ok(prompt.length < 10_000)
                    return {
                        text: "Recorded document references.",
                    }
                },
            },
            session: new Proxy(
                {},
                {
                    get() {
                        throw new Error("Reference-only compression must not create a session")
                    },
                },
            ),
        } as unknown as Plugin.Context
        const context = {
            config: { compress: { model: "test/vision-capable" } },
            logger: { info() {} },
            summarizer: createSummarizer(native),
        } as unknown as ToolContext
        const summary = await generateSummary(
            context,
            "attachment history",
            { text: JSON.stringify(mapped), media },
            new AbortController().signal,
        )
        assert.equal(requests, 1)
        assert.ok(summary.includes("contents were not inspected"))
        assert.ok(!summary.includes("data:"))
        for (const [index, reference] of mapped.entries()) {
            assert.ok(summary.includes(JSON.stringify(reference.ref)))
            assert.deepEqual(await readFile(reference.ref), payloads[index]!.bytes)
        }
    } finally {
        if (previous === undefined) delete process.env.XDG_DATA_HOME
        else process.env.XDG_DATA_HOME = previous
        await rm(directory, { recursive: true, force: true })
    }
})

test("reference-only generation still propagates cancellation before native inference", async () => {
    const controller = new AbortController()
    controller.abort(new Error("cancelled by user"))
    const native = {
        generate: {
            text() {
                throw new Error("must not execute")
            },
        },
    } as unknown as Plugin.Context
    await assert.rejects(
        createSummarizer(native).generate(
            { prompt: "source", model: { providerID: "test", id: "model" } },
            controller.signal,
        ),
        /cancelled by user/,
    )
})
