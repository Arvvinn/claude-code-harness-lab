# Trace Agent Loop Stream Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Harness Trace's default human view a clearly labeled, colored Agent Loop Stream for both live tailing and replay.

**Architecture:** Keep JSONL capture and raw output unchanged. Polish `src/trace/liveStream.ts` into the single semantic renderer for Learn and Deep stream views, make `trace replay` reuse that renderer, and make `trace tail` show the latest turn as orientation before following new events. Preserve `--raw` as exact JSONL and use `--deep` for richer structured visualization, not raw JSON.

**Tech Stack:** Bun, TypeScript strict, `bun:test`, existing `src/trace` CLI/store/config modules, ANSI terminal output with non-color fallback.

---

## Confirmed Product Decisions

- Default trace UI concept is **Agent Loop Stream**, not panel.
- `trace tail` opens with the latest main turn for orientation, then follows new events.
- `trace replay <sessionId>` uses the same Agent Loop Stream language over historical events.
- `trace tail --raw` and `trace replay --raw` remain exact JSONL.
- `--deep` is deeper visualization, not raw JSON.
- Stream stages are stable display categories: `TURN`, `USER`, `PREP`, `LLM`, `STREAM`, `DECISION`, `TOOL`, `HOOK`, `SIDE`, `STORE`, `DONE`, `ERROR`.
- ANSI color is on by default for TTY output and disabled for non-TTY or `NO_COLOR`.
- Low-level event names remain visible as dim metadata, not as the primary line.
- `SIDE` is shown by default as compact explanatory summaries.
- `STORE` is shown by default only for meaningful persistence actions, not high-frequency spam.

## File Structure

- Modify: `CONTEXT.md`
  - Already contains glossary terms from the discussion. Keep it in the exact staged set.
- Modify: `docs/adr/0001-use-agent-loop-stream-as-default-trace-view.md`
  - Already records the accepted default view decision. Keep it in the exact staged set.
- Create: `docs/superpowers/plans/2026-06-18-trace-agent-loop-stream-polish.md`
  - This plan.
- Modify: `src/trace/liveStream.ts`
  - Add stream stage labels, ANSI color helpers, dim event metadata, Learn/Deep label wording, SIDE/STORE summaries, and no-color fallback.
- Modify: `src/trace/__tests__/liveStream.test.ts`
  - Lock down colors, labels, event metadata, no raw-body leaks, SIDE summaries, and STORE summaries.
- Modify: `src/trace/cli.ts`
  - Add `trace replay --deep`, make default replay use Agent Loop Stream, and orient live tail with latest main turn before following EOF.
- Modify: `src/trace/__tests__/cli.test.ts`
  - Replace replay panel assertions with stream assertions, add `replay --deep`, and add latest-turn orientation tests for `tail`.
- Modify only if needed: `src/commands/trace/trace.ts`
  - Keep `/trace learn` and `/trace full` command text aligned with `trace tail` / `trace tail --deep`.
- Modify only if needed: `src/commands/trace/__tests__/trace.test.ts`
  - Keep slash-command output coverage aligned.

Do not modify trace capture or model/tool input files for this plan:

- `src/query.ts`
- `src/QueryEngine.ts`
- `src/services/api/claude.ts`
- `src/trace/store.ts`
- `src/trace/redaction.ts`

## Task 1: Stage Labels, Color, And Event Metadata

**Files:**
- Modify: `src/trace/liveStream.ts`
- Modify: `src/trace/__tests__/liveStream.test.ts`

- [ ] **Step 1: Add failing tests for colored stage labels**

In `src/trace/__tests__/liveStream.test.ts`, add a test that creates `createTraceLiveStream({ depth: 'learn', color: true })` and renders a main user turn plus request and tool events. Assert the output contains colored bracket labels and dim event metadata:

```ts
expect(output).toContain('\x1b[36m[USER 用户输入]\x1b[0m')
expect(output).toContain('\x1b[33m[LLM 模型请求]\x1b[0m')
expect(output).toContain('\x1b[32m[TOOL 工具]\x1b[0m')
expect(output).toContain('\x1b[90m  event=turn.start\x1b[0m')
expect(output).toContain('\x1b[90m  event=api.request_built\x1b[0m')
```

Also add a no-color test:

```ts
const output = render(records, 'learn', { color: false })
expect(output).toContain('[USER 用户输入]')
expect(output).not.toContain('\x1b[')
```

Run:

```bash
bun test src/trace/__tests__/liveStream.test.ts
```

Expected: FAIL because `TraceLiveStreamOptions` does not support `color`, and labels are plain words.

- [ ] **Step 2: Add stream style primitives**

In `src/trace/liveStream.ts`, change the options:

```ts
export interface TraceLiveStreamOptions {
  depth: TraceLiveDepth
  color?: boolean
}
```

Add stage metadata:

```ts
type StreamStage =
  | 'TURN'
  | 'USER'
  | 'PREP'
  | 'LLM'
  | 'STREAM'
  | 'DECISION'
  | 'TOOL'
  | 'HOOK'
  | 'SIDE'
  | 'STORE'
  | 'DONE'
  | 'ERROR'

const STAGE_LABELS: Record<StreamStage, string> = {
  TURN: 'TURN 轮次',
  USER: 'USER 用户输入',
  PREP: 'PREP 构造上下文',
  LLM: 'LLM 模型请求',
  STREAM: 'STREAM 模型流',
  DECISION: 'DECISION 决策',
  TOOL: 'TOOL 工具',
  HOOK: 'HOOK 钩子',
  SIDE: 'SIDE 旁路任务',
  STORE: 'STORE 记录写入',
  DONE: 'DONE 完成',
  ERROR: 'ERROR 错误',
}

const STAGE_COLORS: Record<StreamStage, string> = {
  TURN: '1;36',
  USER: '36',
  PREP: '35',
  LLM: '33',
  STREAM: '93',
  DECISION: '1;37',
  TOOL: '32',
  HOOK: '95',
  SIDE: '90',
  STORE: '34',
  DONE: '32',
  ERROR: '31',
}
```

Add helpers:

```ts
function stageLine(
  stage: StreamStage,
  text: string,
  eventType: string,
  color: boolean,
): string[] {
  return [
    `  ${colorize(`[${STAGE_LABELS[stage]}]`, STAGE_COLORS[stage], color)} ${text}\n`,
    `    ${colorize(`event=${eventType}`, '90', color)}\n`,
  ]
}

function colorize(text: string, code: string, enabled: boolean): string {
  return enabled ? `\x1b[${code}m${text}\x1b[0m` : text
}
```

- [ ] **Step 3: Thread color through renderer state**

Extend `TraceLiveState`:

```ts
color: boolean
```

Initialize it in `createTraceLiveStream()`:

```ts
color: options.color ?? false
```

Update each renderer to return `stageLine(...)` instead of plain `USER`, `LLM`, `TOOL`, and `DONE` prefixes. Keep raw payload bodies out of output. Keep lines concise.

- [ ] **Step 4: Verify**

Run:

```bash
bun test src/trace/__tests__/liveStream.test.ts
```

Expected: PASS.

## Task 2: SIDE And STORE Stream Semantics

**Files:**
- Modify: `src/trace/liveStream.ts`
- Modify: `src/trace/__tests__/liveStream.test.ts`

- [ ] **Step 1: Add failing SIDE summary tests**

In `src/trace/__tests__/liveStream.test.ts`, add cases for `generate_session_title`, `extract_memories`, and `session_memory`. Learn should show one compact explanatory line such as:

```ts
expect(output).toContain('[SIDE 旁路任务] session_memory collapsed')
expect(output).not.toContain('SIDE MEMORY BODY SHOULD NOT PRINT')
```

Deep should show shape but not bodies:

```ts
expect(output).toContain('[SIDE 旁路任务] session_memory model=deepseek-v4-pro messages=2 tools=25')
expect(output).not.toContain('SIDE MEMORY BODY SHOULD NOT PRINT')
```

- [ ] **Step 2: Add failing STORE summary tests**

Add tests for meaningful persistence actions:

```ts
expect(output).toContain('[STORE 记录写入] transcript appended entry=assistant bytes=915')
expect(output).toContain('[STORE 记录写入] transcript appended entry=tool_result bytes=628')
expect(output).toContain('[STORE 记录写入] trace session_start')
```

Add one high-frequency/noisy transcript event and assert it is skipped or collapsed:

```ts
expect(output).not.toContain('NOISY FULL TRANSCRIPT BODY SHOULD NOT PRINT')
```

Run:

```bash
bun test src/trace/__tests__/liveStream.test.ts
```

Expected: FAIL until STORE and SIDE rules are implemented with new labels.

- [ ] **Step 3: Implement SIDE names and summaries**

In `renderSideTurnStart()` and side `api.request_built`, route through `stageLine('SIDE', ...)`. Normalize known side sources only for display:

```ts
function formatSideSource(source: string): string {
  if (source.includes('memory')) return source
  if (source === 'generate_session_title') return 'generate_session_title'
  if (source === 'prompt_suggestion') return 'prompt_suggestion'
  if (source === 'away_summary') return 'away_summary'
  return source
}
```

Do not print side prompt text, side user message bodies, hook command bodies, or raw request params.

- [ ] **Step 4: Implement STORE summaries**

Render these event types:

- `transcript.appended` for `entryType` values `user`, `assistant`, `tool_result`, `system`.
- `trace.session_start`
- `trace.session_end`

Use `stageLine('STORE', ...)`. Include `entry=<entryType>` and `bytes=<byteCount>` when present. Do not print file paths unless already short and central; do not print transcript body.

Keep Learn and Deep both showing meaningful STORE summaries. Deep may include `path=collapsed` if a path exists, but not the full path.

- [ ] **Step 5: Verify**

Run:

```bash
bun test src/trace/__tests__/liveStream.test.ts
```

Expected: PASS.

## Task 3: Replay Uses Agent Loop Stream

**Files:**
- Modify: `src/trace/cli.ts`
- Modify: `src/trace/__tests__/cli.test.ts`

- [ ] **Step 1: Add failing replay stream tests**

Rename or replace the existing `replay prints an agent loop panel by default` expectation. The new assertion should be:

```ts
const result = await runTrace(['replay', 'session-1'])
expect(result.exitCode).toBe(0)
expect(result.stdout).toContain('Trace Replay - Learn')
expect(result.stdout).toContain('[USER 用户输入]')
expect(result.stdout).toContain('[LLM 模型请求]')
expect(result.stdout).toContain('event=api.request_built')
expect(result.stdout).not.toContain('Agent Loop Replay')
expect(result.stdout).not.toContain('[SYSTEM]')
```

Add `replay --deep`:

```ts
const result = await runTrace(['replay', 'session-1', '--deep'])
expect(result.stdout).toContain('Trace Replay - Deep')
expect(result.stdout).toContain('[PREP 构造上下文]')
expect(result.stdout).toContain('messages=')
```

Keep `replay --raw` assertions unchanged.

Run:

```bash
bun test src/trace/__tests__/cli.test.ts
```

Expected: FAIL because replay still uses `formatTracePanel()` and does not accept `--deep`.

- [ ] **Step 2: Add replay stream renderer helper**

In `src/trace/cli.ts`, add:

```ts
function getReplayText(sessionId: string, raw: boolean, deep: boolean): string
```

For non-raw replay:

1. Read records with `readTraceRecords(sessionId)`.
2. Create `createTraceLiveStream({ depth: deep ? 'deep' : 'learn', color: shouldUseColor(io.stdout) })`.
3. Print a replay header with `Trace Replay - Learn` or `Trace Replay - Deep`.
4. Render records in order with the stream renderer.

Do not use `formatTracePanel()` for default replay.

- [ ] **Step 3: Wire `--deep` into replay**

Update the `replay` command path:

```ts
getReplayText(sessionId, hasRawFlag(args), hasDeepFlag(args), io.stdout)
```

Update `USAGE`:

```text
replay <sessionId> [--deep] [--raw]
```

- [ ] **Step 4: Verify**

Run:

```bash
bun test src/trace/__tests__/cli.test.ts
```

Expected: PASS.

## Task 4: Tail Latest-Turn Orientation

**Files:**
- Modify: `src/trace/cli.ts`
- Modify: `src/trace/__tests__/cli.test.ts`

- [ ] **Step 1: Add failing latest-turn orientation test**

In `src/trace/__tests__/cli.test.ts`, add a test that writes two turns before starting follow mode:

```ts
appendTraceEvent(makeTraceEvent({
  eventId: 'event-old-turn',
  sequence: 1,
  type: 'turn.start',
  source: 'query',
  payload: { querySource: 'repl_main_thread', messages: [{ type: 'user', message: { content: 'old turn should not orient' } }] },
}))
appendTraceEvent(makeTraceEvent({
  eventId: 'event-latest-turn',
  sequence: 2,
  type: 'turn.start',
  source: 'query',
  payload: { querySource: 'repl_main_thread', messages: [{ type: 'user', message: { content: 'latest turn should orient' } }] },
}))

const tailPromise = runTrace(['tail', 'session-1'], {
  follow: true,
  pollIntervalMs: 10,
  idleTimeoutMs: 500,
})
```

Then append a new tool event and assert:

```ts
expect(result.stdout).toContain('latest turn should orient')
expect(result.stdout).toContain('Read started')
expect(result.stdout).not.toContain('old turn should not orient')
```

Also assert raw tail remains EOF-only:

```ts
expect(raw.stdout).not.toContain('latest turn should orient')
```

Run:

```bash
bun test src/trace/__tests__/cli.test.ts
```

Expected: FAIL because current follow tail starts at EOF and prints no orientation.

- [ ] **Step 2: Implement latest-turn slice selection**

In `src/trace/cli.ts`, add:

```ts
function getLatestMainTurnRecords(records: TraceDisplayRecord[]): TraceDisplayRecord[] {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index]
    if (record?.type === 'turn.start' && isMainTraceRecord(record)) {
      return records.slice(index)
    }
  }
  return []
}

function isMainTraceRecord(record: TraceDisplayRecord): boolean {
  const payload = record.payload
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return false
  }
  const querySource = (payload as Record<string, unknown>).querySource
  return (
    querySource === undefined ||
    querySource === 'repl_main_thread' ||
    (typeof querySource === 'string' && querySource.startsWith('repl_main_thread:')) ||
    querySource === 'sdk'
  )
}
```

- [ ] **Step 3: Render orientation before follow loop**

In `writeTail()`, after creating the stream and writing the header, before entering the polling loop:

```ts
if (!raw && follow && startAtEnd) {
  for (const record of getLatestMainTurnRecords(readTraceRecords(target.sessionId))) {
    for (const rendered of stream.renderRecord(record)) {
      writeText(io.stdout, rendered)
    }
  }
}
```

Keep `offset` at EOF so old lines are not re-read by the polling loop.

- [ ] **Step 4: Preserve non-follow tail and raw behavior**

Ensure:

- `tail --raw` keeps EOF-only behavior in follow mode.
- `tail` with `{ follow: false, startAtEnd: false }` still renders the whole file in tests.
- malformed raw lines remain raw in `--raw`.

Run:

```bash
bun test src/trace/__tests__/cli.test.ts
```

Expected: PASS.

## Task 5: Slash Command Alignment, Verification, And Commit

**Files:**
- Modify if needed: `src/commands/trace/trace.ts`
- Modify if needed: `src/commands/trace/__tests__/trace.test.ts`
- Verify: all changed docs and trace files

- [ ] **Step 1: Check slash command tests**

Run:

```bash
bun test src/commands/trace
```

Expected: PASS. If it fails because `/trace full` output does not mention `claude trace tail --deep`, update `src/commands/trace/trace.ts` and its tests to match the existing `getTraceTailCommand({ mode })` behavior.

- [ ] **Step 2: Run focused trace tests**

Run:

```bash
bun test src/trace/__tests__/liveStream.test.ts src/trace/__tests__/cli.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run full trace suite**

Run:

```bash
bun test src/trace
```

Expected: PASS.

- [ ] **Step 4: Run strict typecheck**

Run:

```bash
bun run typecheck
```

Expected: PASS with `tsc --noEmit`.

- [ ] **Step 5: Inspect status and avoid unrelated files**

Run:

```bash
git status --short --branch
```

Expected: changed files are limited to this plan, glossary/ADR, trace stream/CLI/tests, and optional slash-command alignment. These unrelated untracked files must remain unstaged:

```text
?? .codex/
?? docs/superpowers/plans/2026-06-16-harness-trace.md
```

- [ ] **Step 6: Stage exact files**

Run:

```bash
git add CONTEXT.md docs/adr/0001-use-agent-loop-stream-as-default-trace-view.md docs/superpowers/plans/2026-06-18-trace-agent-loop-stream-polish.md src/trace/liveStream.ts src/trace/__tests__/liveStream.test.ts src/trace/cli.ts src/trace/__tests__/cli.test.ts src/commands/trace/trace.ts src/commands/trace/__tests__/trace.test.ts
```

If `src/commands/trace/*` did not change, omit those two files from the final `git add`.

- [ ] **Step 7: Commit**

Run:

```bash
git commit -m "feat: polish trace agent loop stream"
```

Expected: commit succeeds.

## Self-Review

Spec coverage:

- Agent Loop Stream naming and scope: `CONTEXT.md`, ADR, Task 1.
- Colored stage labels: Task 1.
- Non-color fallback: Task 1.
- Event names as weak metadata: Task 1.
- SIDE summaries: Task 2.
- STORE summaries: Task 2.
- Replay unified with stream language: Task 3.
- Replay `--deep`: Task 3.
- Raw JSONL preserved: Tasks 3 and 4.
- Tail latest-turn orientation: Task 4.
- Slash-command alignment: Task 5.
- Final verification: Task 5.

Placeholder scan:

- No `TBD`, `TODO`, or "fill later" placeholders.
- Each task lists exact files, commands, and expected outcomes.

Type consistency:

- `TraceLiveDepth` remains `learn | deep`; persisted `TraceMode` remains `off | learn | full`.
- `--deep` is display depth only.
- `color` is an output option, not part of trace JSONL.
- Raw JSONL path bypasses semantic rendering.
