# Dynamic Context Pruning Plugin

[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/dansmolsky)
[![npm version](https://img.shields.io/npm/v/@tarquinen/opencode-dcp.svg)](https://www.npmjs.com/package/@tarquinen/opencode-dcp)

Automatically reduces token usage in OpenCode by managing conversation context.

![DCP in action](assets/images/dcp-demo9.png)

## Installation

Install from the OpenCode V2 CLI:

```bash
opencode plugin add @tarquinen/opencode-dcp@latest
```

This installs the package and adds it to your global OpenCode config.

## Project Status

Development on DCP has slowed because most new context-management work has moved to [Sleev](https://sleev.ai) and the `sleev` CLI.

Sleev builds on DCP's core ideas with more advanced context management and significantly better performance. It's a local proxy that already supports Claude Code, Codex, OpenCode, Pi, and Hermes, and can be extended to support any harness.

DCP remains available for OpenCode plugin users, but new features are landing in Sleev first. If you are starting fresh, we recommend trying Sleev:

```bash
npm i -g sleev
sleev
```

## How It Works

DCP reduces context size through compression and automatic cleanup. On OpenCode V2, it can also release completed history explicitly. Your stored session history is never modified: before each request DCP replaces compressed or pruned content with summaries or placeholders and leaves released ranges out.

### Compress

Compress is a tool exposed to your model that replaces closed, stale conversation content with high-fidelity technical summaries. You can think of this as a much smarter version of Opencode's compaction process. Instead of triggering statically when your session reaches its maximum context and on the entire coding session, Compress allows the model to pick when to activate based on task completion, and to only compress the specific messages that are no longer needed verbatim.

DCP supports two compression modes:

- `range` mode compresses contiguous spans of conversation into one or more summaries.
- `message` mode (experimental) compresses individual raw messages independently, letting the model manage context much more surgically.

In `range` mode, compressing content that overlaps an earlier summary re-summarizes it:
the summarizer receives the selected older summaries and the new messages, then writes
one new overall summary for the range. It does not receive the older summaries' full
original bodies, so detail can be lost across repeated rounds; the originals stay
available through `dcp_read` as long as the host retains them, including after native
compaction. Protected tool outputs (such as subagents and skills), protected file
patterns, `protectTags` and `protectUserMessages` still apply independently to the
selected range, so the most important information is never lost. Note that large prompts
(e.g. copy-pasting log files in the prompt) will never be compressed away when
`protectUserMessages` is enabled.

### Session note (OpenCode V2)

The session note and `dcp_release` described below are registered by the OpenCode V2 plugin. The legacy V1 integration exposes only `compress` and `dcp_read`.

V2 keeps one formal note per session in the session database and a fixed per-session Markdown draft. `dcp_note({ "action": "read" })` returns the draft path and revision, its character count, suggested size and `dirty` flag. Edit the draft with the normal `read`, `grep`, `edit`, `patch` or `write` tools, then commit it with `dcp_note({ "action": "write" })`:

```json
{ "action": "read" }
{ "action": "write" }
```

A commit is accepted even when the draft is unchanged. The note is an agent-maintained work record, not a replacement summary, and it has no hard size limit; about 8,000 characters is suggested.

The note is injected once after each successful compression or release. Keep only facts needed after the selected history is removed. Omit transcripts, routine progress and context-management bookkeeping. No follow-up note entry or status report is needed solely to record a successful note commit, compression or release. Use the shortest sufficient note; the suggested size is not a target.

The note is user-maintained; update it only when the user explicitly asks. `compress` and `dcp_release` do not require a review hash, a note commit or a clean draft.

Only the committed note enters context. It is injected once after each successful compression or release, in a protected user-role data message outside the prunable history, never as a system instruction, and grants no authority; current user instructions and verified evidence take precedence. Each session has its own note and draft, including each parent and child session.

Read creates the draft from the stored note only when the draft is missing. Existing draft content stays intact and is reported `dirty` when it differs from the stored note. Write commits the current draft directly; it does not track base revisions or create recovery copies.

The draft is stored at `${XDG_DATA_HOME:-~/.local/share}/opencode/storage/dcp-notes/<session-folder>/note.md` and stays stable when the workspace moves; the formal note lives in the session database. Note operations use the host's plain get/set storage. The draft is outside the workspace, so the host's normal file-access rules for external directories apply when you edit it; DCP does not bypass them.

### Release completed history (OpenCode V2)

`dcp_release` removes completed history from context without writing a summary. Pass a short `topic` and one or more `{ "startId": ..., "endId": ... }` ranges:

```json
{
    "topic": "Finished auth exploration",
    "content": [{ "startId": "@12@", "endId": "@18@" }]
}
```

Use visible message IDs or complete active block IDs as bounds; using a block ID for both bounds releases that whole block. Messages already hidden inside a block are not selectable as bounds and can only be inspected through `dcp_read`. A released block is readback-only. Every range must be closed (no in-progress tool calls), ranges in one call must not overlap, and a release call cannot include itself.

Released regions become holes: their messages and any recorded summary stop entering context, and released blocks cannot be selected again. The originals remain available through `dcp_read`. Release is one-way: `dcp_release` has no restore, and the `/dcp decompress` and `/dcp recompress` commands report that restore is disabled.

### Native compaction (OpenCode V2)

Native compaction starts a new host history. DCP clears its summaries, compression blocks (including released blocks) and old message-reference aliases. The committed session note survives, and message-reference, block and run ID counters keep increasing, so an old alias never resolves to new content.

Released regions stay omitted, and old block references stop working after compaction. `dcp_read` can still read originals by source message ID, and search still covers them, as long as the host retains the underlying message rows.

### Automatic end-of-turn folding (OpenCode V2)

`compress.autoFold` keeps a large-window model on a much smaller resident context.
Each fold is prepared after a turn ends and only substituted when the next request
is built, so no summarizer call sits on the request path. In the prepare step DCP
measures the actual context tokens and, when the context is above
`targetTokens + minGrowthTokens`, has the configured model summarize the oldest
safe contiguous history. The folded blocks are created by the context hook from
that prepared artifact, reusing the same internal range path as the manual
compress tool, so block state, protection, statistics, readback and release
behavior stay identical.

```jsonc
{
    "compress": {
        "autoFold": {
            "enabled": true,
            // Keep roughly 100k resident context on a 1M-token model
            "targetTokens": 100000,
            "minGrowthTokens": 4096,
            // Skip the fold unless the safe ranges can reclaim this much
            "minFoldTokens": 20000,
            "keepRecentMessages": 3,
        },
        // Optional: let a dedicated model write the folded summaries
        "model": "anthropic/claude-haiku-4-5",
    },
}
```

Safety rules:

- Never runs in subagents, internal agent calls, denied or `ask` permission, manual
  mode, or when the target is not exceeded.
- At most one prepared fold per turn and one projection per prepared fold, with
  hysteresis from `minGrowthTokens`.
- A fold whose safe ranges reclaim less than `minFoldTokens` is skipped before the
  summarizer runs, so a long turn cannot spend a model call per request on slivers.
- The newest `keepRecentMessages` messages, the active turn and any pending or running
  tool calls are always retained, and ranges never overlap an active block.
- The request hook never calls a model: it substitutes a prepared artifact, and when
  none applies it skips the fold and logs the reason. A prepared range whose boundaries
  no longer map to the same messages is dropped instead of forced.
- With `compress.model` set, the configured model authors each folded summary during
  the prepare step. Without it, DCP writes a clearly labelled mechanical digest
  instead of pretending a summary was authored.
- Failures fail open: the original context is left untouched and a warning is logged.

Each fold reports its progress with chat notices, rendered through the same host message
mechanism peer messages use. `触发自动压缩` marks the prepare step that starts spending a
summarizer call, and `自动压缩已应用：<before> → <after>，折叠 <n> 条消息（<m> 段）—— <overview>`
reports the committed fold, where the overview is the opening sentence of each substituted
summary. A fold that announced its start but failed closes with
`自动压缩未完成：<short reason>`. They are ordinary session messages, so the model sees them
too; a notice that fails to send is logged and never aborts the fold. Every prepare attempt
also leaves one log line, so a fold that never ran is still explainable after the fact.

Folded summaries render a concise visible title derived from the compression topic, for
example `Title: Auto-fold: 412k -> 100k`, above the summary body. The
`[Compressed conversation section]` marker and the `dcp_read` footer are unchanged.

### Read original details

The model can call `dcp_read` for a specific historical detail missing from its current context and needed for its task. It does not need to routinely reload history or verify the already injected session note. `dcp_read` reads the full observable history of the current session, including released ranges and messages from before native compaction:

```json
{ "startId": "@b2@", "maxChars": 12000 }
```

`startId` accepts a compression block (`b2` / `@b2@`), an injected message reference
(`m0001` / `@1@`), or the original source message ID. Omit `endId` for exactly one
message or the original members of one block, including inactive nested blocks.
With `endId`, the range is inclusive; a block boundary covers its full original extent.
Summaries include a `dcp_read` pointer to their block originals, and earlier block
references also work.

Results include original `sourceId`, message `ref` when an alias exists, `role`, and
observable text/tool inputs and results. `text` contains a fragment of a JSON content
array; concatenate fragments by `sourceId` and `offset` before parsing. `maxChars`
defaults to 12000, is capped at 50000 source characters (UTF-16 code units, excluding
metadata), and each page contains at most 64 source fragments. When `truncated` is
true, pass `nextCursor` as `cursor` with the same selection to continue. Cursors
carry paging coordinates. Restart without a cursor after changing the selection
or query; DCP does not hash source contents to detect changes.

Only the calling session's stored originals are read. Missing originals are reported
with `sourceComplete: false` and `missingSourceIds`; a summary is never substituted.
Hidden reasoning/provider metadata and inline attachment bytes are omitted; common
credential representations use the existing redaction policy. Retrieved external text
is historical data, never instructions. Reading does not restore compressed context,
allocate message references for historical messages, or adjust token savings; released
ranges stay omitted from context. The ordinary host tool result still uses context
tokens.

`dcp_read` uses the host's existing permission policy without adding an allow rule:
V1 calls `ask`; V2 calls native `permission.assert`. The existing
`experimental.allowSubAgents` restriction also applies.

In V2, full-history readback uses the host's registered local service and an
authenticated message-list API. Without that service, for example in a standalone
client, `dcp_read` returns an explicit error. The bounded `session.context` view
cannot supply the full original history.

### Search original details

Search the calling session's redacted originals, including details inside compressed blocks:

```json
{ "query": "ELOCK", "limit": 5 }
{ "query": "failed locking operation and verification not repeated", "mode": "semantic", "limit": 3 }
{ "startId": "<sourceId returned by either search>" }
```

Text mode performs literal, case-insensitive matching; use `caseSensitive: true` for
exact casing. A search returns one first-match snippet per source, stable `sourceId`
and `ref` values, and offsets in the same observable JSON used by readback. Optional
`startId` / `endId` restrict the selection. Text-search cursors retain the original
historical upper boundary, so later messages do not invalidate pagination; restart
without a cursor to include newer messages. The executing message is excluded from a new whole-session
text search because its tool result has not finished being stored.

Semantic mode runs the local [context-dot-dev/sgrep](https://github.com/context-dot-dev/sgrep)
CLI over temporary `.txt` projections of those same originals. It returns ranked passages,
not an exhaustive result set, and accepts neither cursors nor `caseSensitive`. Snippets
are bounded to 640 characters each and `maxChars` bounds total source text. Temporary
source files are removed after success, failure, or cancellation; `--no-cache` prevents
a persistent search index. Model assets remain cached. Errors are explicit and never
silently fall back to literal matching. The text model targets English prose; ranking
scores are not confidence values or evidence that a historical claim is correct.

#### Optional sgrep installation

Rust 1.90+ is required; Windows builds also need an MSVC toolchain. A tested source
revision is `dec6122c05be553c5a60bd647d1350b221b7b9c3` (sgrep 0.3.0). On Windows:

```powershell
$sgrepInstallRoot = Join-Path $env:USERPROFILE ".local\share\opencode"
$previousTslpOffline = $env:TSLP_OFFLINE
try {
    $env:TSLP_OFFLINE = "1"
    cargo install --git https://github.com/context-dot-dev/sgrep --rev dec6122c05be553c5a60bd647d1350b221b7b9c3 --locked --root $sgrepInstallRoot
    if ($LASTEXITCODE -ne 0) { throw "sgrep build failed" }
} finally {
    $env:TSLP_OFFLINE = $previousTslpOffline
}
```

On macOS/Linux, use `TSLP_OFFLINE=1 cargo install --git https://github.com/context-dot-dev/sgrep --rev dec6122c05be553c5a60bd647d1350b221b7b9c3 --locked --root "$HOME/.local/share/opencode"`.
`TSLP_OFFLINE` skips the dependency's unused build-time parser-source download; DCP uses
text mode and does not require code parsers. The Windows recipe was exercised locally;
the macOS/Linux command follows the same upstream build interface but was not retested here.

DCP honors `DCP_SGREP_BIN` first, then probes `bin` under `~/.cache/opencode`,
`~/.local/share/opencode`, `~/.cargo`, and `~/.local`, before falling back to PATH.
It finds existing ripgrep in those directories and adds its directory only to the
sgrep child process's PATH. OpenCode's bundled `rg` can therefore be reused without
another installation or a global PATH edit. If none exists, install ripgrep from its
[official project](https://github.com/BurntSushi/ripgrep) or make it available on PATH.

The first semantic query may download public assets from
[minishlab/potion-base-8M](https://huggingface.co/minishlab/potion-base-8M), revision
`bf8b056651a2c21b8d2565580b8569da283cab23`: tokenizer and weights total 30,920,426 bytes.
sgrep verifies their pinned sizes and SHA-256 hashes. Source text and queries stay local.
After warming the standard Hugging Face cache, `HF_HUB_OFFLINE=1` prevents further asset
downloads. New OpenCode processes load this plugin build; existing processes are not
restarted automatically.

### Deduplication

Identifies repeated tool calls (same tool, same arguments) and keeps only the most recent output. Recalculated when the compress tool runs, so prompt cache is only impacted alongside compression.

### Purge Errors

Prunes inputs from errored tool calls after a configurable number of turns. Error messages are preserved; only the potentially large input content is removed. Recalculated on compress tool use.

## Configuration

DCP uses its own config file, searched in order:

1. Global: `~/.config/opencode/dcp.jsonc` (or `dcp.json`), created automatically on first run
2. Custom config directory: `$OPENCODE_CONFIG_DIR/dcp.jsonc` (or `dcp.json`), if `OPENCODE_CONFIG_DIR` is set
3. Project: `.opencode/dcp.jsonc` (or `dcp.json`) in your project's `.opencode` directory

Each level overrides the previous, so project settings take priority over global. Restart OpenCode after making config changes.

> [!NOTE]
> If your model has a smaller context window, lower `compress.minContextLimit` and `compress.maxContextLimit` in your configuration to match the available context.

> [!IMPORTANT]
> Defaults are applied automatically. Expand this if you want to review or override settings.

<details>
<summary><strong>Default Configuration</strong> (click to expand)</summary>

```jsonc
{
    "$schema": "https://raw.githubusercontent.com/Opencode-DCP/opencode-dynamic-context-pruning/master/dcp.schema.json",
    // Enable or disable the plugin
    "enabled": true,
    // Automatically update npm-installed DCP when a newer npm latest is available.
    // Version-locked plugin specs are not updated.
    "autoUpdate": true,
    // Enable verbose debug logging to ~/.config/opencode/logs/dcp/ (info logs are always written)
    "debug": false,
    // Notification display: "off", "minimal", or "detailed"
    "pruneNotification": "detailed",
    // Notification type: "chat" (in-conversation) or "toast" (system toast)
    "pruneNotificationType": "chat",
    // Slash commands configuration
    "commands": {
        "enabled": true,
        // Additional tools to protect from pruning via commands (e.g., /dcp sweep)
        "protectedTools": [],
    },
    // Manual mode: disables autonomous context management,
    // tools only run when explicitly triggered via /dcp commands
    "manualMode": {
        "enabled": false,
        // When true, automatic cleanup (deduplication, purgeErrors)
        // still runs even in manual mode
        "automaticStrategies": true,
    },
    // Protect from pruning for <turns> message turns past tool invocation
    "turnProtection": {
        "enabled": false,
        "turns": 4,
    },
    // Experimental settings
    "experimental": {
        // Allow DCP processing in subagent sessions
        "allowSubAgents": false,
        // Enable user-editable prompt overrides under dcp-prompts directories
        // When false (default), prompt override files/directories are ignored
        "customPrompts": false,
    },
    // Protect file operations from pruning via glob patterns
    // Patterns match tool parameters.filePath (e.g. read/write/edit)
    "protectedFilePatterns": [],
    // Unified context compression tool and behavior settings
    "compress": {
        // Compression mode: "range" (compress spans into block summaries)
        // or experimental "message" (compress individual raw messages)
        "mode": "range",
        // Permission mode: "allow" (no prompt), "ask" (prompt), "deny" (tool not registered)
        "permission": "allow",
        // Show compression content in a chat notification
        "showCompression": false,
        // Let active summary tokens extend the effective maxContextLimit
        "summaryBuffer": true,
        // Soft upper threshold: above this, DCP keeps injecting strong
        // compression nudges (based on nudgeFrequency), so compression is
        // much more likely. Accepts: number or "X%" of model context window.
        "maxContextLimit": 100000,
        // Soft lower threshold for reminder nudges: below this, turn/iteration
        // reminders are off (compression less likely). At/above this, reminders
        // are on. Accepts: number or "X%" of model context window.
        "minContextLimit": 50000,
        // Optional per-model override for maxContextLimit by providerID/modelID.
        // If present, this wins over the global maxContextLimit.
        // Accepts: number or "X%".
        // Example:
        // "modelMaxLimits": {
        //     "provider/model": "80%"
        // },
        // Optional per-model override for minContextLimit.
        // If present, this wins over the global minContextLimit.
        // "modelMinLimits": {
        //     "provider/model": "25%"
        // },
        // How often the context-limit nudge fires (1 = every fetch, 5 = every 5th)
        "nudgeFrequency": 5,
        // Start adding compression reminders after this many
        // messages have happened since the last user message
        "iterationNudgeThreshold": 15,
        // Controls how likely compression is after user messages
        // ("strong" = more likely, "soft" = less likely)
        "nudgeForce": "soft",
        // Tool names whose completed outputs are appended to the compression
        "protectedTools": [],
        // Preserve text wrapped in <protect>...</protect> when compressed
        "protectTags": false,
        // Preserve your messages during compression.
        // Warning: large copy-pasted prompts will never be compressed away
        "protectUserMessages": false,
        // Automatic end-of-turn folding (OpenCode V2). Off by default.
        // When enabled, DCP summarizes the oldest safe history after a turn
        // ends and folds it into ordinary compression blocks when the next
        // request is built, so a large-window model can keep a much smaller
        // resident context without a model call on the request path.
        "autoFold": {
            "enabled": false,
            // Resident context budget in tokens. Folding only runs above
            // targetTokens + minGrowthTokens.
            "targetTokens": 100000,
            // Hysteresis so small fluctuations cannot trigger repeated folds
            "minGrowthTokens": 4096,
            // Newest messages always retained; the active turn is always kept
            "keepRecentMessages": 3,
        },
    },
    // Automatic pruning strategies
    "strategies": {
        // Remove duplicate tool calls (same tool with same arguments)
        "deduplication": {
            "enabled": true,
            // Additional tools to protect from pruning
            "protectedTools": [],
        },
        // Prune tool inputs for errored tools after X turns
        "purgeErrors": {
            "enabled": true,
            // Number of turns before errored tool inputs are pruned
            "turns": 4,
            // Additional tools to protect from pruning
            "protectedTools": [],
        },
    },
}
```

</details>

### Dedicated Compression Model (OpenCode V2)

Set `compress.model` to let a separate native model write range summaries. The main
model selects only a topic and range boundaries; the configured model receives
the selected observable messages, tool inputs/results and existing block summaries.

```jsonc
{
    "compress": {
        "mode": "range",
        "model": "provider/model#variant",
        // Optional, ordered fallbacks for explicitly classified provider errors:
        "fallbackModels": [],
        // Optional; otherwise derived from the selected input and output budget:
        "modelTimeoutMs": 120000,
    },
}
```

`#variant` is optional. Use a model registered with OpenCode, with known context
and output limits. This mode requires OpenCode 2.0.30 or later; leaving `model`
unset preserves the existing main-authored summaries. Message mode is not supported.

All attachments, including images and PDFs, are reference-only for the compression
model, even when it supports image input. Their payloads are never resent through
a temporary session. The summary preserves facts already present in the selected
text and explicitly states that attachment contents were not inspected. Inline
attachments are saved under
`${XDG_DATA_HOME:-~/.local/share}/opencode/storage/plugin/dcp/media` using
content-derived filenames. Summaries retain those paths or original URLs; Base64
payloads are excluded from summary text and text-token estimates. Keep these files
alongside session data when moving sessions between machines.

Missing model or variant references, provider errors, cancellation and invalid
summaries leave the original context intact. No input is silently truncated.
Fallbacks follow the configured order for explicitly classified provider errors.

The summarizer returns the summary body as plain text. The application owns the
stored summary and any metadata; an empty summary fails directly without a model
switch.

Summary length is advisory: 20% of the first 20,000 estimated source tokens, 15%
of the next 80,000 and 10% beyond that. The text recommendation is between 2,000
and 32,000 tokens. Summaries below five times that
recommendation are accepted. At or above five times, DCP rejects the reply and
makes one correction request to the same model using the same selected sources
and attachment references. A second reply at or above that threshold fails and retains the
original context.

Before requesting a summary, DCP checks the estimated text prompt and recommended
reply against the summarizer model's actual context window. There is no fixed
percentage margin. Attachment payloads are never part of this request.

Before saving a compression batch, DCP renders the proposed context through its
normal pruning path and estimates the retained history, new summaries and
protected content. It includes system overhead calibrated from reported usage
and the existing reply reserve. If that total exceeds the main model's window,
the batch is rejected before persistence and the original context is retained.

### Commands

DCP provides a TUI panel and one prompt-producing slash command:

- `/dcp` — Opens the DCP panel with context, stats, and manual-mode controls.
- `/dcp-compress [focus]` — Asks the model to run one compression pass. Optional focus text directs what content to compress, following the active `compress.mode`.

### Prompt Overrides

DCP exposes the following editable prompts:

- `system`
- `compress-range`
- `compress-message`
- `context-limit-nudge`
- `turn-nudge`
- `iteration-nudge`

This feature is disabled by default. Set `experimental.customPrompts` to `true` in your DCP config to activate it.

When enabled, managed defaults are written to `~/.config/opencode/dcp-prompts/defaults/` as plain-text prompt files. A single `README.md` in that directory explains each prompt and how to create overrides.

To customize behavior, add a file with the same name under an overrides directory and edit it as plain text.

To reset an override, delete the matching file from your overrides directory.

### Protected Tools

By default, these tools are always protected from pruning:
`task`, `skill`, `todowrite`, `todoread`, `compress`, `batch`, `plan_enter`, `plan_exit`, `write`, `edit`

The `protectedTools` arrays in `commands` and `strategies` add to this default list.

For the `compress` tool, `compress.protectedTools` ensures specific tool outputs are appended to the compressed summary. By default it includes `task`, `skill`, `todowrite`, and `todoread`.

## Impact on Prompt Caching

LLM providers cache prompts based on exact prefix matching. When DCP prunes content, it changes messages, which invalidates cached prefixes from that point forward.

**Trade-off:** Pruning reduces context size but can increase cache misses. The cost
balance depends on your conversation, compression frequency, and provider pricing.

**No impact for:**

- **Request-based billing** — Some providers charge per request, not tokens.
- **Uniform token pricing** — Providers that bill cached and uncached tokens at the same rate.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, local installation,
and testing with the V1/V2 sandbox.

## License

AGPL-3.0-or-later
