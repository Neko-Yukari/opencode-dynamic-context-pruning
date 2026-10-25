import assert from "node:assert/strict"
import test, { after } from "node:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { generateSummary, summaryBudget } from "../lib/compress/model"
import { CompressionMedia } from "../lib/compress/media"
import type { SummaryImageBudget, ToolContext } from "../lib/compress/types"
import { countTokens } from "../lib/token-utils"

const dataHome = mkdtempSync(join(tmpdir(), "dcp-budget-tests-"))
process.env.XDG_DATA_HOME = dataHome
after(() => rmSync(dataHome, { recursive: true, force: true }))

test("summary budgets accrue continuously across source size bands", () => {
    for (const [size, expected] of [
        [0, 1_200],
        [8_000, 1_200],
        [20_000, 3_000],
        [20_001, 3_000],
        [50_000, 6_600],
        [100_000, 12_600],
        [100_001, 12_600],
        [200_000, 20_600],
        [242_500, 24_000],
        [300_000, 24_000],
    ]) {
        assert.equal(summaryBudget(size!), expected)
    }
    for (let size = 0; size <= 300_000; size++) {
        assert.ok(summaryBudget(size + 1) >= summaryBudget(size), `budget decreased at ${size}`)
    }
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
                requestedBudget = Number(/in at most (\d+) tokens/.exec(input.prompt)![1])
                return {
                    text: JSON.stringify({
                        summary: "Verified result; follow-up remains open.",
                        complete: true,
                    }),
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

test("image sources pass an internal budget instead of a full output reserve", async () => {
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
    let seen: { imageBudget?: SummaryImageBudget; images: number; legacyLimit: boolean } | undefined
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
                imageBudget?: SummaryImageBudget
                images?: unknown[]
                prompt: string
            }) => {
                seen = {
                    imageBudget: input.imageBudget,
                    images: input.images?.length ?? 0,
                    legacyLimit: "imageTokenLimit" in input,
                }
                return {
                    text: JSON.stringify({ summary: "Image evidence retained.", complete: true }),
                    imageTokens: 1_028,
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

    // 60000 output exceeds the 51200 safe window, so a full reserve would refuse
    // every image request; the adapter now receives the parts of the budget instead.
    assert.equal(seen?.images, 1)
    assert.equal(seen?.legacyLimit, false)
    assert.equal(seen?.imageBudget?.context, 51_200)
    assert.equal(seen?.imageBudget?.output, 60_000)
    assert.equal(seen?.imageBudget?.summary, summaryBudget(sourceEstimate))
    assert.ok(seen!.imageBudget!.input >= sourceEstimate)
    assert.match(summary, /Media references retained \(images supplied to summarizer/)
})
