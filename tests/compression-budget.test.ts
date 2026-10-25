import assert from "node:assert/strict"
import test, { after } from "node:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { generateSummary, summaryBudget } from "../lib/compress/model"
import { CompressionMedia } from "../lib/compress/media"
import type { ToolContext } from "../lib/compress/types"
import { countTokens } from "../lib/token-utils"

const dataHome = mkdtempSync(join(tmpdir(), "dcp-budget-tests-"))
process.env.XDG_DATA_HOME = dataHome
after(() => rmSync(dataHome, { recursive: true, force: true }))

test("summary budgets accrue continuously across source size bands", () => {
    for (const [size, expected] of [
        [0, 2_000],
        [8_000, 2_000],
        [20_000, 4_000],
        [20_001, 4_000],
        [50_000, 8_500],
        [100_000, 16_000],
        [100_001, 16_000],
        [200_000, 26_000],
        [260_000, 32_000],
        [300_000, 32_000],
    ]) {
        assert.equal(summaryBudget(size!), expected)
    }
    for (let size = 0; size <= 300_000; size++) {
        assert.ok(summaryBudget(size + 1) >= summaryBudget(size), `budget decreased at ${size}`)
    }
})

test("inspected images add linearly to the capped text recommendation", () => {
    assert.equal(summaryBudget(0, 1), 2_512)
    assert.equal(summaryBudget(50_000, 2), 9_524)
    assert.equal(summaryBudget(200_000, 7), 29_584)
    assert.equal(summaryBudget(260_000, 7), 35_584)
})

test("the recent rejected summary lengths fit the increased text allowances", () => {
    assert.ok(summaryBudget(0) >= 1_649)
    assert.ok(summaryBudget(19_620) >= 3_789)
})

test("summary generation uses the accrued budget for the production source estimate", async () => {
    const source = "任务证据与验证结果。".repeat(5_000)
    const sourceEstimate = Math.ceil(
        Math.max(countTokens(source) * 1.5, Buffer.byteLength(source, "utf8") / 3),
    )
    let requestedBudget = 0
    const context = {
        config: { compress: { model: "test/model", modelTimeoutMs: 1_000 } },
        logger: { info() {} },
        summarizer: {
            models: async () => [
                { providerID: "test", id: "model", limit: { context: 1_000_000, output: 32_000 } },
            ],
            generate: async (input: { prompt: string }) => {
                requestedBudget = Number(/Aim for about (\d+) tokens/.exec(input.prompt)![1])
                return {
                    text: "Verified result; follow-up remains open.",
                }
            },
        },
    } as unknown as ToolContext
    await generateSummary(context, "Budget integration", source, new AbortController().signal)
    assert.ok(sourceEstimate > 20_000)
    assert.equal(requestedBudget, summaryBudget(sourceEstimate))
})

test("inline image examples in source text are preserved when their base64 is not valid", () => {
    const media = new CompressionMedia()
    for (const text of [
        'const fixtureURI = "data:image/png;base64,fixture"',
        "Image syntax: data:image/png;base64,AAAAA (not an attachment)",
    ]) {
        assert.equal(media.transform(text), text)
    }
    assert.deepEqual(media.images(), [])
    assert.throws(
        () =>
            media.transform({
                type: "file",
                uri: "data:image/png;base64,fixture",
                mime: "image/png",
            }),
        /invalid media encoding/,
    )
})

test("a valid data URI quoted in text stays reference-only until an attachment reuses it", () => {
    const bytes = Buffer.alloc(33)
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0)
    bytes.writeUInt32BE(13, 8)
    bytes.write("IHDR", 12)
    bytes.writeUInt32BE(8, 16)
    bytes.writeUInt32BE(8, 20)
    bytes[24] = 8
    bytes[25] = 2
    const uri = `data:image/png;base64,${bytes.toString("base64")}`
    const media = new CompressionMedia()
    const mapped = media.transform(`Example: ${uri}`)
    assert.notEqual(mapped, `Example: ${uri}`)
    // Quoted documentation bytes are not evidence the summarizer inspected.
    assert.deepEqual(media.images(), [])
    // A real attachment using the same locator promotes it for inference.
    media.transform({ type: "file", uri, mime: "image/png" })
    const images = media.images()
    assert.equal(images.length, 1)
    assert.equal(images[0]!.mime, "image/png")
    assert.equal(images[0]!.uri, uri)
})

test("image URLs and file paths embedded in text remain references rather than attachments", () => {
    const media = new CompressionMedia()
    const remote = "https://example.com/documentation.jpg"
    const file = "file:///C:/missing-documentation-example.png"
    const source = media.transform({
        text: `Example:\n${JSON.stringify({ type: "image_url", image_url: { url: remote } })}`,
        output: JSON.stringify({ type: "image", mimeType: "image/png", url: file }),
    })
    assert.deepEqual(media.images(), [])
    assert.match(JSON.stringify(source), /documentation\.jpg/)
    assert.match(JSON.stringify(source), /missing-documentation-example\.png/)
    const summary = media.appendReferences("Documented input formats.", false)
    assert.match(summary, /reference-only; visual contents were not inspected/)
    assert.ok(summary.includes(remote))
    assert.ok(summary.includes(file))

    // A real attachment using the same locator must still be loaded normally.
    media.transform({ type: "file", uri: file, mime: "image/png" })
    assert.deepEqual(media.images(), [{ ref: file, uri: file, mime: "image/png" }])
})

test("images are passed with the real model window capacity", async () => {
    const bytes = Buffer.alloc(33)
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0)
    bytes.writeUInt32BE(13, 8)
    bytes.write("IHDR", 12)
    bytes.writeUInt32BE(8, 16)
    bytes.writeUInt32BE(8, 20)
    bytes[24] = 8
    bytes[25] = 2
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
    const sourceEstimate = Math.ceil(
        Math.max(countTokens(text) * 1.5, Buffer.byteLength(text, "utf8") / 3),
    )
    const visualSummary = "word ".repeat(1_300)
    let calls = 0
    let seen:
        | {
              capacity?: { contextWindow: number; outputLimit: number; recommendation: number }
              hasBudget: boolean
              images: number
              legacyLimit: boolean
              prompt: string
          }
        | undefined
    const context = {
        config: { compress: { model: "test/model", modelTimeoutMs: 5_000 } },
        logger: { info() {} },
        summarizer: {
            models: async () => [
                {
                    providerID: "test",
                    id: "model",
                    limit: { context: 64_000, output: 60_000 },
                    capabilities: { input: ["text", "image"] },
                },
            ],
            generate: async (input: {
                capacity?: { contextWindow: number; outputLimit: number; recommendation: number }
                images?: unknown[]
                prompt: string
            }) => {
                calls++
                seen = {
                    capacity: input.capacity,
                    hasBudget: "imageBudget" in input,
                    images: input.images?.length ?? 0,
                    legacyLimit: "imageTokenLimit" in input,
                    prompt: input.prompt,
                }
                return {
                    text: visualSummary,
                }
            },
        },
    } as unknown as ToolContext

    const summary = await generateSummary(
        context,
        "Image budget",
        { text, media },
        new AbortController().signal,
    )

    // The real model window crosses the boundary; the advisory recommendation
    // includes the image allowance and there is no obsolete internal budget.
    assert.equal(calls, 1)
    assert.equal(seen?.images, 1)
    assert.equal(seen?.legacyLimit, false)
    assert.equal(seen?.hasBudget, false)
    assert.equal(seen?.capacity?.contextWindow, 64_000)
    assert.equal(seen?.capacity?.outputLimit, 60_000)
    assert.equal(seen?.capacity?.recommendation, summaryBudget(sourceEstimate, 1))
    assert.match(
        seen!.prompt,
        new RegExp(`Aim for about ${summaryBudget(sourceEstimate, 1)} tokens`),
    )
    assert.ok(summary.startsWith(visualSummary.trim()))
    assert.match(summary, /Media references retained \(images supplied to summarizer/)
})
