import assert from "node:assert/strict"
import test from "node:test"
import { createSessionState, type WithParts } from "../lib/state"
import { createReadbackTool } from "../lib/readback"
import {
    createFullHistoryReader,
    createHistoryTransport,
    type FullHistoryPage,
    type FullHistoryTransport,
} from "../lib/v2/full-history"

const session = {
    id: "ses_full_history",
    agent: "build",
    model: { providerID: "magpie", id: "test-model", variant: "high" },
}

function user(id: string, text: string, created: number) {
    return { type: "user", id, time: { created }, text }
}

function assistant(id: string, text: string, created: number) {
    return {
        type: "assistant",
        id,
        time: { created },
        agent: "build",
        model: session.model,
        content: [{ type: "text", text }],
    }
}

function compaction(id: string, created: number) {
    return {
        type: "compaction",
        id,
        time: { created },
        status: "completed",
        reason: "manual",
        summary: "not original content",
    }
}

const oldUser = user("msg_old_user", "old user", 1)
const oldAssistant = assistant("msg_old_assistant", "old assistant", 2)
const compacted = compaction("msg_compaction", 3)
const newUser = user("msg_new_user", "new user", 4)

function page(data: unknown[], next?: string): FullHistoryPage {
    return { data, cursor: next ? { next } : { next: null } }
}

function harness(pages: FullHistoryPage[]) {
    const calls: Array<{ sessionID: string; order?: string; cursor?: string }> = []
    const transport: FullHistoryTransport = {
        async list(input) {
            calls.push({
                sessionID: input.sessionID,
                ...(input.order ? { order: input.order } : {}),
                ...(input.cursor ? { cursor: input.cursor } : {}),
            })
            const index = input.cursor ? Number(input.cursor.slice(1)) : 0
            return pages[index]!
        },
    }
    const reader = createFullHistoryReader(
        { session: { get: async () => session } },
        { transport, pageSize: 2 },
    )
    return { reader, calls }
}

test("full history pages through stored rows and keeps pre-compaction originals", async () => {
    const { reader, calls } = harness([
        page([oldUser, oldAssistant], "p1"),
        page([compacted, newUser]),
    ])
    const messages = await reader(session.id)
    assert.deepEqual(
        messages.map((message) => message.info.id),
        ["msg_old_user", "msg_old_assistant", "msg_new_user"],
    )
    assert.ok(messages.every((message) => message.info.sessionID === session.id))
    assert.deepEqual(calls, [
        { sessionID: session.id, order: "asc" },
        { sessionID: session.id, cursor: "p1" },
    ])
})

test("history transport reports an unavailable service", async () => {
    const ctx = {
        session: { get: async () => session },
        location: { directory: "C:/work" },
    }
    const reader = createFullHistoryReader(ctx, {
        transport: createHistoryTransport(ctx, {
            discover: async () => undefined,
        }),
    })
    await assert.rejects(reader(session.id), /registered local OpenCode service/)
})

test("history transport carries authentication and the current location", async () => {
    let received: Record<string, string> | undefined
    const ctx = {
        session: { get: async () => session },
        location: { directory: "C:/work" },
    }
    const reader = createFullHistoryReader(ctx, {
        transport: createHistoryTransport(ctx, {
            discover: async () => ({ url: "http://127.0.0.1:1234" }),
            headers: async () => ({ authorization: "Basic test" }),
            make: async (options) => {
                received = options.headers
                return {
                    message: {
                        list: async () => page([oldUser]),
                    },
                }
            },
        }),
    })
    const messages = await reader(session.id)
    assert.deepEqual(
        messages.map((message) => message.info.id),
        [oldUser.id],
    )
    assert.equal((received as Record<string, string>)["x-opencode-location"], "C:/work")
    assert.equal((received as Record<string, string>).authorization, "Basic test")
})

test("an aborted full-history read does not page", async () => {
    const { reader, calls } = harness([page([oldUser])])
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(
        reader(session.id, controller.signal),
        (error: Error) => error.name === "AbortError",
    )
    assert.deepEqual(calls, [])
})

test("readback uses fullMessages and never allocates historical refs", async () => {
    const state = createSessionState("compact")
    state.sessionId = session.id
    const ctx = {
        state,
        logger: { info() {}, warn() {}, error() {}, debug() {} },
        allowSubAgents: true,
        client: {
            session: {
                get: async () => ({ data: { parentID: undefined } }),
                fullMessages: async (sessionID: string) => {
                    assert.equal(sessionID, session.id)
                    const reader = createFullHistoryReader(
                        { session: { get: async () => session } },
                        { transport: { list: async () => page([oldUser]) } },
                    )
                    return reader(sessionID)
                },
            },
        },
    }
    const readback = createReadbackTool(ctx as never)
    const result = await readback.execute(
        {
            startId: "msg_old_user",
            mode: "text",
            limit: 10,
            caseSensitive: false,
            maxChars: 4_000,
        } as never,
        {
            sessionID: session.id,
            messageID: "msg_current",
            abort: new AbortController().signal,
            ask: async () => {},
            metadata: () => {},
        } as never,
    )
    const parsed = JSON.parse(String(result))
    assert.equal(parsed.sources[0].sourceId, "msg_old_user")
    assert.equal(state.messageIds.byRef.size, 0)
    assert.equal(state.messageIds.nextRef, 1)
})

test("readback cursor pages reconstruct originals and search keeps its initial boundary", async () => {
    const state = createSessionState("compact")
    state.sessionId = session.id
    const rows = [oldUser, oldAssistant]
    const reader = createFullHistoryReader(
        { session: { get: async () => session } },
        { transport: { list: async () => page(rows) } },
    )
    const readback = createReadbackTool({
        state,
        logger: { info() {}, warn() {}, error() {}, debug() {} },
        allowSubAgents: true,
        client: { session: { get: async () => ({ data: {} }), fullMessages: reader } },
    } as never)
    const context = {
        sessionID: session.id,
        messageID: "msg_current",
        abort: new AbortController().signal,
        ask: async () => {},
        metadata: () => {},
    }
    const read = async (input: Record<string, unknown>) =>
        JSON.parse(String(await readback.execute(input as never, context as never)))
    const selection = { startId: oldUser.id, endId: oldAssistant.id }
    const complete = await read(selection)
    const fragments = new Map<string, string>()
    let cursor: string | undefined
    do {
        const result = await read({ ...selection, maxChars: 35, cursor })
        for (const source of result.sources) {
            const previous = fragments.get(source.sourceId) ?? ""
            assert.equal(source.offset, previous.length)
            fragments.set(source.sourceId, previous + source.text)
        }
        cursor = result.nextCursor ?? undefined
    } while (cursor)
    assert.deepEqual(
        [...fragments],
        complete.sources.map((source: { sourceId: string; text: string }) => [
            source.sourceId,
            source.text,
        ]),
    )

    const first = await read({ query: "old", limit: 1 })
    assert.equal(first.sources[0].sourceId, oldUser.id)
    assert.ok(first.nextCursor)
    rows.push(user("msg_later", "old later evidence", 4))
    const second = await read({ query: "old", limit: 1, cursor: first.nextCursor })
    assert.equal(second.sources[0].sourceId, oldAssistant.id)
    assert.equal(second.nextCursor, null)
    const fresh = await read({ query: "old" })
    assert.deepEqual(
        fresh.sources.map((source: { sourceId: string }) => source.sourceId),
        [oldUser.id, oldAssistant.id, "msg_later"],
    )
    assert.equal(state.messageIds.nextRef, 1)
})

test("readback fails explicitly without a full-history backend", async () => {
    const state = createSessionState("compact")
    state.sessionId = session.id
    const readback = createReadbackTool({
        state,
        logger: { info() {}, warn() {}, error() {}, debug() {} },
        allowSubAgents: true,
        client: { session: { get: async () => ({ data: {} }) } },
    } as never)
    await assert.rejects(
        readback.execute(
            { startId: "msg_old_user" } as never,
            {
                sessionID: session.id,
                messageID: "msg_current",
                abort: new AbortController().signal,
                ask: async () => {},
                metadata: () => {},
            } as never,
        ),
        /fullMessages backend/,
    )
})
