import assert from "node:assert/strict"
import test from "node:test"
import * as anthropicTokenizer from "@anthropic-ai/tokenizer"
import type { WithParts } from "../lib/state"
import {
    COMPACTED_TOOL_OUTPUT_PLACEHOLDER,
    countAllMessageTokens,
    countTokens,
    countToolTokens,
    estimateTokensBatch,
    extractCompletedToolOutput,
    extractToolContent,
} from "../lib/token-utils"

const upstreamCountTokens = (anthropicTokenizer.countTokens ??
    (anthropicTokenizer as any).default?.countTokens) as (text: string) => number

function buildToolMessage(part: Record<string, any>): WithParts {
    return {
        info: {
            id: "msg-tool",
            role: "assistant",
            sessionID: "ses_token_counting",
            agent: "assistant",
            time: { created: 1 },
        } as WithParts["info"],
        parts: [part as any],
    }
}

function buildToolPart(tool: string, state: Record<string, any>) {
    return {
        id: `tool-${tool}`,
        messageID: "msg-tool",
        sessionID: "ses_token_counting",
        type: "tool" as const,
        tool,
        callID: `call-${tool}`,
        state,
    }
}

function assertCounted(part: Record<string, any>, expectedContents: string[]) {
    assert.deepEqual(extractToolContent(part), expectedContents)
    assert.equal(countToolTokens(part), estimateTokensBatch(expectedContents))
    assert.equal(
        countAllMessageTokens(buildToolMessage(part)),
        estimateTokensBatch(expectedContents),
    )
}

test("counting includes input for large built-in tool calls", () => {
    const cases = [
        {
            tool: "compress",
            input: {
                topic: "Compression topic",
                content: [
                    { messageId: "m0001", topic: "Prior work", summary: "Compressed summary" },
                ],
            },
            output: "compressed",
        },
        {
            tool: "apply_patch",
            input: {
                patchText: [
                    "*** Begin Patch",
                    "*** Update File: src/example.ts",
                    "@@",
                    "-oldLine()",
                    "+newLine()",
                    "*** End Patch",
                ].join("\n"),
            },
            output: "Success. Updated the following files:\nM src/example.ts",
        },
        {
            tool: "task",
            input: {
                description: "Research bug",
                prompt: "Investigate the failing workflow and summarize root cause.",
                subagent_type: "general",
                command: "/investigate",
            },
            output: "Queued task ses_123",
        },
        {
            tool: "bash",
            input: {
                command: "python - <<'PY'\nprint(\"hello\")\nPY",
                description: "Runs inline Python script",
                workdir: "/tmp/project",
            },
            output: "hello",
        },
        {
            tool: "batch",
            input: {
                calls: [
                    { tool: "read", parameters: { filePath: "/tmp/a.txt" } },
                    { tool: "grep", parameters: { pattern: "TODO", path: "/tmp" } },
                ],
            },
            output: [
                { tool: "read", ok: true },
                { tool: "grep", ok: true },
            ],
        },
        {
            tool: "todowrite",
            input: {
                todos: [
                    { content: "Inspect bug", status: "in_progress", priority: "high" },
                    { content: "Write fix", status: "pending", priority: "high" },
                ],
            },
            output: [{ content: "Inspect bug", status: "completed", priority: "high" }],
        },
        {
            tool: "question",
            input: {
                questions: [
                    {
                        question: "Use the safer option?",
                        header: "Confirm",
                        options: [{ label: "Yes", description: "Proceed safely" }],
                    },
                ],
            },
            output: ["Yes"],
        },
    ]

    for (const testCase of cases) {
        const part = buildToolPart(testCase.tool, {
            status: "completed",
            input: testCase.input,
            output: testCase.output,
        })
        const expectedContents = [
            JSON.stringify(testCase.input),
            typeof testCase.output === "string" ? testCase.output : JSON.stringify(testCase.output),
        ]

        assertCounted(part, expectedContents)
    }
})

test("counting includes input for errored custom tools", () => {
    const customInput = {
        payload: "some large custom tool payload",
        options: { mode: "deep" },
    }
    const part = buildToolPart("custom_tool", {
        status: "error",
        input: customInput,
        error: "Tool execution failed",
    })

    assertCounted(part, [JSON.stringify(customInput), "Tool execution failed"])
})

test("counting uses the compacted tool placeholder for completed outputs", () => {
    const input = { filePath: "/tmp/large.log" }
    const part = buildToolPart("read", {
        status: "completed",
        input,
        output: "full original output that is no longer visible to the model",
        time: {
            start: 1,
            end: 2,
            compacted: 3,
        },
    })

    assert.equal(extractCompletedToolOutput(part), COMPACTED_TOOL_OUTPUT_PLACEHOLDER)
    assertCounted(part, [JSON.stringify(input), COMPACTED_TOOL_OUTPUT_PLACEHOLDER])
})

// A canonical 1x1 PNG data URL; mediaTokenText must replace it with a placeholder
// before either tokenizer sees the payload.
const PNG_DATA_URL =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="

const FIXTURES = [
    "hello world",
    "",
    "The quick brown fox jumps over the lazy dog.",
    "中文测试文本，包含标点符号。",
    "emoji 🙂🚀 and combining e\u0301 plus ligature \uFB01",
    "ＡＢＣ１２３ full width",
    JSON.stringify({ path: "C:\\tmp\\a.ts", nested: { list: [1, 2, 3], text: "值" } }),
    "<|endoftext|><|im_start|>user<|im_end|>",
    "line one\nline two\r\nline three\ttabbed",
]

test("countTokens matches upstream for repeated sequential calls", () => {
    for (const fixture of FIXTURES) {
        const expected = upstreamCountTokens(fixture.normalize("NFKC"))
        // Repeated calls must stay stable while the tokenizer instance is reused.
        for (let attempt = 0; attempt < 3; attempt++) {
            assert.equal(countTokens(fixture), expected, `fixture ${JSON.stringify(fixture.slice(0, 24))}`)
        }
    }
})

test("countTokens keeps NFKC normalization", () => {
    assert.equal(countTokens("\uFB01"), countTokens("fi"))
    assert.equal(countTokens("ＡＢＣ１２３"), countTokens("ABC123"))
    assert.equal(countTokens("e\u0301"), countTokens("\u00E9"))
    assert.equal(countTokens("\uFB01"), upstreamCountTokens("\uFB01".normalize("NFKC")))
})

test("countTokens still redacts media payloads before encoding", () => {
    const withMedia = countTokens(PNG_DATA_URL)
    const placeholderOnly = countTokens("[image/png attachment]")
    assert.equal(withMedia, placeholderOnly)
    assert.equal(withMedia, upstreamCountTokens("[image/png attachment]".normalize("NFKC")))
    assert.ok(withMedia > 0)
    assert.ok(withMedia < 16, `media payload should not be tokenized: ${withMedia}`)

    // Prose around an embedded data URL must encode exactly like the redacted text.
    assert.equal(
        countTokens(`prose ${PNG_DATA_URL} tail`),
        upstreamCountTokens("prose [image/png attachment] tail".normalize("NFKC")),
    )
})

test("countTokens encodes special markers as tokens, not characters", () => {
    const count = countTokens("<|endoftext|>")
    assert.equal(count, upstreamCountTokens("<|endoftext|>".normalize("NFKC")))
    assert.ok(count < "<|endoftext|>".length)
})

test("estimateTokensBatch keeps joining batches with a single space", () => {
    const parts = ["first part", "second part"]
    assert.equal(estimateTokensBatch(parts), countTokens(parts.join(" ")))
})
