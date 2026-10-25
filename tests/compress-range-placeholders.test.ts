import assert from "node:assert/strict"
import test from "node:test"
import { parseBlockPlaceholders, stripBlockPlaceholders } from "../lib/compress/range-utils"

test("block placeholders are stripped instead of expanded", () => {
    const compact = "kept @b1@ text @b2@"
    assert.equal(
        stripBlockPlaceholders(compact, parseBlockPlaceholders(compact, "compact")),
        "kept  text",
    )
    const xml = "kept (b1) text"
    assert.equal(stripBlockPlaceholders(xml, parseBlockPlaceholders(xml, "xml")), "kept  text")
})

test("placeholder parsing ignores unknown identifiers", () => {
    const summary = "message m0001 and @b3@ only"
    const parsed = parseBlockPlaceholders(summary, "compact")
    assert.deepEqual(
        parsed.map((item) => item.blockId),
        [3],
    )
})
