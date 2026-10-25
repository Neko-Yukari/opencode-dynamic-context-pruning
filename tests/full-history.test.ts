import assert from "node:assert/strict"
import test from "node:test"
import { createSessionState, type WithParts } from "../lib/state"
import { createReadbackTool } from "../lib/readback"
import {
    createFullHistoryReader,
    createVerifiedTransport,
    type FullHistoryHostDeps,
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

test("verified transport rejects a different service pid before message.list", async () => {
    let listCalls = 0
    let makeCalls = 0
    const ctx = {
        session: { get: async () => session },
        location: { directory: "C:/work" },
    }
    const deps: FullHistoryHostDeps = {
        discover: async () => ({ url: "http://127.0.0.1:1234" }),
        fetch: (async () => ({
            ok: true,
            status: 200,
            json: async () => ({ pid: 222 }),
        })) as unknown as typeof fetch,
        headers: async () => ({}),
        make: async () => {
            makeCalls++
            return {
                message: {
                    list: async () => {
                        listCalls++
                        return page([])
                    },
                },
            }
        },
        pid: 111,
    }
    const reader = createFullHistoryReader(ctx, {
        transport: createVerifiedTransport(ctx, deps),
    })
    await assert.rejects(reader(session.id), /different service process/)
    assert.equal(listCalls, 0)
    assert.equal(makeCalls, 0)
})

test("verified transport refuses an unregistered service", async () => {
    let fetched = false
    const ctx = {
        session: { get: async () => session },
        location: { directory: "C:/work" },
    }
    const reader = createFullHistoryReader(ctx, {
        transport: createVerifiedTransport(ctx, {
            discover: async () => undefined,
            fetch: (async () => {
                fetched = true
                return { ok: true, status: 200, json: async () => ({ pid: 1 }) }
            }) as unknown as typeof fetch,
        }),
    })
    await assert.rejects(reader(session.id), /registered local OpenCode service/)
    assert.equal(fetched, false)
})

test("verified transport carries the current location after pid verification", async () => {
    let received: Record<string, string> | undefined
    const ctx = {
        session: { get: async () => session },
        location: { directory: "C:/work" },
    }
    const reader = createFullHistoryReader(ctx, {
        transport: createVerifiedTransport(ctx, {
            discover: async () => ({ url: "http://127.0.0.1:1234" }),
            fetch: (async () => ({
                ok: true,
                status: 200,
                json: async () => ({ pid: 111 }),
            })) as unknown as typeof fetch,
            headers: async () => ({ authorization: "Basic test" }),
            make: async (options) => {
                received = options.headers
                return {
                    message: {
                        list: async () => page([oldUser]),
                    },
                }
            },
            pid: 111,
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

test("full history rejects mismatched session metadata before reading", async () => {
    let listCalls = 0
    const ctx = {
        session: { get: async () => ({ id: "other_session" }) },
        location: { directory: "C:/work" },
    }
    const reader = createFullHistoryReader(ctx, {
        transport: {
            list: async () => {
                listCalls++
                return page([])
            },
        },
    })
    await assert.rejects(reader(session.id), /different or invalid session/)
    assert.equal(listCalls, 0)
})

test("full history rejects a repeated pagination cursor", async () => {
    const { reader } = harness([page([oldUser], "p1"), page([oldAssistant], "p1")])
    await assert.rejects(reader(session.id), /repeated a cursor/)
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
        { startId: "msg_old_user", maxChars: 4_000 } as never,
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
