import assert from "node:assert/strict"
import test, { after } from "node:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { generateSummary, summaryBudget } from "../lib/compress/model"
import { SummaryFailure } from "../lib/compress/errors"
import type { ToolContext } from "../lib/compress/types"
import { countTokens } from "../lib/token-utils"

const dataHome = mkdtempSync(join(tmpdir(), "dcp-retry-tests-"))
process.env.XDG_DATA_HOME = dataHome
after(() => rmSync(dataHome, { recursive: true, force: true }))

const model = "magpie/tyai/deepseek-v4.1-flash#high"
const source = "SRC-EVIDENCE " + "Evidence line. ".repeat(200)
const estimateOf = (text: string) =>
    Math.ceil(Math.max(countTokens(text) * 1.5, Buffer.byteLength(text, "utf8") / 3))
const summaryText = (summary = "Fixed summary with constraints and open work.") => summary

type Call = {
    prompt: string
    model: { providerID: string; id: string; variant?: string }
    images?: unknown[]
}

function fixture(options: {
    respond: (
        input: Call,
        call: number,
        signal: AbortSignal,
    ) => Promise<{ text: string }> | { text: string }
    context?: number
    output?: number
    timeout?: number
    fallbackModels?: string[]
}) {
    const calls: Call[] = []
    const signals: AbortSignal[] = []
    const metadata = [
        {
            providerID: "magpie",
            id: "tyai/deepseek-v4.1-flash",
            limit: { context: options.context ?? 200_000, output: options.output ?? 32_000 },
            variants: [{ id: "high" }],
        },
        {
            providerID: "backup",
            id: "model",
            limit: { context: options.context ?? 200_000, output: options.output ?? 32_000 },
            variants: [{ id: "high" }],
        },
    ]
    const ctx = {
        config: {
            compress: {
                model,
                modelTimeoutMs: options.timeout ?? 10_000,
                ...(options.fallbackModels ? { fallbackModels: options.fallbackModels } : {}),
            },
        },
        logger: { info() {} },
        summarizer: {
            models: async () => metadata,
            generate: async (input: Call, signal: AbortSignal) => {
                calls.push(input)
                signals.push(signal)
                return options.respond(input, calls.length, signal)
            },
        },
    } as unknown as ToolContext
    return { ctx, calls, signals }
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
    try {
        await promise
    } catch (error) {
        return error as Error
    }
    throw new Error("expected rejection")
}

test("a valid reply returns the summary with one call", async () => {
    const { ctx, calls } = fixture({ respond: () => ({ text: summaryText() }) })
    const summary = await generateSummary(ctx, "Topic", source, new AbortController().signal)
    assert.equal(summary, "Fixed summary with constraints and open work.")
    assert.equal(calls.length, 1)
    assert.doesNotMatch(calls[0]!.prompt, /CORRECTION/)
    assert.match(calls[0]!.prompt, /recommendation, not a strict maximum/)
    assert.match(calls[0]!.prompt, /Return only the summary body/)
    assert.doesNotMatch(calls[0]!.prompt, /Return one JSON object/)
})

test("a summary above the recommendation is accepted", async () => {
    const summary = "word ".repeat(2_000)
    assert.ok(estimateOf(summary) > summaryBudget(estimateOf(source)))
    const { ctx, calls } = fixture({ respond: () => ({ text: summaryText(summary) }) })
    assert.equal(
        await generateSummary(ctx, "Topic", source, new AbortController().signal),
        summary.trim(),
    )
    assert.equal(calls.length, 1)
})

test("a summary just below five times the recommendation is accepted once", async () => {
    const budget = summaryBudget(estimateOf(source))
    const summary = "x".repeat(budget * 15 - 3)
    assert.equal(estimateOf(summary), budget * 5 - 1)
    const { ctx, calls } = fixture({ respond: () => ({ text: summaryText(summary) }) })
    assert.equal(await generateSummary(ctx, "Topic", source, new AbortController().signal), summary)
    assert.equal(calls.length, 1)
})

test("a summary at or above five times the recommendation gets one correction prompt", async () => {
    const budget = summaryBudget(estimateOf(source))
    for (const extra of [0, 3]) {
        const summary = "x".repeat(budget * 15 + extra)
        assert.equal(estimateOf(summary), budget * 5 + extra / 3)
        const { ctx, calls } = fixture({
            respond: (_input, call) => ({
                text: summaryText(call === 1 ? summary : "Corrected facts."),
            }),
        })
        assert.equal(
            await generateSummary(ctx, "Topic", source, new AbortController().signal),
            "Corrected facts.",
        )
        assert.equal(calls.length, 2)
        assert.deepEqual(calls[1]!.model, calls[0]!.model)
        assert.ok(calls[1]!.prompt.includes(`SOURCE_JSON\n${source}`))
        assert.match(calls[1]!.prompt, /LENGTH_CORRECTION/)
        assert.ok(calls[1]!.prompt.includes(`recommendation=${budget}`))
        assert.ok(calls[1]!.prompt.includes(`threshold=${budget * 5}`))
        assert.match(calls[1]!.prompt, /Return only the summary body/)
    }
})

test("a second fivefold summary is rejected without another retry or model switch", async () => {
    const budget = summaryBudget(estimateOf(source))
    const { ctx, calls } = fixture({
        fallbackModels: ["backup/model#high"],
        respond: () => ({ text: summaryText("x".repeat(budget * 15)) }),
    })
    const error = await rejection(
        generateSummary(ctx, "Topic", source, new AbortController().signal),
    )
    assert.match(error.message, /five times the recommendation/)
    assert.match(error.message, /original context retained/)
    assert.equal(calls.length, 2)
    assert.deepEqual(
        calls.map((call) => call.model.providerID),
        ["magpie", "magpie"],
    )
})

test("a correction request is checked against the remaining model window before sending", async () => {
    const baseline = fixture({ respond: () => ({ text: summaryText() }) })
    await generateSummary(baseline.ctx, "Topic", source, new AbortController().signal)
    const budget = summaryBudget(estimateOf(source))
    const context = estimateOf(baseline.calls[0]!.prompt) + budget
    const { ctx, calls } = fixture({
        context,
        fallbackModels: ["backup/model#high"],
        respond: () => ({ text: summaryText("x".repeat(budget * 15)) }),
    })
    const error = await rejection(
        generateSummary(ctx, "Topic", source, new AbortController().signal),
    )
    assert.match(error.message, /request exceeds model context/)
    assert.match(error.message, /original context retained/)
    assert.equal(calls.length, 1)
    assert.equal(calls[0]!.model.providerID, "magpie")
})

test("an empty summary fails once with the original context retained", async () => {
    for (const reply of ["", "   "]) {
        const { ctx, calls } = fixture({ respond: () => ({ text: reply }) })
        const error = await rejection(
            generateSummary(ctx, "Topic", source, new AbortController().signal),
        )
        assert.match(error.message, /no nonempty summary; original context retained/)
        assert.equal(calls.length, 1)
    }
})

test("empty output never switches models even when a fallback is configured", async () => {
    const failing = fixture({
        fallbackModels: ["backup/model#high"],
        respond: () => ({ text: "" }),
    })
    const error = await rejection(
        generateSummary(failing.ctx, "Topic", source, new AbortController().signal),
    )
    assert.match(error.message, /no nonempty summary/)
    assert.deepEqual(
        failing.calls.map((call) => call.model.providerID),
        ["magpie"],
    )
})

test("cancellation, timeout, provider and host failures fail once", async () => {
    const aborted = new AbortController()
    aborted.abort(new Error("cancelled"))
    const cancellation = fixture({ respond: () => ({ text: summaryText() }) })
    await rejection(generateSummary(cancellation.ctx, "Topic", source, aborted.signal))
    assert.equal(cancellation.calls.length, 0)

    const timeout = fixture({
        respond: (_input, _call, signal) =>
            new Promise((_, reject) =>
                signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
            ),
        timeout: 1,
    })
    const timeoutError = await rejection(
        generateSummary(timeout.ctx, "Topic", source, new AbortController().signal),
    )
    assert.match(timeoutError.message, /timeout/)
    assert.equal(timeout.calls.length, 1)

    const provider = fixture({
        respond: () => {
            throw Object.assign(new Error("upstream body sk-live-SECRET"), {
                _tag: "ProviderError",
                statusCode: 400,
            })
        },
    })
    const providerError = await rejection(
        generateSummary(provider.ctx, "Topic", source, new AbortController().signal),
    )
    assert.match(providerError.message, /request failed for magpie/)
    assert.doesNotMatch(providerError.message, /sk-live-SECRET/)
    assert.equal(provider.calls.length, 1)

    const guarded = fixture({
        respond: () => {
            throw new SummaryFailure("image_budget", "text=1 image=2")
        },
    })
    const guardedError = await rejection(
        generateSummary(guarded.ctx, "Topic", source, new AbortController().signal),
    )
    assert.match(guardedError.message, /\[image_budget\]/)
    assert.equal(guarded.calls.length, 1)
})

test("cancellation while a provider reply arrives propagates the caller reason", async () => {
    const caller = new AbortController()
    const { ctx, calls } = fixture({
        respond: () => {
            caller.abort(new Error("cancelled by caller"))
            return { text: "" }
        },
    })
    const error = await rejection(generateSummary(ctx, "Topic", source, caller.signal))
    assert.match(error.message, /cancelled by caller/)
    assert.equal(calls.length, 1)
})

test("provider errors still fall back in order", async () => {
    const fallback = fixture({
        fallbackModels: ["backup/model#high"],
        respond: (input, call) => {
            if (call === 1) throw { _tag: "ProviderError", status: 429 }
            assert.equal(input.model.id, "model")
            return { text: summaryText() }
        },
    })
    const summary = await generateSummary(
        fallback.ctx,
        "Topic",
        source,
        new AbortController().signal,
    )
    assert.equal(summary, "Fixed summary with constraints and open work.")
    assert.deepEqual(
        fallback.calls.map((call) => call.model.providerID),
        ["magpie", "backup"],
    )
})
