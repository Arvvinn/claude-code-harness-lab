# Trace Agent Loop Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Harness Trace useful for local learning by recording full study context and showing the agent loop as a readable CLI status panel by default.

**Architecture:** Trace remains default-off and manual-mode only. JSONL stays the source of truth; CLI `replay` and `tail` render a derived human panel by default, while `--raw` keeps raw event/log output available. Trace payloads record the complete local-study context but still redact obvious credentials.

**Tech Stack:** Bun, TypeScript strict, `bun:test`, existing `src/trace` JSONL store and CLI.

---

## File Structure

- Modify `src/query.ts`
  - Capture `messages`, `systemPrompt`, `userContext`, and `systemContext` when a trace session is active.
  - Attach that study context to `turn.start`, `user.input_received`, and `query.loop_start`.
- Modify `src/services/api/claude.ts`
  - Include full request params in `api.request_built` for local study.
  - Keep stream raw events limited to full mode.
- Modify `src/services/tools/toolOrchestration.ts`
  - Include tool input structure on `tool.detected`.
- Modify `src/services/tools/toolExecution.ts`
  - Include tool input structure on `tool.started` and error trace payloads.
- Modify `src/trace/redaction.ts`
  - Preserve long local-study strings while redacting credential-looking keys and auth header values.
- Create `src/trace/panel.ts`
  - Render JSONL records as a color-coded Agent Loop panel.
- Modify `src/trace/cli.ts`
  - Make `replay` and `tail` use the panel by default.
  - Add `--raw` to preserve raw log/JSONL output.
- Modify tests:
  - `src/trace/__tests__/queryInstrumentation.test.ts`
  - `src/trace/__tests__/claudeApiInstrumentation.test.ts`
  - `src/services/tools/__tests__/toolExecution.trace.test.ts`
  - `src/trace/__tests__/redaction.test.ts`
  - `src/trace/__tests__/cli.test.ts`

## Task 1: Full Local-Study Trace Context

**Files:**
- Modify: `src/query.ts`
- Modify: `src/services/api/claude.ts`
- Modify: `src/services/tools/toolOrchestration.ts`
- Modify: `src/services/tools/toolExecution.ts`
- Modify: `src/trace/redaction.ts`
- Test: `src/trace/__tests__/queryInstrumentation.test.ts`
- Test: `src/trace/__tests__/claudeApiInstrumentation.test.ts`
- Test: `src/services/tools/__tests__/toolExecution.trace.test.ts`
- Test: `src/trace/__tests__/redaction.test.ts`

- [ ] **Step 1: Ensure failing tests describe required study data**

Assertions must prove:
- Raw user prompt appears in trace payloads when trace mode is enabled.
- Full `systemPrompt`, `messages`, `userContext`, and `systemContext` are present.
- API request params are present on `api.request_built`.
- Tool input structure is present on tool lifecycle events.
- Credential-looking fields are redacted, but long study strings are not truncated.

Run:

```bash
bun test --feature HARNESS_TRACE src/trace/__tests__/queryInstrumentation.test.ts src/trace/__tests__/claudeApiInstrumentation.test.ts src/services/tools/__tests__/toolExecution.trace.test.ts src/trace/__tests__/redaction.test.ts
```

Expected before implementation: at least one assertion fails on missing study context.

- [ ] **Step 2: Implement minimal capture**

In `src/query.ts`, build a plain JSON-safe snapshot from the original `QueryParams` before the query loop mutates state. Use that same snapshot in direct turns and caller-owned `traceTurnId` turns.

In API/tool files, add raw request/tool input payload fields only to trace events. Do not add trace data to model messages, system prompt construction, user context injection, or tool execution inputs.

- [ ] **Step 3: Run focused tests**

Run:

```bash
bun test --feature HARNESS_TRACE src/trace/__tests__/queryInstrumentation.test.ts src/trace/__tests__/claudeApiInstrumentation.test.ts src/services/tools/__tests__/toolExecution.trace.test.ts src/trace/__tests__/redaction.test.ts
```

Expected: all listed tests pass.

## Task 2: Human-Readable Agent Loop Panel by Default

**Files:**
- Create: `src/trace/panel.ts`
- Modify: `src/trace/cli.ts`
- Test: `src/trace/__tests__/cli.test.ts`

- [ ] **Step 1: Ensure CLI tests describe default panel and raw escape hatch**

Assertions must prove:
- `trace replay <session>` defaults to an Agent Loop panel.
- The panel includes labeled sections for user input, system/context, LLM request/response, decision, tools/hooks/subagents/storage/errors when available.
- `trace replay <session> --raw` prints raw JSONL.
- `trace tail [session]` defaults to a refreshing panel.
- `trace tail [session] --raw` keeps the old streaming log/JSONL behavior.

Run:

```bash
bun test --feature HARNESS_TRACE src/trace/__tests__/cli.test.ts
```

Expected before implementation: at least one assertion fails on old raw/log display.

- [ ] **Step 2: Implement panel rendering**

Create `formatTracePanel(records, { title })` in `src/trace/panel.ts`. It should summarize the current agent loop, not dump every token event. Use ANSI color labels for data classes: user, system/context, messages, LLM, decision, tool, hook, subagent, store, error.

Update `src/trace/cli.ts` so `replay` and `tail` call the panel by default and only use raw output when `--raw` is present.

- [ ] **Step 3: Run focused CLI tests**

Run:

```bash
bun test --feature HARNESS_TRACE src/trace/__tests__/cli.test.ts
```

Expected: all CLI trace tests pass.

## Final Verification

- [ ] Run:

```bash
bun test --feature HARNESS_TRACE src/trace src/services/tools/__tests__/toolExecution.trace.test.ts
```

- [ ] Run:

```bash
bun test src/trace
```

- [ ] Run:

```bash
bun run typecheck
```

Expected: all commands complete successfully.

## Non-Negotiable Boundaries

- Trace defaults to `off`.
- `learn` and `full` are manual and remain enabled until `off`.
- Trace is an observer. It must not inject data into model messages, system prompt creation, user context, or tool input execution.
- JSONL remains the first source of truth.
- CLI comes first; no Web UI work in this slice.
- Do not revert unrelated user changes.
