# Auto-fold summary leaks into visible chat text, and turn-end prepare never fires

Status: **report only — this PR changes no code.** Filed so the fix can be planned against
the real trace rather than a reproduction guess.

Environment: OpenCode `2.2.x`, this fork at `56b6f57`
(`feat(v2): deliver automatic fold notices through the synthetic channel`), session agent
`director`, session model `magpie/tyai/deepseek-v4.1-flash#high`, `compress.model`
`magpie/openrouter/inception/mercury-3#low`, `autoFold.targetTokens = 100000`,
`autoFold.minGrowthTokens = 60000` (trigger line 160k).

## Summary

In one long session, three separate assistant turns emitted an internal summarization
payload — `<analysis>…</analysis><summary>1. Primary Request and Intent…</summary>` — as
ordinary, user-visible assistant text. Each of those turns ended without doing the work that
was in flight, and the original messages were no longer what the model continued from. The
user reads the result as "the thinking leaked and the work stopped".

The same session also shows that auto-fold never did what the design says it does: DCP
session state kept `autoFold: null` throughout, and the only two fold notices in the whole
session were emitted at `09:42:21Z` and `09:42:54Z`, i.e. *after* two of the three leaks.

So the two halves of the intended design are both visible in the trace:

- turn-end prepare (`prepareAutoFold`) mostly did not run;
- a different, in-session summarization path consumed the context pressure, and its output
  landed as visible assistant text.

## Impact

- Internal analysis / summary text becomes part of the chat transcript. Whatever the user
  reads there also becomes context for later turns, so the leak is not cosmetic.
- The turn that produced it ends the user's task prematurely; the follow-up turn has to
  re-establish where the work stopped.
- The invariant "compress off the request path, substitute on the request path" does not
  hold under pressure, which is the property auto-fold was added for.

## Evidence

`session_message` rows for the affected session (`opencode.db`), all three carrying the
`<analysis>` … `</summary>` body:

| seq | time (UTC) | agent | finish | tokens.output | tokens.reasoning |
| --- | --- | --- | --- | --- | --- |
| 11238 | 2026-10-29T09:22:02Z | `build` | `stop` | 6852 | 1 |
| 12708 | 2026-10-29T09:41:32Z | `director` | `stop` | 7017 | 1 |
| 13025 | 2026-10-29T09:48:19Z | `director` | `stop` | 6528 | 1 |

Structural facts that matter more than the text itself:

- In all three rows the `reasoning` content part is empty (`"text": " "`,
  `native.reasoningField = "reasoning_content"`) while the whole analysis sits in the `text`
  part. Nothing downstream can distinguish it from an ordinary answer, which is why it is
  rendered and kept.
- All three rows are ordinary sessions turns: `agent` is the session agent, and no
  `summary: true` marker is set.
- Immediately before each of the three rows, the trace contains only previous assistant
  messages — no persisted `user`, `system` or `synthetic` row. Whatever asked for the
  summary was injected for that request and never stored, so it cannot be identified from
  the transcript alone.

Fold notices in the same session (`type = 'synthetic'`):

| seq | time (UTC) | text |
| --- | --- | --- |
| 12720 | 09:42:21Z | `自动压缩触发` (auto-fold start notice) |
| 12729 | 09:42:54Z | `自动压缩触发` |
| 12748 | 09:44:12Z | `自动压缩: 191k → 91k，折叠 115 条消息（1 段）` (end notice) |
| 12876 | 09:45:45Z | `The previous response was interrupted. Continue from where you left off…` |

Two start notices for what should be one fold, and an interrupted-response notice three
minutes after the fold end notice, are consistent with defect 2 below.

## What is excluded, and why

- **Not a DCP block body.** The persisted session state
  (`storage/plugin/dcp/<session>.json`) contains no `<analysis>` string, so the leaked text
  was never a compression block.
- **Not the DCP summarizer.** `lib/` contains no `<analysis>` / `<summary>` prompt at all:
  `generateSummary` asks for "only the summary body", and `parseSummaryText`
  (`lib/compress/model.ts:148-153`) only trims. The summarizer also runs on
  `compress.model` (mercury), while all three leaked rows carry the session model
  (deepseek).
- **Not host compaction.** Host compaction records the message with `agent: "compaction"`
  and `summary: true`. The session has exactly one compaction row (seq 11783,
  `reason: "manual"`, the anchored `## Objective` template), and none of the three leaked
  rows is it.

## Defects

### 1. Turn-end prepare does not fire reliably (confirmed for this session)

`lib/v2/index.ts:56` subscribes only to:

```ts
const FOLD_PREPARE_EVENTS = new Set([
    "session.execution.succeeded",
    "session.execution.failed",
    "session.execution.interrupted",
])
```

and `lib/v2/index.ts:204` drops every other event. In this session that yielded `autoFold:
null` with the context well past the 160k trigger, while the surrounding trace shows turns
completing normally. Either the host does not deliver `session.execution.*` to
`ctx.event.subscribe`, or it delivers it without a usable `sessionID` / `location`, or DCP
measures below the trigger at that moment. The first two would explain the observed state.

### 2. Notices are model-visible, instruction-shaped, and delivered as `steer`

`lib/compress/autofold.ts:76` defines the start notice as `自动压缩触发` ("auto-compress
triggered") and sends it at `:394-399`; `lib/v2/notify.ts:21-24` delivers both notices with:

```ts
delivery: "steer" as const,
resume: false,
```

`notify.ts:8` states in its own comment that the text passed this way *is* model-visible.
Two consequences follow:

- A sentence that reads like an instruction ("auto-compress triggered") is injected into the
  model's context mid-turn. A model that takes it at face value starts writing a summary
  instead of continuing its task — exactly the shape of the three leaked rows.
- `steer` interrupts the turn in flight. The interrupted-response notice at `09:45:45Z`,
  right after the `09:44:12Z` fold end notice, and the `finish: "error"` assistant row that
  precedes it, are consistent with that.

Note that defect 2 explains the interruption; it does **not** explain the three leaks, whose
timing precedes every notice. Keeping the two causes separate matters for the fix.

### 3. No structural guard on summary-shaped output

Nothing strips a paired `<analysis>…</analysis>` wrapper before text is persisted or
rendered. Any component that authors a summary in that shape — including the in-session path
in defect 1 — produces user-visible internal text.

## Open questions

1. Does OpenCode `2.2.x` emit `session.execution.*` to plugin event subscribers, and with
   which payload? If it does not, `FOLD_PREPARE_EVENTS` needs `session.idle` (or whatever
   the host does emit at turn end), and this is the root cause of defect 1.
2. Does `ctx.session.synthetic` support a delivery that renders a row without entering the
   model context, or without interrupting a running turn? If not, notices need a different
   channel entirely.
3. Which component injects the "summarize this conversation" request behind the three
   leaked rows? The instruction was not persisted, so it is not identifiable from the
   transcript; it needs either a debug log around the generate call or plugin-side
   instrumentation.
4. Why did the same fold emit two start notices (`12720`, `12729`) but only one end notice?

## Candidate fixes (not implemented here)

1. **Take the notices out of the model's context.** Stop sending the start notice into the
   session, and deliver the end notice through a channel that neither interrupts the turn
   nor reads as an instruction. If `synthetic` is the only available channel, change the
   wording to something that cannot be mistaken for an instruction and use a non-`steer`
   delivery. Watch out for: notices that arrive a turn late.
2. **Make turn-end prepare provable.** Confirm which events the host actually delivers, add
   the missing one to `FOLD_PREPARE_EVENTS`, and add a test that asserts a completed turn
   triggers exactly one prepare (and that repeated terminal events do not). Watch out for:
   preparing on `session.idle` could fire while a turn is merely paused.
3. **Add a narrow structural guard.** If text starts with `<analysis>` and contains
   `</analysis>`, keep only the `<summary>` body (or reject the output) before it becomes a
   message. Strong preconditions are required so legitimate prose mentioning the tags is
   untouched.

## Acceptance criteria

- A completed turn above the trigger always leaves a prepared fold (or a logged, specific
  skip reason) — never a silent `autoFold: null`.
- No internal summary payload is ever persisted or rendered as user-visible assistant text;
  a regression test covers the `<analysis>` … `<summary>` shape.
- Fold notices do not interrupt a turn in flight and do not read as instructions.
