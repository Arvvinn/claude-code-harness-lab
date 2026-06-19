# Trace Block Display Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` to execute this plan task-by-task. Each task needs implementation, spec compliance review, and code quality review before moving on.

**Goal:** Replace the current colored line stream with a block-style Trace Display ViewModel and Aggregator that makes Learn and Deep Agent Loop Streams easier to understand while preserving raw JSONL as source of truth.

**Primary design docs:**

- `CONTEXT.md`
- `docs/trace-agent-loop-display-design.md`
- `docs/adr/0001-use-agent-loop-stream-as-default-trace-view.md`
- `docs/adr/0002-use-viewer-aggregation-for-trace-display.md`

**Non-negotiable boundaries:**

- Do not change trace capture semantics or JSONL event schema.
- Do not inject trace data into model messages, system prompt, user context, or tool input.
- `--raw` must bypass all ViewModel/Aggregator rendering and remain exact JSONL.
- Tool names must remain original English identifiers.
- Learn and Deep both use block layout, but Learn stays shallow and Deep stays structural.
- Run focused trace tests after each slice; final verification must include `bun test src/trace`, `bun test src/commands/trace`, and `bun run typecheck`.

---

## Task 1: Trace Display ViewModel Skeleton

**Files:**

- Create: `src/trace/displayViewModel.ts`
- Create: `src/trace/__tests__/displayViewModel.test.ts`
- Modify: `src/trace/liveStream.ts`

**Steps:**

- [ ] Define viewer-side ViewModel types for Learn/Deep blocks.
- [ ] Include stable stages: `TURN`, `PREP`, `LLM`, `STREAM`, `TOOL`, `STORE`, `DECISION`, `SIDE`, `DONE`, `ERROR`.
- [ ] Add `TraceEventShortId` derivation from event id.
- [ ] Add `seq:<number>` friendly sequence formatting.
- [ ] Keep JSONL parsing and trace capture untouched.
- [ ] Add tests proving raw event payloads are translated into ViewModel blocks without mutating input records.

**Validation:**

```powershell
bun test src/trace/__tests__/displayViewModel.test.ts
bun test src/trace/__tests__/liveStream.test.ts
```

---

## Task 2: Block Renderer And Locale Templates

**Files:**

- Modify: `src/trace/liveStream.ts`
- Modify: `src/trace/__tests__/liveStream.test.ts`
- Modify: `src/trace/cli.ts`
- Modify: `src/trace/__tests__/cli.test.ts`

**Steps:**

- [ ] Render Learn and Deep as block layout with blank lines between blocks.
- [ ] Implement `--lang zh` and `--lang en` for trace tail/replay.
- [ ] Keep bilingual stage labels by default in Chinese mode.
- [ ] Add English narration templates without changing JSONL data.
- [ ] Learn hides event metadata by default.
- [ ] Add `--events` for Learn only.
- [ ] Deep always shows event name and short id.
- [ ] Preserve `NO_COLOR` and non-TTY no-color behavior.

**Validation:**

```powershell
bun test src/trace/__tests__/liveStream.test.ts
bun test src/trace/__tests__/cli.test.ts
```

---

## Task 3: Trace Show Command

**Files:**

- Modify: `src/trace/cli.ts`
- Modify: `src/trace/__tests__/cli.test.ts`
- Modify if needed: `src/commands/trace/trace.ts`
- Modify if needed: `src/commands/trace/__tests__/trace.test.ts`

**Steps:**

- [ ] Add `trace show <session-id> <event-id-or-prefix>`.
- [ ] Add `trace show <session-id> seq:<sequence>`.
- [ ] Default output: one event as redacted pretty JSON.
- [ ] `--raw`: exact JSONL line for the selected event.
- [ ] Prefix matching must reject ambiguous prefixes with a clear error.
- [ ] Missing event must suggest `trace replay --deep` to find ids.
- [ ] Update usage text.

**Validation:**

```powershell
bun test src/trace/__tests__/cli.test.ts
bun test src/commands/trace
```

---

## Task 4: Tool Call Block Aggregation

**Files:**

- Create: `src/trace/displayAggregator.ts`
- Create: `src/trace/__tests__/displayAggregator.test.ts`
- Modify: `src/trace/liveStream.ts`
- Modify: `src/trace/__tests__/liveStream.test.ts`

**Steps:**

- [ ] Group `tool.detected`, `tool.started`, `tool.result`, `tool.error`, and `tool.cancelled` into Tool Call Blocks.
- [ ] Attach `hook.started` / `hook.result` for PreToolUse and PostToolUse to the related Tool Call Block.
- [ ] Learn renders one shallow tool block.
- [ ] Deep renders started/result/hook ids inside one block.
- [ ] Tool names remain original English identifiers.
- [ ] Tool/hook failures also emit an ERROR block.
- [ ] Replay aggregation must be deterministic.

**Validation:**

```powershell
bun test src/trace/__tests__/displayAggregator.test.ts
bun test src/trace/__tests__/liveStream.test.ts
```

---

## Task 5: STORE / STREAM / SIDE Aggregation

**Files:**

- Modify: `src/trace/displayAggregator.ts`
- Modify: `src/trace/__tests__/displayAggregator.test.ts`
- Modify: `src/trace/liveStream.ts`
- Modify: `src/trace/__tests__/liveStream.test.ts`

**Steps:**

- [ ] Learn STORE shows only key summaries, not each transcript append.
- [ ] Deep STORE may show structured write details but must avoid spam.
- [ ] STREAM deltas are summarized; tool_use requests become stream/tool intent blocks.
- [ ] SIDE appears as compressed summary in Learn.
- [ ] SIDE appears as structured block in Deep.
- [ ] Side task prompts are never treated as Main User Input.

**Validation:**

```powershell
bun test src/trace/__tests__/displayAggregator.test.ts
bun test src/trace/__tests__/liveStream.test.ts
```

---

## Task 6: Adaptive Trace Flush For Live Tail

**Files:**

- Modify: `src/trace/displayAggregator.ts`
- Modify: `src/trace/__tests__/displayAggregator.test.ts`
- Modify: `src/trace/cli.ts`
- Modify: `src/trace/__tests__/cli.test.ts`

**Steps:**

- [ ] Replay mode can aggregate complete history before rendering.
- [ ] Tail mode uses Adaptive Trace Flush.
- [ ] Short tools (`Read`, `Glob`, `Grep`, `Edit`) wait according to recent same-tool p75, capped at 200ms and floored at 50ms.
- [ ] Long tools (`Bash`, `PowerShell`, `Agent`, MCP tools) default to 80ms before running block.
- [ ] Unknown short-tool history defaults to 120ms.
- [ ] Any pending block flushes as running by 250ms.
- [ ] Raw tail bypasses the aggregator and remains exact JSONL.
- [ ] Tests must use fake timers or injected clock to avoid flaky timing.

**Validation:**

```powershell
bun test src/trace/__tests__/displayAggregator.test.ts
bun test src/trace/__tests__/cli.test.ts
```

---

## Task 7: Docs, README, And Final Verification

**Files:**

- Modify: `README.md`
- Modify: `docs/trace-agent-loop-display-design.md`
- Modify if needed: `CONTEXT.md`
- Modify if needed: `docs/adr/0002-use-viewer-aggregation-for-trace-display.md`

**Steps:**

- [ ] Update README commands for `--lang`, `--events`, and `trace show`.
- [ ] Ensure design docs match implemented behavior.
- [ ] Run final focused and type validations.
- [ ] Inspect git status and leave unrelated files unstaged.
- [ ] Commit with Conventional Commit message.

**Final validation:**

```powershell
bun test src/trace
bun test src/commands/trace
bun run typecheck
git status --short --branch
```

Expected unrelated files that must remain unstaged unless explicitly requested:

```text
?? .codex/
?? docs/superpowers/plans/2026-06-16-harness-trace.md
```
