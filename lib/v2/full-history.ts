import type { WithParts } from "../state"
import { history } from "./messages"

/** A page from the host's public session.message list API. */
export interface FullHistoryPage {
    readonly data: ReadonlyArray<unknown>
    readonly cursor?: {
        readonly previous?: string | null
        readonly next?: string | null
    } | null
}

/** The minimal authenticated host surface needed for complete session history. */
export interface FullHistoryTransport {
    list(
        input: {
            readonly sessionID: string
            readonly limit?: number
            readonly order?: "asc" | "desc"
            readonly cursor?: string
        },
        options?: { readonly signal?: AbortSignal },
    ): Promise<FullHistoryPage>
}

/** Session metadata needed by the existing observable-message projection. */
export interface FullHistorySession {
    readonly id: string
    readonly agent?: string
    readonly model?: {
        readonly providerID?: string
        readonly id?: string
        readonly variant?: string
    }
    readonly directory?: string
    readonly location?: {
        readonly directory?: string
    }
}

export interface FullHistoryContext {
    readonly session: {
        get(input: { readonly sessionID: string }): Promise<unknown>
    }
    readonly location?: {
        readonly directory?: string
    }
    /** Host-provided authenticated transport. */
    readonly transport?: FullHistoryTransport
}

export type FullHistoryReader = (sessionID: string, signal?: AbortSignal) => Promise<WithParts[]>

export interface FullHistoryOptions {
    readonly transport?: FullHistoryTransport
    readonly pageSize?: number
}

interface HostEndpoint {
    readonly url: string
    readonly auth?: {
        readonly type: "basic"
        readonly username: string
        readonly password: string
    }
}

interface HostClient {
    readonly message: FullHistoryTransport
}

type HeaderBag = Record<string, string>

export interface FullHistoryHostDeps {
    readonly discover?: () => Promise<HostEndpoint | undefined>
    readonly make?: (options: {
        readonly baseUrl: string
        readonly headers?: HeaderBag
    }) => Promise<HostClient>
    readonly headers?: (endpoint: HostEndpoint) => Promise<HeaderBag | undefined>
}

const DEFAULT_PAGE_SIZE = 200

function defaultHostDeps(): Required<FullHistoryHostDeps> {
    return {
        async discover() {
            const { Service } = await import("@opencode/client/service")
            return Service.discover() as Promise<HostEndpoint | undefined>
        },
        make: makeClient,
        headers: serviceHeaders,
    }
}

async function makeClient(options: {
    readonly baseUrl: string
    readonly headers?: HeaderBag
}): Promise<HostClient> {
    const { OpenCode } = await import("@opencode/client")
    return OpenCode.make(options) as unknown as HostClient
}

async function serviceHeaders(endpoint: HostEndpoint): Promise<HeaderBag | undefined> {
    const { Service } = await import("@opencode/client/service")
    return Service.headers(endpoint)
}

/** Connects through the host's registered service and authentication. */
export function createHistoryTransport(
    ctx: FullHistoryContext,
    deps: FullHistoryHostDeps = {},
): FullHistoryTransport {
    const host = { ...defaultHostDeps(), ...deps }
    let ready: HostClient | undefined

    const connect = async (signal?: AbortSignal): Promise<HostClient> => {
        const endpoint = await host.discover()
        signal?.throwIfAborted()
        if (!endpoint) {
            throw new Error(
                "DCP full-history readback requires a registered local OpenCode service",
            )
        }
        const location = ctx.location?.directory
        const headers = {
            ...((await host.headers(endpoint)) ?? {}),
            ...(location ? { "x-opencode-location": location } : {}),
        }
        return host.make({ baseUrl: endpoint.url, headers })
    }

    return {
        async list(input, options) {
            options?.signal?.throwIfAborted()
            const client = ready ?? (await connect(options?.signal))
            ready = client
            options?.signal?.throwIfAborted()
            return client.message.list(input, options)
        },
    }
}

/**
 * Reads the complete durable message history for one session. This deliberately
 * uses the host's message list API rather than session.context: context is
 * bounded by the latest completed compaction, while message.list walks the
 * stored rows and therefore includes pre-compaction and released-range history.
 */
export function createFullHistoryReader(
    ctx: FullHistoryContext,
    options: FullHistoryOptions = {},
): FullHistoryReader {
    const source = options.transport ?? ctx.transport ?? createHistoryTransport(ctx)
    const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE

    return async (sessionID, signal) => {
        signal?.throwIfAborted()
        const session = (await ctx.session.get({ sessionID })) as FullHistorySession
        signal?.throwIfAborted()

        const entries: unknown[] = []
        let cursor: string | undefined
        while (true) {
            signal?.throwIfAborted()
            const page = await source.list(
                {
                    sessionID,
                    limit: pageSize,
                    ...(cursor === undefined ? { order: "asc" as const } : { cursor }),
                },
                signal ? { signal } : undefined,
            )
            signal?.throwIfAborted()
            entries.push(...page.data)
            const next = page.cursor?.next ?? undefined
            if (!next) break
            cursor = next
        }

        const messages = history(
            entries as Parameters<typeof history>[0],
            session as Parameters<typeof history>[1],
        )
        // A compaction row is bookkeeping, not original observable content.
        return messages.filter((message) => message.info.summary !== true)
    }
}
