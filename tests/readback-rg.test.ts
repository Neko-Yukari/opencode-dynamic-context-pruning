import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import test from "node:test"
import { searchWithRg } from "../lib/readback-rg"

const rg = process.env.DCP_RG_BIN ?? "C:/Users/81004/.cache/opencode/bin/rg.exe"
const record = {
    sourceId: "msg_test",
    role: "assistant",
    text: JSON.stringify([{ type: "text", text: "alpha\nneedle in history\nomega" }]),
}

test("rg search reads matching original lines and returns a source id", { skip: !existsSync(rg) }, async () => {
    const hits = await searchWithRg([record], "needle", 5, false)
    assert.equal(hits.length, 1)
    assert.equal(hits[0].sourceId, "msg_test")
    assert.match(hits[0].text, /needle in history/)
})

test("rg search has no semantic fallback when there is no match", { skip: !existsSync(rg) }, async () => {
    assert.deepEqual(await searchWithRg([record], "not-present", 5, false), [])
})
