import assert from "node:assert/strict"
import test from "node:test"
import { generateSummary, summaryBudget } from "../lib/compress/model"
import type { ToolContext } from "../lib/compress/types"
import { countTokens } from "../lib/token-utils"

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
                return { text: JSON.stringify({ summary: "Verified result; follow-up remains open.", complete: true }) }
            },
        },
    } as unknown as ToolContext
    await generateSummary(context, "Budget integration", source, new AbortController().signal)
    assert.ok(sourceEstimate > 20_000)
    assert.equal(requestedBudget, summaryBudget(sourceEstimate))
})
