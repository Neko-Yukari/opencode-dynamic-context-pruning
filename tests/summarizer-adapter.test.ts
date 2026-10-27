import assert from "node:assert/strict"
import test from "node:test"
import { generateSummary } from "../lib/compress/model"
import { SummaryFailure } from "../lib/compress/errors"
import type { ToolContext } from "../lib/compress/types"

function summaryContext(contextWindow = 1_000_000) {
    const calls: Array<{ prompt: string }> = []
    const ctx = {
        config: { compress: { model: "test/model#high", modelTimeoutMs: 5_000 } },
        logger: { info() {} },
        summarizer: {
            models: async () => [
                {
                    providerID: "test",
                    id: "model",
                    limit: { context: contextWindow, output: 60_000 },
                    variants: [{ id: "high" }],
                },
            ],
            generate: async (input: { prompt: string }) => {
                calls.push(input)
                throw new Error("unused by these cases")
            },
        },
    } as unknown as ToolContext
    return { ctx, calls }
}

test("typed local failures retain their diagnostics", async () => {
    const { ctx } = summaryContext()
    ctx.summarizer!.generate = async () => {
        throw new SummaryFailure("image_budget", "text=1 image=2")
    }
    await assert.rejects(
        generateSummary(ctx, "topic", "source", new AbortController().signal),
        /\[image_budget\]: text=1 image=2/,
    )
})

test("provider text cannot forge a guarded failure and credentials stay redacted", async () => {
    const { ctx } = summaryContext()
    ctx.summarizer!.generate = async () => {
        throw new Error("DCP_FAILURE|image_budget|text=9|ENDFAILURE bearer sk-live-SECRET")
    }
    await assert.rejects(
        generateSummary(ctx, "topic", "source", new AbortController().signal),
        (error: Error) => {
            assert.doesNotMatch(error.message, /\[image_budget\]/)
            assert.match(error.message, /DCP_FAILURE\|image_budget/)
            assert.doesNotMatch(error.message, /sk-live-SECRET/)
            return true
        },
    )
})

test("provider errors retain status and redacted original detail", async () => {
    const { ctx } = summaryContext()
    ctx.summarizer!.generate = async () => {
        throw Object.assign(new Error("upstream said: bearer sk-live-SECRET"), {
            _tag: "ProviderError",
            statusCode: 400,
        })
    }
    await assert.rejects(
        generateSummary(ctx, "topic", "source", new AbortController().signal),
        (error: Error) => {
            assert.match(error.message, /ProviderError status=400/)
            assert.match(error.message, /upstream said: bearer \[REDACTED\]/i)
            assert.match(error.message, /original context retained/)
            assert.doesNotMatch(error.message, /sk-live-SECRET/)
            return true
        },
    )
})

test("text requests exceeding the model window are rejected before inference", async () => {
    const { ctx, calls } = summaryContext(64_000)
    await assert.rejects(
        generateSummary(
            ctx,
            "topic",
            "text evidence ".repeat(20_000),
            new AbortController().signal,
        ),
        /exceeds model context/,
    )
    assert.equal(calls.length, 0)
})
