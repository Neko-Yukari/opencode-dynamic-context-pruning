import assert from "node:assert/strict"
import test from "node:test"
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Logger } from "../lib/logger"

// Logger resolves its directory from XDG_CONFIG_HOME at construction time.
const configHome = mkdtempSync(join(tmpdir(), "opencode-dcp-logger-"))
process.env.XDG_CONFIG_HOME = configHome

function readLog(): string {
    const daily = join(configHome, "opencode", "logs", "dcp", "daily")
    if (!existsSync(daily)) return ""
    return readdirSync(daily)
        .map((file) => readFileSync(join(daily, file), "utf-8"))
        .join("")
}

test("operational log lines stay visible when debug logging is off", async () => {
    const logger = new Logger(false)

    await logger.info("prepare outcome", { reason: "below-floor", contextTokens: 191000 })
    await logger.debug("verbose detail", { reason: "below-target" })

    const log = readLog()
    // A skipped or failed fold must be explainable in production, where the
    // `debug` config is off by default.
    assert.match(log, /INFO .*prepare outcome/)
    assert.match(log, /reason=below-floor/)
    assert.ok(!log.includes("verbose detail"))
})

test("enabling debug adds the debug channel instead of replacing info", async () => {
    const logger = new Logger(true)

    await logger.info("visible outcome", { prepared: false })
    await logger.debug("verbose detail", { prepared: false })

    const log = readLog()
    assert.match(log, /INFO .*visible outcome/)
    assert.match(log, /DEBUG .*verbose detail/)
})
