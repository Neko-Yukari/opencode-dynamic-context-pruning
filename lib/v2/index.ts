import type { Plugin } from "@opencode/plugin"
import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import { getConfig } from "../config"
import { Logger } from "../logger"
import { PromptStore } from "../prompts/store"
import { createCompressMessageTool, createCompressRangeTool } from "../compress"
import { runAutoFold } from "../compress/autofold"
import { attachCompressionDuration } from "../compress/state"
import { createCommandExecuteHandler, createSystemPromptHandler } from "../hooks"
import {
    createSessionState,
    ensureSessionInitialized,
    checkSession,
    saveSessionState,
    syncToolCache,
    type SessionState,
} from "../state"
import { assignMessageRefs } from "../message-ids"
import { applyPendingManualTrigger } from "../commands/manual"
import {
    buildPriorityMap,
    buildToolIdList,
    injectCompressNudges,
    injectMessageIds,
    injectExtendedSubAgentResults,
    prune,
    stripHallucinations,
    syncCompressionBlocks,
} from "../messages"
import { countTokens } from "../token-utils"
import { matchesGlob } from "../protected-patterns"
import { history, project } from "./messages"
import { analyzeContextTokens } from "../commands/context"
import { buildStatsReport } from "../commands/stats"
import { rpc } from "./rpc"
import { MODEL_SELECTION_INSTRUCTIONS } from "../compress/model"
import { nativeToolSignal } from "./cancellation"
import { createSummarizer } from "./summarizer"
import { createReadbackTool } from "../readback"
import { consumeNoteInjection, createNotes } from "../notes"
import { createReleaseTool } from "../release"
import { createFullHistoryReader } from "./full-history"
import { injectSessionNote, NOTE_INSTRUCTIONS } from "./note-context"

// Extension point for future model-invisible V2 reports. Never use synthetic()
// here: its text would enter the model's context, unlike V1 ignored messages.
export async function report(logger: Logger, text: string, sessionID?: string) {
    logger.debug("V2 report (display pending)", { sessionID, text })
}

export async function setup(ctx: Plugin.Context) {
    const warnings = {
        tui: {
            showToast: async (input: { body: { message: string } }) => {
                console.warn(`DCP: ${input.body.message}`)
            },
        },
    }
    const config = getConfig({ directory: ctx.location.directory, client: warnings })
    if (!config.enabled) {
        await ctx.rpc.register(
            { ...rpc, methods: { status: rpc.methods.status } },
            { status: async () => ({ enabled: false }) },
        )
        return
    }
    const logger = new Logger(config.debug)
    const notes = createNotes(ctx.storage)
    const fullHistory = createFullHistoryReader(ctx)
    // One summarizer instance serves both the compress tool and auto-fold.
    const summarizer = createSummarizer(ctx)
    const prompts = new PromptStore(
        logger,
        ctx.location.directory,
        config.experimental.customPrompts,
        "compact",
        config.compress.model !== undefined,
    )
    if (config.compress.model !== undefined) {
        // The tool contract differs, so the system prompt is replaced outright.
        // The context-limit nudge stays a PromptStore default so user overrides win.
        const original = prompts.getRuntimePrompts.bind(prompts)
        prompts.getRuntimePrompts = () => ({ ...original(), system: MODEL_SELECTION_INSTRUCTIONS })
    }
    const sessions = new Map<string, SessionState>()
    const limits = new Map<string, { context: number; output?: number }>()
    const aliases: Record<string, string> = {
        task: "subagent",
        bash: "shell",
        apply_patch: "patch",
    }
    for (const list of [
        config.compress.protectedTools,
        config.commands.protectedTools,
        config.strategies.deduplication.protectedTools,
        config.strategies.purgeErrors.protectedTools,
    ]) {
        for (const name of [...list])
            if (aliases[name] && !list.includes(aliases[name]!)) list.push(aliases[name]!)
    }

    const client = {
        session: {
            fullMessages: fullHistory,
            get: async ({ path }: { path: { id: string } }) => ({
                data: await ctx.session.get({ sessionID: path.id }),
            }),
            messages: async ({ path }: { path: { id: string } }) => {
                const [entries, session] = await Promise.all([
                    ctx.session.context({ sessionID: path.id }),
                    ctx.session.get({ sessionID: path.id }),
                ])
                return { data: history(entries, session) }
            },
            prompt: async (input: {
                path: { id: string }
                body: { parts: Array<{ text: string }> }
            }) =>
                report(logger, input.body.parts.map((part) => part.text).join("\n"), input.path.id),
        },
        tui: {
            showToast: async (input: { body: { message: string } }) =>
                report(logger, input.body.message),
        },
    }

    async function load(sessionID: string, agentID?: string) {
        const [session, entries] = await Promise.all([
            ctx.session.get({ sessionID }),
            ctx.session.context({ sessionID }),
        ])
        const selected =
            agentID ??
            session.agent ??
            entries.findLast((entry) => entry.type === "assistant")?.agent
        if (!selected) throw new Error("DCP commands require a session with a selected agent")
        const { data: agent } = await ctx.agent.get({ agentID: selected })
        let state = sessions.get(sessionID)
        if (!state) {
            state = createSessionState("compact")
            sessions.set(sessionID, state)
        }
        const messages = history(entries, session)
        await ensureSessionInitialized(
            client,
            state,
            sessionID,
            logger,
            messages,
            config.manualMode.enabled,
        )
        await checkSession(client, state, logger, messages, config.manualMode.enabled)
        const rule = [...agent.permissions, ...(session.permissions ?? [])].findLast(
            (rule) => matchesGlob("compress", rule.action) && matchesGlob("*", rule.resource),
        )
        state.compressPermission =
            config.compress.permission === "deny"
                ? "deny"
                : rule?.effect === "deny"
                  ? "deny"
                  : config.compress.permission === "ask" || rule?.effect === "ask"
                    ? "ask"
                    : "allow"
        return { state, entries, session, messages }
    }

    function allowed(state: SessionState) {
        if (state.isSubAgent && !config.experimental.allowSubAgents)
            throw new Error("DCP compression is disabled in subagents")
        if (state.compressPermission === "deny") throw new Error("DCP compression is denied")
        if (state.compressPermission === "ask")
            throw new Error(
                "DCP: compress permission 'ask' is not supported by OpenCode V2's public plugin API yet. Compression was not performed.",
            )
    }

    await ctx.model.transform((editor) => {
        limits.clear()
        for (const model of editor.list())
            limits.set(`${model.providerID}/${model.id}`, {
                context: model.limit.context,
                output: model.limit.output,
            })
    })
    for (const kind of ["context", "compaction"] as const)
        await ctx.session.hook(kind, async (event) => {
            const { state, entries, session, messages } = await load(event.sessionID, event.agent)
            if (state.isSubAgent && !config.experimental.allowSubAgents) {
                delete event.tools.compress
                delete event.tools.dcp_read
                delete event.tools.dcp_release
                delete event.tools.dcp_note
                return
            }
            if (state.compressPermission === "deny") {
                delete event.tools.compress
                delete event.tools.dcp_release
                delete event.tools.dcp_note
            }
            const limit = limits.get(`${event.model.providerID}/${event.model.id}`)
            state.modelContextLimit = limit?.context
            state.modelOutputLimit = limit?.output
            state.systemPromptTokens = countTokens(event.system.map((part) => part.text).join("\n"))
            if (kind === "context") {
                // Billion-context-style reduction before the request is forwarded.
                // It only creates ordinary blocks, so prune() below injects the
                // summary in this same request. Failures leave context untouched.
                await runAutoFold({
                    ctx: { client, state, logger, config, prompts, summarizer },
                    sessionID: event.sessionID,
                    messages,
                })
            }
            const view = project(event.messages, entries, {
                ...session,
                agent: event.agent,
                model: event.model,
            })
            stripHallucinations(view.messages, state.idFormat)
            const assignedRefs = assignMessageRefs(state, view.messages)
            if (assignedRefs > 0) await saveSessionState(state, logger)
            // Compaction may select only a prefix; block origins can be in the retained tail.
            syncCompressionBlocks(state, logger, messages)
            syncToolCache(state, config, logger, view.messages)
            buildToolIdList(state, view.messages)
            prune(state, logger, config, view.messages, view.summaryBase)
            await injectExtendedSubAgentResults(
                client,
                state,
                logger,
                view.messages,
                config.experimental.allowSubAgents,
            )
            const priorities = buildPriorityMap(config, state, view.messages)
            prompts.reload()
            injectCompressNudges(
                state,
                config,
                logger,
                view.messages,
                prompts.getRuntimePrompts(),
                priorities,
                kind === "context",
            )
            injectMessageIds(state, config, view.messages, priorities)
            applyPendingManualTrigger(state, view.messages, logger)
            event.messages = view.restore()
            if (consumeNoteInjection(event.sessionID)) {
                const note = await notes.get(event.sessionID)
                event.messages = injectSessionNote(event.messages, event.sessionID, note?.content ?? "")
            }
            const system = { system: event.system.map((part) => part.text) }
            await createSystemPromptHandler(
                state,
                logger,
                config,
                prompts,
            )(
                {
                    sessionID: event.sessionID,
                    model: { limit: { context: state.modelContextLimit ?? 0 } },
                },
                system,
            )
            event.system = system.system.map((text, index) => ({
                ...event.system[index],
                type: "text",
                text,
            }))
            if (state.compressPermission !== "deny")
                event.system.push({ type: "text", text: NOTE_INSTRUCTIONS })
            await logger.saveContext(event.sessionID, view.messages)
        })

    const defineReadback = (state: SessionState) =>
        createReadbackTool({
            client,
            state,
            logger,
            allowSubAgents: config.experimental.allowSubAgents,
        })
    const readback = defineReadback(createSessionState("compact"))
    await ctx.tool.transform((editor) =>
        editor.add({
            name: "dcp_read",
            description: readback.description,
            input: tool.schema.object(readback.args),
            options: { codemode: true, permission: "dcp_read" },
            execute: async (input, context) => {
                const legacy = defineReadback(
                    sessions.get(context.sessionID) ?? createSessionState("compact"),
                )
                const content = await legacy.execute(input, {
                    sessionID: context.sessionID,
                    messageID: context.messageID,
                    agent: context.agent,
                    directory: ctx.location.directory,
                    worktree: ctx.location.directory,
                    abort: nativeToolSignal(context) ?? new AbortController().signal,
                    ask: async () => {
                        await ctx.permission.assert({
                            sessionID: context.sessionID,
                            agent: context.agent,
                            action: "dcp_read",
                            resources: ["*"],
                            source: {
                                type: "tool",
                                messageID: context.messageID,
                                id: context.id,
                            },
                        })
                    },
                    metadata: ({ title }: { title?: string }) => {
                        void context.progress({ title })
                    },
                })
                return { content: content as string }
            },
        }),
    )

    if (config.compress.permission !== "deny") {
        await ctx.tool.transform((editor) =>
            editor.add({
                name: "dcp_note",
                description:
                    "Prepare the current session's continuation checkpoint before context reduction. The note is injected once after each successful compression or release. Read returns a fixed Markdown draft path for existing file tools. Write commits the reviewed draft, including when unchanged, before compress or dcp_release. Keep only facts needed after removal of the selected history. Successful commits or reductions need no follow-up note entry. About 8,000 characters is guidance, not a target or hard limit. Parent and child notes are separate.",
                input: tool.schema.object({ action: tool.schema.enum(["read", "write"]) }).strict(),
                options: { codemode: true, permission: "compress" },
                execute: async (input, context) => {
                    nativeToolSignal(context)?.throwIfAborted()
                    const { state } = await load(context.sessionID, context.agent)
                    allowed(state)
                    // Only model-actionable facts leave the plugin: the draft path
                    // and whether it differs from the committed note.
                    if (input.action === "read") {
                        const draft = await notes.read(context.sessionID)
                        return {
                            content: `Note draft: ${draft.path}\nDirty: ${draft.dirty ? "yes" : "no"}`,
                        }
                    }
                    const committed = await notes.write(context.sessionID)
                    return { content: `Note committed: ${committed.path}` }
                },
            }),
        )

        const defineRelease = (state: SessionState) =>
            createReleaseTool({ client, state, logger, config, prompts })
        const releaseDefinition = defineRelease(createSessionState("compact"))
        await ctx.tool.transform((editor) =>
            editor.add({
                name: "dcp_release",
                description: releaseDefinition.description,
                input: tool.schema.object(releaseDefinition.args),
                options: { codemode: true, permission: "compress" },
                execute: async (input, context) => {
                    const abort = nativeToolSignal(context)
                    abort?.throwIfAborted()
                    const { state } = await load(context.sessionID, context.agent)
                    allowed(state)
                    const legacy = defineRelease(state)
                    const content = await legacy.execute(input, {
                        sessionID: context.sessionID,
                        messageID: context.messageID,
                        callID: context.id,
                        agent: context.agent,
                        directory: ctx.location.directory,
                        worktree: ctx.location.directory,
                        abort: abort ?? new AbortController().signal,
                        ask: async () => allowed(state),
                        metadata: ({ title }: { title?: string }) => {
                            void context.progress({ title })
                        },
                    } as Parameters<typeof legacy.execute>[1])
                    return { content: content as string }
                },
            }),
        )

        const define = (state: SessionState): ToolDefinition =>
            (config.compress.mode === "message" && config.compress.model === undefined
                ? createCompressMessageTool
                : createCompressRangeTool)({
                client,
                state,
                logger,
                config,
                prompts,
                summarizer,
            })
        const definition = define(createSessionState("compact"))
        await ctx.tool.transform((editor) =>
            editor.add({
                name: "compress",
                description: definition.description,
                input: tool.schema.object(definition.args),
                options: { codemode: true, permission: "compress" },
                execute: async (input, context) => {
                    const abort = nativeToolSignal(context)
                    abort?.throwIfAborted()
                    const { state } = await load(context.sessionID, context.agent)
                    allowed(state)
                    const started = Date.now()
                    const legacy = define(state)
                    const content = await legacy.execute(input, {
                        sessionID: context.sessionID,
                        messageID: context.messageID,
                        callID: context.id,
                        agent: context.agent,
                        directory: ctx.location.directory,
                        worktree: ctx.location.directory,
                        abort: abort ?? new AbortController().signal,
                        ask: async () => allowed(state),
                        metadata: ({ title }: { title?: string }) => {
                            void context.progress({ title })
                        },
                    } as Parameters<typeof legacy.execute>[1])
                    attachCompressionDuration(
                        state.prune.messages,
                        context.messageID,
                        context.id,
                        Date.now() - started,
                    )
                    await saveSessionState(state, logger)
                    // Both shared compression executors return text; the V1 helper's
                    // public return type also permits unrelated attachment results.
                    return { content: content as string }
                },
            }),
        )
    }
    if (config.commands.enabled)
        await ctx.command.transform((editor) => {
            for (const name of ["dcp", "dcp-compress"])
                editor.add({
                    name,
                    description: name === "dcp" ? "DCP commands" : "Trigger DCP manual compression",
                    execute: async (invocation) => {
                        const { state } = await load(invocation.sessionID)
                        const permission = state.compressPermission ?? config.compress.permission
                        if (
                            name === "dcp-compress" ||
                            invocation.prompt.text.trim().split(/\s+/)[0] === "compress"
                        )
                            allowed(state)
                        const output = { parts: [] }
                        await createCommandExecuteHandler(
                            client,
                            state,
                            logger,
                            config,
                            ctx.location.directory,
                            { global: { compress: permission }, agents: {} },
                        )(
                            {
                                command: name,
                                sessionID: invocation.sessionID,
                                arguments: invocation.prompt.text,
                            },
                            output,
                        )
                        state.compressPermission = permission
                        const pending = state.pendingManualTrigger
                        if (pending) {
                            allowed(state)
                            state.pendingManualTrigger = null
                            await ctx.session.prompt({
                                sessionID: invocation.sessionID,
                                text: pending.prompt,
                                delivery: invocation.delivery,
                            })
                        }
                    },
                })
        })
    await ctx.rpc.register(rpc, {
        status: async () => ({ enabled: config.commands.enabled }),
        snapshot: async ({ sessionID }) => {
            const { state, messages } = await load(sessionID)
            syncCompressionBlocks(state, logger, messages)
            return {
                manualMode: !!state.manualMode,
                canCompress:
                    state.compressPermission === "allow" &&
                    (!state.isSubAgent || config.experimental.allowSubAgents),
                ...(state.compressPermission === "ask"
                    ? {
                          blockedReason:
                              "Permission 'ask' is not supported by the V2 plugin API yet.",
                      }
                    : {}),
                context: analyzeContextTokens(state, messages),
                stats: await buildStatsReport(state, logger),
            }
        },
        manual: async ({ sessionID, enabled }) => {
            const { state } = await load(sessionID)
            state.manualMode = enabled ? "active" : false
            await saveSessionState(state, logger)
            return {}
        },
    })
    logger.info("DCP V2 initialized")
    return () => {
        sessions.clear()
        limits.clear()
    }
}
