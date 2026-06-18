# Trace Live Agent Loop Design

**Date:** 2026-06-18
**Status:** Draft for user review
**Topic:** Replace `trace tail`'s static panel with a realtime, append-only Agent Loop view that teaches how the harness and LLM interact.

## Problem

Harness Trace already records the right source data in JSONL, but the live display is still shaped like either:

- a compact status panel, useful for replay summaries but not ideal for watching execution unfold; or
- raw JSONL, complete but visually noisy and hard to learn from.

The user wants to watch Claude Code as it runs: user input enters the harness, messages are prepared, a request is built, the model streams a response, `tool_use` is detected, hooks and permissions run, tool results are appended, and the loop returns to the LLM. The display should make that causal chain clear in realtime.

The target reference is the teaching style in `shareAI-lab/learn-claude-code`: explain Claude Code by decomposing it into staged capabilities around the core Agent Loop, not by dumping implementation logs.

## Goals

- Make `claude trace tail` a realtime stream by default.
- Show events as Agent Loop stages, not as raw event-type logs.
- Keep the output append-only: no clear-screen redraw and no rewriting previous lines.
- Split presentation into two learning depths:
  - `tail`: shallow Learn view for the core Agent Loop.
  - `tail --deep`: Deep view for harness internals and LLM protocol details.
- Keep `tail --raw` as the exact JSONL stream for source-of-truth inspection.
- Start tailing from "now" by default, not from the beginning of the session.
- Display local time once at stream startup; do not repeat timestamps on every event line.
- Keep JSONL timestamps stored as UTC.
- Preserve `trace replay` for history review and `trace replay --raw` for historical raw JSONL.

## Non-Goals

- Do not build a Web UI.
- Do not change trace capture semantics.
- Do not mutate model messages, system prompt, user context, or tool input.
- Do not remove raw JSONL fields.
- Do not hide data from `--raw`.
- Do not solve third-party plugin slowness in this change.
- Do not add slow-event warnings yet. Hook/tool durations can be displayed, but threshold labels such as `SLOW` / `VERY SLOW` are out of scope for this design.

## Command Semantics

```text
claude trace tail
```

Default realtime Learn view. Starts at the current end of the active trace file and prints only new semantic steps.

```text
claude trace tail --deep
```

Realtime Deep view. Also starts at the current end of the active trace file, but prints more harness and protocol detail.

```text
claude trace tail --raw
```

Realtime raw JSONL view. Starts at the current end of the active trace file and prints new raw JSONL lines exactly as written.

```text
claude trace replay <sessionId>
claude trace replay <sessionId> --raw
```

Historical replay remains separate. Replay may keep a summary-style panel or gain its own historical narrative later, but this spec only requires replacing live `tail`.

Slash command launch behavior:

```text
/trace learn  -> launch claude trace tail
/trace full   -> launch claude trace tail --deep
/trace off    -> stop trace capture
```

## Visual Model

The stream is a realtime teaching trace. It is closer to a terminal "flight recorder" than a log dump.

Rules:

- Append only.
- One user prompt opens one `TURN`.
- Main harness steps are grouped under that turn.
- Side systems are shown as side systems, not mixed into the main loop.
- Token-level `api.stream_event content_block_delta` spam is aggregated into meaningful stream-block updates.
- `--raw` is the only mode that prints every raw event.

## Learn View

Learn view is the shallow stage. It answers: "Where is the Agent Loop right now?"

It corresponds to basic Claude Code capability construction:

- user input
- messages prepared
- LLM request
- LLM stream
- tool-use decision
- permission
- tool execution
- tool result appended
- loop back
- turn completed

Example:

```text
Trace Live · Learn
Started: 2026-06-18 00:03:47 local
Session: 991fab44-931a-450c-90f3-2994b00aea6b
Source: C:\Users\asuka\.claude\harness-traces\991fab44-...\events.jsonl

╭─ TURN 4 · 读一下 README.md
│
├─ USER
│  读一下 D:\develop\ClaudeCode\README.md
│
├─ LOOP
│  messages[] prepared · user=2 assistant=0 internal=7 tools=25
│
├─ LLM
│  request sent · deepseek-v4-pro
│
├─ LLM
│  stream started
│  tool_use requested · Read
│
├─ TOOL
│  Read started
│  Read ok · 5031B
│
├─ LOOP
│  tool_result appended · loop back to LLM
│
╰─ DONE
   completed · 309.9s
```

Learn view should not show:

- full `systemPrompt`
- full `messages[]`
- full `userContext` / `systemContext`
- hook command bodies
- full tool input payloads
- raw stream deltas
- raw request params
- memory/session side-task bodies

It may show compact counts and names when they help the loop make sense.

## Deep View

Deep view is the second stage. It answers: "How did the harness construct and advance the loop?"

It exposes structure without becoming raw JSON:

- system prompt block counts
- user/system context presence
- message counts
- model/provider/querySource
- request-level parameters
- stream block lifecycle
- tool input/result summary
- PreToolUse / PostToolUse hook lifecycle
- permission decision
- transcript append
- memory/session/title side tasks
- loop and turn duration

Example:

```text
Trace Live · Deep
Started: 2026-06-18 00:03:47 local
Session: 991fab44-931a-450c-90f3-2994b00aea6b
Source: C:\Users\asuka\.claude\harness-traces\991fab44-...\events.jsonl

╭─ TURN 4 · 读一下 README.md
│
├─ USER INPUT
│  source=repl_main_thread
│  text=读一下 D:\develop\ClaudeCode\README.md
│
├─ HARNESS · context
│  systemPrompt=13 blocks
│  userContext=collapsed
│  systemContext=collapsed
│  messages=user=2 assistant=0 internal=7 attachments=6
│
├─ REQUEST #1
│  provider=firstParty model=deepseek-v4-pro
│  querySource=repl_main_thread tools=25 maxTokens=32000 effort=medium
│
├─ STREAM #1
│  message_start
│  content_block_start thinking
│  content_block_delta thinking +438 chars
│  content_block_start tool_use Read
│  message_stop stop_reason=tool_use
│
├─ TOOL · Read
│  PreToolUse running
│  PreToolUse done 60.4s
│  permission allow source=mode
│  input.file_path=D:\develop\ClaudeCode\README.md
│  result ok size=5031B
│  PostToolUse done 120.4s
│
├─ HARNESS · append
│  transcript appended assistant
│  tool_result appended to messages[]
│
├─ LOOP
│  next LLM request because tool_result was appended
│
╰─ DONE
   result=completed duration=309.9s finalMessages=31
```

Deep view still collapses large bodies. It can show small structural values and safe previews, but raw payload fidelity remains the job of `--raw`.

## Side Systems

Side systems should not pollute the main Agent Loop.

Examples:

- `generate_session_title`
- `extract_memories`
- `session_memory`
- `prompt_suggestion`
- `away_summary`
- `agent:*`

Learn view summarizes them:

```text
├─ SIDE
│  title generation · collapsed
│  memory/session · 3 tasks collapsed
```

Deep view gives their request shape:

```text
├─ SIDE · generate_session_title
│  model=DeepSeek-V4-Flash messages=1 tools=0
│  completed 3.2s
```

Side task prompts, generated memory bodies, hook commands, and injected contexts must not print in Learn or Deep. They remain visible in `--raw`.

## Time Display

Trace events continue to store UTC ISO timestamps:

```json
"timestamp": "2026-06-17T16:03:47.556Z"
```

Human-facing views display local time only at startup:

```text
Started: 2026-06-18 00:03:47 local
```

Per-event lines do not repeat timestamps. Ordering is conveyed by append order.

`trace replay` summary output should also convert `Last:` to local time:

```text
Last: 2026-06-18 00:03:47 local
```

`--raw` preserves UTC strings exactly.

## Rendering Pipeline

The implementation should separate three responsibilities:

```text
TraceEvent(JSONL)
  -> SemanticStep
  -> Renderer(learn | deep | raw)
```

### TraceEvent

Existing JSONL events remain the source of truth.

### SemanticStep

Semantic steps are small presentation events such as:

```ts
type SemanticStep =
  | { kind: 'turn_start'; title: string; userText?: string }
  | { kind: 'harness_context'; messageCounts: MessageCounts; systemBlocks?: number; toolCount?: number }
  | { kind: 'llm_request'; requestIndex: number; model?: string; provider?: string; querySource?: string; messageCount?: number; toolCount?: number }
  | { kind: 'llm_stream_start'; requestIndex: number }
  | { kind: 'llm_stream_block'; requestIndex: number; blockType: string; label?: string; charDelta?: number }
  | { kind: 'decision'; stopReason?: string; toolName?: string; next: 'execute_tools' | 'return_text' | 'loop_back' }
  | { kind: 'hook_start'; hookEvent: string; toolName?: string }
  | { kind: 'hook_done'; hookEvent: string; toolName?: string; durationMs?: number }
  | { kind: 'permission'; toolName?: string; decision?: string; source?: string }
  | { kind: 'tool_start'; toolName: string; path?: string }
  | { kind: 'tool_done'; toolName: string; ok?: boolean; durationMs?: number; sizeBytes?: number }
  | { kind: 'append'; entryType?: string; detail: string }
  | { kind: 'side_task'; querySource: string; model?: string; messageCount?: number; toolCount?: number; durationMs?: number }
  | { kind: 'turn_done'; result?: string; durationMs?: number; finalMessageCount?: number }
  | { kind: 'error'; label: string; detail?: string }
```

This exact TypeScript shape may change during implementation, but the boundary is important: raw trace records should not be formatted directly all over the CLI. They should be normalized first.

### Renderer

Learn renderer maps semantic steps to terse loop narration.

Deep renderer maps the same semantic steps to expanded harness/protocol narration.

Raw renderer bypasses semantic steps and prints JSONL lines.

## Streaming Mechanics

`trace tail` follows the active events file by offset.

Startup:

1. Resolve active session.
2. Resolve active `events.jsonl`.
3. Stat file.
4. Set read offset to current file size.
5. Print header with local time.
6. Poll for appended bytes.

Polling:

- Use a fixed interval, around 250-500ms.
- Read only bytes after the last offset.
- Append bytes to a text buffer.
- Split on newline.
- Keep incomplete trailing line in buffer.
- Parse complete lines into `TraceEvent`.
- Convert to `SemanticStep`.
- Render and print.

This is more reliable on Windows than depending only on filesystem watch events for append detection.

If the active session changes while tail is running, the first implementation may tell the user to restart tail. Automatic session-following is optional and can be added later.

## Event Mapping

Initial mapping table:

| Trace event | Learn view | Deep view |
| --- | --- | --- |
| `turn.start` | Start `TURN`, print `USER`, print `messages[] prepared` | Start `TURN`, print `USER INPUT`, `HARNESS · context` |
| `user.input_received` | Usually ignored if `turn.start` already has text | Can fill user input if `turn.start` lacked text |
| `api.request_built` main | `LLM request sent` | `REQUEST #n` with provider/model/querySource/tools/messages |
| `api.request_built` side | `SIDE ... collapsed` | `SIDE · <querySource>` |
| `api.stream_event message_start` | `LLM stream started` | `STREAM #n message_start` |
| `api.stream_event content_block_start` | `tool_use requested` if block is tool use; otherwise compact stream note | block type and label |
| `api.stream_event content_block_delta` | aggregate or ignore token deltas | aggregate char counts per block |
| `api.stream_event message_stop` | decision summary if stop reason is present | stop reason and next step |
| `tool.detected` | `tool_use requested · <tool>` if not already shown | detected tool details |
| `hook.started` | optionally `HOOK <event> running` when relevant | always show hook lifecycle |
| `hook.result` | optionally `HOOK <event> done` | duration and status |
| `tool.permission_result` | `permission <decision>` | decision source/mode |
| `tool.started` | `TOOL <name> started` | tool name and selected safe input fields |
| `tool.result` | `TOOL <name> ok/failed` | duration, result kind, size |
| `transcript.appended` | `tool_result appended` or compact append note | entry type/path collapsed |
| `query.loop_end` | `loop back` or `final answer returned` | loop index, stop reason, counts |
| `turn.end` | `DONE` | result, duration, final message count |
| `*.error` / `api.retry` / `trace.read_error` | `ERROR` | full safe diagnostic summary |

The mapper should deduplicate where possible. For example, if `api.stream_event` already showed `tool_use requested · Read`, `tool.detected` should not print a second identical Learn line.

## Color And Typography

Colors should be restrained and functional:

- `USER`: cyan/blue
- `HARNESS` / `LOOP`: purple
- `LLM` / `REQUEST` / `STREAM`: yellow
- `TOOL`: green
- `HOOK`: magenta
- `SIDE`: gray/cyan
- `DONE`: green or gray
- `ERROR`: red

The content text should stay mostly white/gray. Do not use many decorative colors.

ASCII fallback is acceptable if Unicode box drawing causes terminal issues. On Windows Terminal, box drawing is acceptable.

## Learn vs Deep Summary

Learn:

- concise
- stage-oriented
- one to three lines per major phase
- no raw field names unless they are central, such as `messages[]`

Deep:

- still readable
- more field names
- one section per major harness mechanism
- safe structure and counts
- never full raw payload bodies

Raw:

- exact JSONL
- no formatting
- no local time conversion

## Testing Strategy

Unit tests:

- local time formatter:
  - converts UTC timestamp to local format
  - does not emit raw `Z` in human view
  - handles invalid timestamps gracefully
- semantic mapper:
  - maps main turn/request/tool flow into learn/deep steps
  - collapses side tasks
  - aggregates stream deltas
  - avoids duplicate tool-use lines
- renderer:
  - Learn output is concise and stage-oriented
  - Deep output includes harness detail but not raw bodies
  - raw bodies remain absent from Learn/Deep

CLI tests:

- `trace tail` starts at current EOF and prints only newly appended events.
- `trace tail --deep` prints the deep renderer.
- `trace tail --raw` prints exact newly appended JSONL lines.
- auto tail launch command for `/trace learn` remains `claude trace tail`.
- auto tail launch command for `/trace full` becomes `claude trace tail --deep`.
- `trace replay` continues to work.

Regression tests:

- No `api.stream_event content_block_delta` flood in Learn.
- Hook duration events render as hook lifecycle steps.
- A slow `PostToolUse` hook is visible as `PostToolUse done <duration>`, without adding threshold labels yet.
- Existing `--raw` tests continue to prove JSONL is the source of truth.

Verification commands:

```bash
bun test src/trace
bun test src/commands/trace
bun run typecheck
```

If the implementation touches slash command launch behavior:

```bash
bun test src/commands/trace
```

## Rollout Notes

The change is display-only. It should not affect:

- trace capture
- trace config
- model messages
- tool execution
- hooks
- permissions
- transcript storage

The most likely compatibility risk is users expecting `trace tail` to show the old live panel. This is acceptable because the user explicitly wants `trace tail` to be replaced by realtime streaming. `trace replay` remains the historical inspection path.

## Open Decisions

No open product decisions remain from the current discussion.

Explicitly accepted:

- `trace tail` should be realtime stream by default.
- No `--stream` flag.
- Use `--deep` for deep realtime view.
- `--raw` keeps raw JSONL.
- Tail starts from now, not from session beginning.
- Output is append-only.
- Time appears once at stream startup, in local time.
- Slow thresholds are deferred.

## Spec Self-Review

- Placeholder scan: no `TBD` or unresolved implementation placeholders.
- Internal consistency: command semantics, slash-command launch behavior, and renderer levels use the same Learn/Deep/Raw vocabulary.
- Scope check: this is one feature slice focused on live trace presentation. It deliberately avoids Web UI and capture-layer changes.
- Ambiguity check: `trace tail` replacement, `--deep`, `--raw`, append-only output, and "start from now" are explicit.
