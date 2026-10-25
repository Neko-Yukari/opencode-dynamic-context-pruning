import assert from "node:assert/strict"
import test from "node:test"
import { validateArgs, validateSelectionArgs } from "../lib/compress/range-utils"

test("configured ranges validate boundaries without a summary", () => {
    // The configured model authors every summary, so the caller supplies none.
    validateSelectionArgs({
        topic: "DCP configured mode",
        content: [{ startId: "m1", endId: "m2" }],
    })
    assert.throws(
        () =>
            validateSelectionArgs({
                topic: "DCP configured mode",
                content: [{ startId: " ", endId: "m2" }],
            }),
        /content\[0\]\.startId is required and must be a non-empty string/,
    )
    assert.throws(
        () => validateSelectionArgs({ topic: "DCP configured mode", content: [] }),
        /content is required and must be a non-empty array/,
    )
})

test("scripted ranges still require a non-empty summary", () => {
    assert.throws(
        () =>
            validateArgs({
                topic: "scripted",
                content: [{ startId: "m1", endId: "m2", summary: " " }],
            }),
        /content\[0\]\.summary is required and must be a non-empty string/,
    )
    assert.doesNotThrow(() =>
        validateArgs({
            topic: "scripted",
            content: [{ startId: "m1", endId: "m2", summary: "summary body" }],
        }),
    )
})
