import assert from "node:assert/strict"
import test, { after } from "node:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { generateSummary, summaryBudget } from "../lib/compress/model"
import { CompressionMedia } from "../lib/compress/media"
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
const budgetOf = summaryBudget(estimateOf(source))
const validJson = (summary = "Fixed summary with constraints and open work.") =>
    JSON.stringify({ summary, complete: true })

type Call = {
    prompt: string
    model: { providerID: string; id: string; variant?: string }
    images?: unknown[]
    imageBudget?: { context: number; input: number; output: number; summary: number }
}

function fixture(options: {
    respond: (
        input: Call,
        call: number,
        signal: AbortSignal,
    ) => Promise<{ text: string }> | { text: string }
    context?: number
    output?: number
    image?: boolean
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
            ...(options.image ? { capabilities: { input: ["text", "image"] } } : {}),
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

test("malformed JSON is corrected once with the full source and same model", async () => {
    const replies = ['{"summary":"truncated', validJson()]
    const { ctx, calls, signals } = fixture({
        respond: (_, call) => ({ text: replies[call - 1]! }),
    })

    const summary = await generateSummary(ctx, "Topic", source, new AbortController().signal)

    assert.equal(summary, "Fixed summary with constraints and open work.")
    assert.equal(calls.length, 2)
    assert.deepEqual(calls[1]!.model, calls[0]!.model)
    // The correction shares the first attempt's controller and its deadline.
    assert.equal(signals[1], signals[0])
    const correction = calls[1]!.prompt
    assert.match(correction, /CORRECTION \(not source data\)/)
    assert.match(correction, /not parseable as one complete JSON object/)
    assert.match(correction, /do not continue, complete, or append to a partial reply/)
    assert.match(correction, /anthropic tokenizer tokens x 1\.5, UTF-8 byte length \/ 3/i)
    assert.match(correction, new RegExp(`within ${budgetOf} tokens`))
    // Instructions are emitted before SOURCE_JSON and the source itself is unchanged.
    assert.ok(correction.indexOf("CORRECTION") < correction.indexOf("SOURCE_JSON"))
    assert.equal(correction.split(source).length - 1, 1)
    assert.equal(calls[0]!.prompt.split(source).length - 1, 1)
})

test("the exact object contract is corrected once per bad shape", async () => {
    for (const bad of [
        '{"summary":"value","complete":false}',
        '{"summary":"value","complete":true,"extra":1}',
        '{"summary":"","complete":true}',
        '["not","an","object"]',
    ]) {
        const replies = [bad, validJson()]
        const { ctx, calls } = fixture({ respond: (_, call) => ({ text: replies[call - 1]! }) })
        const summary = await generateSummary(ctx, "Topic", source, new AbortController().signal)
        assert.equal(summary, "Fixed summary with constraints and open work.", bad)
        assert.equal(calls.length, 2, bad)
        const correction = calls[1]!.prompt
        assert.match(correction, /did not match the required object/, bad)
        assert.match(correction, /"summary" must be a nonempty string/, bad)
        assert.match(correction, /no other keys are allowed/, bad)
        assert.match(correction, /Regenerate the whole object/, bad)
    }
})

test("an oversized summary is corrected with the measured estimate and budget", async () => {
    const oversized = "word ".repeat(4_000)
    const measured = estimateOf(oversized)
    assert.ok(measured > budgetOf)
    const replies = [JSON.stringify({ summary: oversized, complete: true }), validJson()]
    const { ctx, calls } = fixture({ respond: (_, call) => ({ text: replies[call - 1]! }) })

    const summary = await generateSummary(ctx, "Topic", source, new AbortController().signal)

    assert.equal(summary, "Fixed summary with constraints and open work.")
    assert.equal(calls.length, 2)
    const correction = calls[1]!.prompt
    assert.match(correction, new RegExp(`measured ${measured} tokens`))
    assert.match(correction, new RegExp(`over the ${budgetOf} token limit`))
    assert.match(correction, /Rewrite a substantially shorter summary/)
    assert.match(correction, /truncating sentences, dropping key facts/)
    assert.match(correction, /existing block references/)
    assert.match(correction, /"summary" \(nonempty string\) and "complete": true/)
    // The failed provider reply is never copied into the next prompt.
    assert.doesNotMatch(correction, /word word word/)
})

test("a second validation failure stops after two calls", async () => {
    for (const [first, second, expected] of [
        ['{"summary":"truncated', '{"summary":"still', /malformed or truncated JSON/],
        [
            '{"summary":"truncated',
            JSON.stringify({ summary: "word ".repeat(4_000), complete: true }),
            /summary exceeds output budget/,
        ],
        ['{"summary":"value","complete":false}', "not json", /malformed or truncated JSON/],
        [
            '{"summary":"value","complete":false}',
            '{"summary":"value","complete":false}',
            /did not match the required summary object/,
        ],
    ] as const) {
        const replies = [first, second]
        const { ctx, calls } = fixture({ respond: (_, call) => ({ text: replies[call - 1]! }) })
        const error = await rejection(
            generateSummary(ctx, "Topic", source, new AbortController().signal),
        )
        assert.match(error.message, expected)
        assert.equal(calls.length, 2)
    }
})

test("a valid first reply makes no correction call", async () => {
    const { ctx, calls } = fixture({ respond: () => ({ text: validJson() }) })
    const summary = await generateSummary(ctx, "Topic", source, new AbortController().signal)
    assert.equal(summary, "Fixed summary with constraints and open work.")
    assert.equal(calls.length, 1)
    assert.doesNotMatch(calls[0]!.prompt, /CORRECTION/)
})

test("final output rejection distinguishes budget overflow from an invalid object", async () => {
    const oversized = "word ".repeat(4_000)
    const tooLong = fixture({
        respond: () => ({ text: JSON.stringify({ summary: oversized, complete: true }) }),
    })
    const overflow = await rejection(
        generateSummary(tooLong.ctx, "Topic", source, new AbortController().signal),
    )
    assert.match(overflow.message, /summary exceeds output budget/)
    assert.match(overflow.message, new RegExp(`estimate=${estimateOf(oversized)}`))
    assert.match(overflow.message, new RegExp(`limit=${budgetOf}`))
    assert.match(overflow.message, /original context retained/)
    assert.equal(tooLong.calls.length, 2)

    const invalid = fixture({
        respond: () => ({ text: '{"summary":"value","complete":false}' }),
    })
    const schema = await rejection(
        generateSummary(invalid.ctx, "Topic", source, new AbortController().signal),
    )
    assert.match(schema.message, /did not match the required summary object/)
    assert.doesNotMatch(schema.message, /oversized|exceeds output budget/)
    assert.equal(invalid.calls.length, 2)
})

test("the correction re-estimates the image input budget and keeps images and model", async () => {
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
    const replies = ['{"summary":"truncated', validJson()]
    const { ctx, calls } = fixture({
        respond: (_, call) => ({ text: replies[call - 1]! }),
        image: true,
    })

    await generateSummary(ctx, "Topic", { text, media }, new AbortController().signal)

    assert.equal(calls.length, 2)
    assert.equal(calls[0]!.imageBudget!.input, estimateOf(calls[0]!.prompt))
    assert.equal(calls[1]!.imageBudget!.input, estimateOf(calls[1]!.prompt))
    assert.ok(calls[1]!.imageBudget!.input > calls[0]!.imageBudget!.input)
    assert.equal(calls[1]!.imageBudget!.summary, calls[0]!.imageBudget!.summary)
    assert.equal(calls[1]!.imageBudget!.context, calls[0]!.imageBudget!.context)
    assert.deepEqual(calls[1]!.images, calls[0]!.images)
    assert.deepEqual(calls[1]!.model, calls[0]!.model)
})

test("capacity, cancellation, timeout, provider and guarded failures add no correction", async () => {
    const big = "text ".repeat(20_000)
    const capacity = fixture({
        respond: () => ({ text: validJson() }),
        context: 64_000,
        output: 60_000,
    })
    const capacityError = await rejection(
        generateSummary(capacity.ctx, "Topic", big, new AbortController().signal),
    )
    assert.match(capacityError.message, /exceeds safe context budget/)
    assert.equal(capacity.calls.length, 0)

    const aborted = new AbortController()
    aborted.abort(new Error("cancelled"))
    const cancellation = fixture({ respond: () => ({ text: validJson() }) })
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

test("output failures never switch models even when a fallback is configured", async () => {
    const failing = fixture({
        fallbackModels: ["backup/model#high"],
        respond: (_, call) => ({
            text: call === 1 ? '{"summary":"truncated' : '{"summary":"still',
        }),
    })
    const error = await rejection(
        generateSummary(failing.ctx, "Topic", source, new AbortController().signal),
    )
    assert.match(error.message, /malformed or truncated JSON/)
    assert.deepEqual(
        failing.calls.map((call) => call.model.providerID),
        ["magpie", "magpie"],
    )
})

test("one correction is shared with a fallback that fails validation", async () => {
    // primary bad JSON -> correction request hits a provider error -> fallback bad JSON
    const { ctx, calls } = fixture({
        fallbackModels: ["backup/model#high"],
        respond: (_, call) => {
            if (call === 1) return { text: '{"summary":"truncated' }
            if (call === 2) throw { _tag: "ProviderError", status: 429 }
            return { text: '{"summary":"backup also bad' }
        },
    })
    const error = await rejection(
        generateSummary(ctx, "Topic", source, new AbortController().signal),
    )
    assert.equal(calls.length, 3)
    assert.deepEqual(
        calls.map((call) => call.model.providerID),
        ["magpie", "magpie", "backup"],
    )
    assert.deepEqual(
        calls.map((call) => /CORRECTION/.test(call.prompt)),
        [false, true, false],
    )
    assert.match(error.message, /malformed or truncated JSON/)

    // Same path with a valid fallback reply: the third call is still the base prompt.
    const recovered = fixture({
        fallbackModels: ["backup/model#high"],
        respond: (_, call) => {
            if (call === 1) return { text: '{"summary":"truncated' }
            if (call === 2) throw { _tag: "ProviderError", status: 429 }
            return { text: validJson("Backup summary.") }
        },
    })
    const summary = await generateSummary(
        recovered.ctx,
        "Topic",
        source,
        new AbortController().signal,
    )
    assert.equal(summary, "Backup summary.")
    assert.equal(recovered.calls.length, 3)
    assert.deepEqual(
        recovered.calls.map((call) => /CORRECTION/.test(call.prompt)),
        [false, true, false],
    )
    assert.deepEqual(
        recovered.calls.map((call) => call.model.providerID),
        ["magpie", "magpie", "backup"],
    )
})

test("cancellation after a bad first reply does not start the correction", async () => {
    const caller = new AbortController()
    const { ctx, calls } = fixture({
        respond: () => {
            caller.abort(new Error("cancelled by caller"))
            return { text: '{"summary":"truncated' }
        },
    })
    const error = await rejection(generateSummary(ctx, "Topic", source, caller.signal))
    assert.match(error.message, /cancelled by caller/)
    assert.equal(calls.length, 1)
})

test("the text correction is rejected when the re-estimated prompt overflows", async () => {
    // Measure the base and corrected prompt sizes from one real run.
    const measured = fixture({
        respond: (_, call) => ({ text: call === 2 ? validJson() : '{"summary":"truncated' }),
    })
    await generateSummary(measured.ctx, "Topic", source, new AbortController().signal)
    const base = estimateOf(measured.calls[0]!.prompt)
    const corrected = estimateOf(measured.calls[1]!.prompt)
    assert.ok(corrected > base + 100)
    const output = 1_000
    const context = Math.ceil((base + output + 100) / 0.8)
    assert.ok(base + output <= Math.floor(context * 0.8))
    assert.ok(corrected + output > Math.floor(context * 0.8))

    const replies = ['{"summary":"truncated', validJson()]
    const limited = fixture({
        context,
        output,
        respond: (_, call) => ({ text: replies[call - 1]! }),
    })
    const error = await rejection(
        generateSummary(limited.ctx, "Topic", source, new AbortController().signal),
    )
    assert.match(error.message, /exceeds safe context budget/)
    assert.equal(limited.calls.length, 1)
})

test("provider errors still fall back in order", async () => {
    const fallback = fixture({
        fallbackModels: ["backup/model#high"],
        respond: (input, call) => {
            if (call === 1) throw { _tag: "ProviderError", status: 429 }
            assert.equal(input.model.id, "model")
            return { text: validJson() }
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
