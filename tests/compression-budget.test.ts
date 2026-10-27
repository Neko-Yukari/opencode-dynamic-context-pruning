import assert from "node:assert/strict"
import test, { after } from "node:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { generateSummary, summaryBudget, estimate } from "../lib/compress/model"
import { CompressionMedia } from "../lib/compress/media"
import type { ToolContext } from "../lib/compress/types"

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
    ])
        assert.equal(summaryBudget(size!), expected)
    for (let size = 0; size <= 300_000; size++)
        assert.ok(summaryBudget(size + 1) >= summaryBudget(size), `budget decreased at ${size}`)
})

test("summary generation retains the accrued budget for the production source estimate", async () => {
    const source = "任务证据与验证结果。".repeat(5_000)
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
                return { text: "Verified result; follow-up remains open." }
            },
        },
    } as unknown as ToolContext
    await generateSummary(context, "Budget integration", source, new AbortController().signal)
    assert.ok(estimate(source) > 20_000)
    assert.equal(requestedBudget, summaryBudget(estimate(source)))
})

test("invalid data URI examples stay source text while invalid actual attachments fail", () => {
    const media = new CompressionMedia()
    for (const text of [
        'const fixtureURI = "data:image/png;base64,fixture"',
        "Image syntax: data:image/png;base64,AAAAA (not an attachment)",
    ])
        assert.equal(media.transform(text), text)
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

test("image URLs and missing paths remain references without being loaded", async () => {
    const media = new CompressionMedia()
    const remote = "https://example.com/documentation.jpg"
    const file = "file:///C:/missing-documentation-example.png"
    media.transform({
        text: `Example:\n${JSON.stringify({ type: "image_url", image_url: { url: remote } })}`,
        output: JSON.stringify({ type: "image", mimeType: "image/png", url: file }),
    })
    media.transform({ type: "file", uri: file, mime: "image/png" })
    await media.save()
    const summary = media.appendReferences("Documented input formats.")
    assert.match(summary, /reference-only; contents were not inspected/)
    assert.ok(summary.includes(remote))
    assert.ok(summary.includes(file))
})
