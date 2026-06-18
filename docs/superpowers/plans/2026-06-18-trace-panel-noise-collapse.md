# Trace Panel Noise Collapse Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `trace tail` and default `trace replay` readable by collapsing internal hooks, memory/session side tasks, skill listings, full context, and large tool inputs into concise Agent Loop summaries while preserving complete JSONL in `--raw`.

**Architecture:** Keep trace capture unchanged: JSONL remains the source of truth and still records full local-study detail. Only the derived panel renderer changes: `src/trace/panel.ts` will summarize messages/context/tools/hooks into compact human-readable rows and keep full objects out of the default panel. `trace tail --raw` and `trace replay --raw` continue to print raw source JSONL lines.

**Tech Stack:** Bun, TypeScript strict, `bun:test`, existing `src/trace` CLI/store/panel modules.

---

## File Structure

- Create: `src/trace/__tests__/panel.test.ts`
  - Focused unit tests for `formatTracePanel()` so the noisy real-session scenario is locked down without needing a live REPL.
- Modify: `src/trace/panel.ts`
  - Add panel-only summary helpers.
  - Collapse large internal sections by default.
  - Keep section labels and Agent Loop pattern.
- Modify: `src/trace/__tests__/cli.test.ts`
  - Add one CLI integration assertion that default `replay` stays compact while `--raw` preserves full data.
- Modify if needed: `src/trace/__tests__/smoke.test.ts`
  - Only if existing smoke assertions conflict with compact default panel behavior.

Do not modify these files for this plan:

- `src/query.ts`
- `src/services/api/claude.ts`
- `src/services/tools/toolExecution.ts`
- `src/services/tools/toolOrchestration.ts`
- `src/trace/redaction.ts`

Those are trace capture/source-of-truth layers. This plan is presentation-only.

## Behavior Contract

Default `trace tail` and `trace replay` should show:

```text
Agent Loop Live
Session: <id>
Events: <count>
Pattern: User -> messages[] -> LLM -> stop_reason/tool_use decision -> tools -> append results -> loop back/return text

[USER]
  你好
  读一下 "D:\develop\ClaudeCode\README.md"

[MESSAGES]
  user=2
  assistant=1
  system/internal=18 collapsed
  attachments/hooks=5 collapsed

[SYSTEM]
  systemPrompt: collapsed 1 block
  userContext: collapsed
  systemContext: collapsed

[LLM]
  main: deepseek-v4-pro source=repl_main_thread messages=2 tools=25
  side: generate_session_title / extract_memories / session_memory collapsed

[DECISION]
  loop 1: completed toolUse=1 toolResult=1

[TOOL]
  Read path=D:\develop\ClaudeCode\README.md status=ok
  Edit path=...\session-memory\summary.md status=ok input=collapsed

[INTERNAL]
  hooks=6 collapsed
  memory/session side tasks=3 collapsed
  title generation=1 collapsed

[STORE]
  transcript appends=17
  session start=1

[RAW]
  bun run dev trace tail --raw
```

Default panel must not print:

- Full `systemPrompt` body.
- Full `messages[]`.
- Full `userContext` / `systemContext`, including entire `CLAUDE.md` text or git status blob.
- Hook shell command bodies.
- `skill_listing` content.
- Memory/session side-task bodies.
- Large `toolInput.old_string` / `toolInput.new_string`.
- Full `rawRequestParams`.

`--raw` must still print the complete JSONL source lines, including those details.

## Task 1: Add Focused Panel Regression Tests

**Files:**
- Create: `src/trace/__tests__/panel.test.ts`
- Modify: none

- [ ] **Step 1: Create the failing test file**

Create `src/trace/__tests__/panel.test.ts` with this test structure:

```ts
import { describe, expect, test } from 'bun:test'
import type { TraceDisplayRecord } from '../format'
import { formatTracePanel } from '../panel'

function record(
  overrides: Partial<TraceDisplayRecord> & {
    type: string
    source?: TraceDisplayRecord['source']
    payload?: Record<string, unknown>
  },
): TraceDisplayRecord {
  return {
    eventId: overrides.eventId ?? `${overrides.type}-event`,
    sessionId: overrides.sessionId ?? 'panel-session',
    turnId: overrides.turnId,
    sequence: overrides.sequence ?? 1,
    timestamp: overrides.timestamp ?? '2026-06-18T00:00:00.000Z',
    mode: overrides.mode ?? 'learn',
    source: overrides.source ?? 'query',
    type: overrides.type,
    payload: overrides.payload ?? {},
  }
}

describe('formatTracePanel', () => {
  test('collapses internal context and large tool inputs by default', () => {
    const panel = formatTracePanel(
      [
        record({
          type: 'turn.start',
          source: 'query',
          payload: {
            messages: [
              {
                type: 'system',
                content: 'FULL CLAUDE.md BODY SHOULD NOT PRINT',
              },
              {
                type: 'attachment',
                attachment: {
                  type: 'skill_listing',
                  content: 'FULL SKILL LISTING SHOULD NOT PRINT',
                },
              },
              {
                type: 'user',
                message: { content: '你好' },
              },
              {
                type: 'user',
                message: {
                  content: '读一下 "D:\\develop\\ClaudeCode\\README.md"',
                },
              },
            ],
            systemPrompt: [
              {
                type: 'text',
                text: 'FULL SYSTEM PROMPT SHOULD NOT PRINT',
              },
            ],
            userContext: {
              cwd: 'D:\\develop\\ClaudeCode',
              fullClaudeMd: 'FULL USER CONTEXT SHOULD NOT PRINT',
            },
            systemContext: {
              gitStatus: 'FULL GIT STATUS SHOULD NOT PRINT',
            },
          },
        }),
        record({
          type: 'api.request_built',
          source: 'api',
          payload: {
            provider: 'firstParty',
            model: 'deepseek-v4-pro',
            querySource: 'repl_main_thread',
            messageCount: 2,
            toolCount: 25,
            rawRequestParams: {
              system: 'RAW REQUEST SYSTEM SHOULD NOT PRINT',
            },
          },
        }),
        record({
          type: 'api.request_built',
          source: 'api',
          payload: {
            model: 'DeepSeek-V4-Flash',
            querySource: 'generate_session_title',
            messageCount: 1,
            toolCount: 0,
          },
        }),
        record({
          type: 'tool.started',
          source: 'tool',
          payload: {
            toolName: 'Edit',
            status: 'started',
            toolInput: {
              file_path:
                'C:\\Users\\asuka\\.claude\\projects\\session-memory\\summary.md',
              old_string: 'FULL OLD STRING SHOULD NOT PRINT',
              new_string: 'FULL NEW STRING SHOULD NOT PRINT',
            },
          },
        }),
        record({
          type: 'hook.started',
          source: 'hook',
          payload: {
            hookEvent: 'PreToolUse',
            command: 'FULL HOOK COMMAND SHOULD NOT PRINT',
          },
        }),
        record({
          type: 'query.loop_end',
          source: 'query',
          payload: {
            loopIndex: 1,
            stopReason: 'completed',
            toolUseCount: 1,
            toolResultCount: 1,
          },
        }),
      ],
      { title: 'Agent Loop Live' },
    )

    expect(panel).toContain('Agent Loop Live')
    expect(panel).toContain('[USER]')
    expect(panel).toContain('你好')
    expect(panel).toContain('读一下 "D:\\develop\\ClaudeCode\\README.md"')
    expect(panel).toContain('[MESSAGES]')
    expect(panel).toContain('user=2')
    expect(panel).toContain('system/internal=1 collapsed')
    expect(panel).toContain('attachments/hooks=1 collapsed')
    expect(panel).toContain('[SYSTEM]')
    expect(panel).toContain('systemPrompt: collapsed 1 block')
    expect(panel).toContain('userContext: collapsed')
    expect(panel).toContain('systemContext: collapsed')
    expect(panel).toContain('[LLM]')
    expect(panel).toContain('main: deepseek-v4-pro')
    expect(panel).toContain('side: generate_session_title collapsed')
    expect(panel).toContain('[TOOL]')
    expect(panel).toContain('Edit')
    expect(panel).toContain('input=collapsed')
    expect(panel).toContain('[INTERNAL]')
    expect(panel).toContain('hooks=1 collapsed')
    expect(panel).toContain('[RAW]')
    expect(panel).toContain('bun run dev trace tail --raw')

    expect(panel).not.toContain('FULL CLAUDE.md BODY SHOULD NOT PRINT')
    expect(panel).not.toContain('FULL SKILL LISTING SHOULD NOT PRINT')
    expect(panel).not.toContain('FULL SYSTEM PROMPT SHOULD NOT PRINT')
    expect(panel).not.toContain('FULL USER CONTEXT SHOULD NOT PRINT')
    expect(panel).not.toContain('FULL GIT STATUS SHOULD NOT PRINT')
    expect(panel).not.toContain('RAW REQUEST SYSTEM SHOULD NOT PRINT')
    expect(panel).not.toContain('FULL OLD STRING SHOULD NOT PRINT')
    expect(panel).not.toContain('FULL NEW STRING SHOULD NOT PRINT')
    expect(panel).not.toContain('FULL HOOK COMMAND SHOULD NOT PRINT')
  })
})
```

- [ ] **Step 2: Run the panel test and verify RED**

Run:

```bash
bun test src/trace/__tests__/panel.test.ts
```

Expected: FAIL. The failure should show at least one missing compact summary such as `system/internal=1 collapsed`, or a forbidden raw string still present in the panel.

If the test passes immediately, make the test stricter by adding one more forbidden raw string from the captured user scenario:

```ts
expect(panel).not.toContain('SessionStart:startup')
expect(panel).not.toContain('worker-service.cjs')
```

Then rerun until the test fails for the intended reason.

## Task 2: Implement Compact Panel Summaries

**Files:**
- Modify: `src/trace/panel.ts`
- Test: `src/trace/__tests__/panel.test.ts`

- [ ] **Step 1: Add panel-only constants and helper types**

In `src/trace/panel.ts`, extend the section union and colors:

```ts
type PanelSection =
  | 'USER'
  | 'SYSTEM'
  | 'MESSAGES'
  | 'LLM'
  | 'DECISION'
  | 'TOOL'
  | 'INTERNAL'
  | 'STORE'
  | 'ERROR'
  | 'RAW'
```

Use this color mapping:

```ts
const SECTION_COLORS: Record<PanelSection, string> = {
  USER: '36',
  SYSTEM: '35',
  MESSAGES: '34',
  LLM: '33',
  DECISION: '37',
  TOOL: '32',
  INTERNAL: '95',
  STORE: '90',
  ERROR: '31',
  RAW: '96',
}
```

Add:

```ts
const MAX_PANEL_TEXT_CHARS = 240
```

- [ ] **Step 2: Replace raw `SYSTEM` and `MESSAGES` formatting**

Change the top of `formatTracePanel()` from raw values:

```ts
lines.push(formatSection('USER', extractUserInput(userInput)))
lines.push(formatSection('SYSTEM', systemPrompt))
lines.push(formatSection('MESSAGES', userInput))
```

to summaries:

```ts
const messageSummary = summarizeMessages(userInput)
lines.push(formatSection('USER', messageSummary.userText))
lines.push(formatSection('MESSAGES', messageSummary.summaryLines.join('\n')))
lines.push(
  formatSection(
    'SYSTEM',
    summarizeSystemContext(systemPrompt, userContext, systemContext),
  ),
)
```

Do not push raw `userContext/systemContext` into `STORE`. `STORE` should remain transcript/session storage summary only.

- [ ] **Step 3: Add `summarizeMessages()`**

Add this function in `src/trace/panel.ts`:

```ts
function summarizeMessages(messages: unknown): {
  userText: string
  summaryLines: string[]
} {
  if (!Array.isArray(messages)) {
    return {
      userText: formatPreview(messages),
      summaryLines: ['messages: none'],
    }
  }

  let userCount = 0
  let assistantCount = 0
  let systemInternalCount = 0
  let attachmentCount = 0
  const userTexts: string[] = []

  for (const message of messages) {
    if (!isRecord(message)) {
      systemInternalCount += 1
      continue
    }

    if (message.type === 'user') {
      userCount += 1
      const inner = message.message
      if (isRecord(inner)) {
        collectText(inner.content, userTexts)
      }
      continue
    }

    if (message.type === 'assistant') {
      assistantCount += 1
      continue
    }

    if (message.type === 'attachment') {
      attachmentCount += 1
      continue
    }

    systemInternalCount += 1
  }

  const summaryLines = [
    `user=${userCount}`,
    `assistant=${assistantCount}`,
    `system/internal=${systemInternalCount} collapsed`,
    `attachments/hooks=${attachmentCount} collapsed`,
  ]

  return {
    userText: userTexts.length > 0 ? userTexts.join('\n') : 'none',
    summaryLines,
  }
}
```

- [ ] **Step 4: Add `summarizeSystemContext()` and `formatPreview()`**

Add:

```ts
function summarizeSystemContext(
  systemPrompt: unknown,
  userContext: unknown,
  systemContext: unknown,
): string {
  const lines: string[] = []

  if (Array.isArray(systemPrompt)) {
    lines.push(`systemPrompt: collapsed ${systemPrompt.length} block${systemPrompt.length === 1 ? '' : 's'}`)
  } else if (systemPrompt !== undefined) {
    lines.push('systemPrompt: collapsed')
  } else {
    lines.push('systemPrompt: none')
  }

  lines.push(userContext === undefined ? 'userContext: none' : 'userContext: collapsed')
  lines.push(systemContext === undefined ? 'systemContext: none' : 'systemContext: collapsed')

  return lines.join('\n')
}

function formatPreview(value: unknown): string {
  if (value === undefined) {
    return 'none'
  }

  if (typeof value === 'string') {
    return value.length > MAX_PANEL_TEXT_CHARS
      ? `${value.slice(0, MAX_PANEL_TEXT_CHARS)}...`
      : value
  }

  if (isRecord(value)) {
    const label =
      typeof value.type === 'string' ? value.type : 'object'
    return `${label} object collapsed`
  }

  if (Array.isArray(value)) {
    return `array(${value.length}) collapsed`
  }

  return String(value)
}
```

If Biome line width fails, split long template lines without changing output.

- [ ] **Step 5: Replace tool/hook/subagent raw payload dumps**

Change `summarizeTools()` so it returns string rows instead of raw payload objects:

```ts
function summarizeTools(records: TraceDisplayRecord[]): unknown {
  const rows = records
    .filter(record => record.source === 'tool')
    .map(record => summarizeToolRecord(record))

  return rows.length === 0 ? undefined : rows.join('\n')
}
```

Add:

```ts
function summarizeToolRecord(record: TraceDisplayRecord): string {
  const payload = isRecord(record.payload) ? record.payload : {}
  const toolName =
    typeof payload.toolName === 'string' ? payload.toolName : record.type
  const status =
    typeof payload.status === 'string'
      ? payload.status
      : typeof payload.decision === 'string'
        ? payload.decision
        : typeof payload.ok === 'boolean'
          ? payload.ok
            ? 'ok'
            : 'failed'
          : undefined
  const input = isRecord(payload.toolInput) ? payload.toolInput : undefined
  const path =
    typeof input?.file_path === 'string'
      ? input.file_path
      : typeof input?.path === 'string'
        ? input.path
        : undefined

  const parts = [toolName]
  if (path !== undefined) {
    parts.push(`path=${formatPreview(path)}`)
  }
  if (status !== undefined) {
    parts.push(`status=${status}`)
  }
  if (input !== undefined) {
    parts.push('input=collapsed')
  }

  return parts.join(' ')
}
```

Replace `summarizeHooks()` and `summarizeSubagents()` calls in `formatTracePanel()` with one `INTERNAL` section:

```ts
lines.push(formatSection('INTERNAL', summarizeInternal(records)))
```

Add:

```ts
function summarizeInternal(records: TraceDisplayRecord[]): unknown {
  const hookCount = records.filter(record => record.source === 'hook').length
  const titleCount = records.filter(
    record =>
      record.type === 'api.request_built' &&
      isRecord(record.payload) &&
      record.payload.querySource === 'generate_session_title',
  ).length
  const memoryCount = records.filter(
    record =>
      record.type === 'api.request_built' &&
      isRecord(record.payload) &&
      (record.payload.querySource === 'extract_memories' ||
        record.payload.querySource === 'session_memory'),
  ).length
  const subagentCount = records.filter(record => record.source === 'subagent')
    .length

  if (
    hookCount === 0 &&
    titleCount === 0 &&
    memoryCount === 0 &&
    subagentCount === 0
  ) {
    return undefined
  }

  return [
    `hooks=${hookCount} collapsed`,
    `memory/session side tasks=${memoryCount} collapsed`,
    `title generation=${titleCount} collapsed`,
    `subagents=${subagentCount} collapsed`,
  ].join('\n')
}
```

- [ ] **Step 6: Summarize LLM main vs side requests**

Keep `pickSummaryFields()`, but change `summarizeLlm()` output from full JSON arrays to short text rows:

```ts
function summarizeLlm(records: TraceDisplayRecord[]): unknown {
  const requests = records
    .filter(record => record.type === 'api.request_built')
    .map(record => pickSummaryFields(record.payload, LLM_REQUEST_SUMMARY_KEYS))
  const assistantMessages = records
    .filter(record => record.type === 'api.assistant_message')
    .map(record =>
      pickSummaryFields(record.payload, ASSISTANT_MESSAGE_SUMMARY_KEYS),
    )

  if (requests.length === 0 && assistantMessages.length === 0) {
    return undefined
  }

  const main = requests.filter(
    request => request.querySource === 'repl_main_thread',
  )
  const side = requests.filter(
    request => request.querySource !== 'repl_main_thread',
  )
  const rows: string[] = []

  for (const request of main) {
    rows.push(formatLlmRequest('main', request))
  }

  if (side.length > 0) {
    const labels = side
      .map(request =>
        typeof request.querySource === 'string'
          ? request.querySource
          : 'unknown',
      )
      .join(' / ')
    rows.push(`side: ${labels} collapsed`)
  }

  if (assistantMessages.length > 0) {
    rows.push(`assistant messages=${assistantMessages.length}`)
  }

  return rows.join('\n')
}

function formatLlmRequest(
  label: 'main',
  request: Record<string, unknown>,
): string {
  const parts = [`${label}: ${formatPreview(request.model)}`]

  if (typeof request.querySource === 'string') {
    parts.push(`source=${request.querySource}`)
  }
  if (typeof request.messageCount === 'number') {
    parts.push(`messages=${request.messageCount}`)
  }
  if (typeof request.toolCount === 'number') {
    parts.push(`tools=${request.toolCount}`)
  }

  return parts.join(' ')
}
```

The output must not include `rawRequestParams`.

- [ ] **Step 7: Add a `RAW` hint section**

At the end of `formatTracePanel()`, before `ERROR` or after it, add:

```ts
lines.push(formatSection('RAW', 'bun run dev trace tail --raw'))
```

Do not make this command dynamic. The README and status output already use the same command family.

- [ ] **Step 8: Run the focused test and verify GREEN**

Run:

```bash
bun test src/trace/__tests__/panel.test.ts
```

Expected: PASS.

## Task 3: Add CLI-Level Regression Coverage

**Files:**
- Modify: `src/trace/__tests__/cli.test.ts`
- Test: `src/trace/__tests__/cli.test.ts`

- [ ] **Step 1: Add a failing CLI test for the real noisy scenario**

In `src/trace/__tests__/cli.test.ts`, add this test after `replay prints an agent loop panel by default`:

```ts
test('replay panel collapses noisy internal records while raw keeps them', async () => {
  saveTraceConfig({ mode: 'learn', autoTailWindow: true })
  appendTraceEvent(
    makeTraceEvent({
      type: 'turn.start',
      source: 'query',
      payload: {
        messages: [
          {
            type: 'attachment',
            attachment: {
              type: 'hook_success',
              command: 'NOISY HOOK COMMAND SHOULD ONLY BE RAW',
            },
          },
          {
            type: 'attachment',
            attachment: {
              type: 'skill_listing',
              content: 'NOISY SKILL LIST SHOULD ONLY BE RAW',
            },
          },
          {
            type: 'user',
            message: { content: '读一下 README.md' },
          },
        ],
        systemPrompt: [
          {
            type: 'text',
            text: 'NOISY SYSTEM PROMPT SHOULD ONLY BE RAW',
          },
        ],
        userContext: {
          cwd: 'D:\\develop\\ClaudeCode',
          claudeMd: 'NOISY CLAUDE MD SHOULD ONLY BE RAW',
        },
        systemContext: {
          gitStatus: 'NOISY GIT STATUS SHOULD ONLY BE RAW',
        },
      },
    }),
  )
  appendTraceEvent(
    makeTraceEvent({
      eventId: 'event-tool-noisy',
      sequence: 2,
      type: 'tool.started',
      source: 'tool',
      payload: {
        toolName: 'Edit',
        toolInput: {
          file_path:
            'C:\\Users\\asuka\\.claude\\projects\\session-memory\\summary.md',
          old_string: 'NOISY OLD STRING SHOULD ONLY BE RAW',
          new_string: 'NOISY NEW STRING SHOULD ONLY BE RAW',
        },
      },
    }),
  )

  const panel = await runTrace(['replay', 'session-1'])
  const raw = await runTrace(['replay', 'session-1', '--raw'])

  expect(panel.exitCode).toBe(0)
  expect(panel.stdout).toContain('读一下 README.md')
  expect(panel.stdout).toContain('attachments/hooks=2 collapsed')
  expect(panel.stdout).toContain('systemPrompt: collapsed 1 block')
  expect(panel.stdout).toContain('input=collapsed')
  expect(panel.stdout).not.toContain('NOISY HOOK COMMAND SHOULD ONLY BE RAW')
  expect(panel.stdout).not.toContain('NOISY SKILL LIST SHOULD ONLY BE RAW')
  expect(panel.stdout).not.toContain('NOISY SYSTEM PROMPT SHOULD ONLY BE RAW')
  expect(panel.stdout).not.toContain('NOISY CLAUDE MD SHOULD ONLY BE RAW')
  expect(panel.stdout).not.toContain('NOISY GIT STATUS SHOULD ONLY BE RAW')
  expect(panel.stdout).not.toContain('NOISY OLD STRING SHOULD ONLY BE RAW')
  expect(panel.stdout).not.toContain('NOISY NEW STRING SHOULD ONLY BE RAW')

  expect(raw.exitCode).toBe(0)
  expect(raw.stdout).toContain('NOISY HOOK COMMAND SHOULD ONLY BE RAW')
  expect(raw.stdout).toContain('NOISY SKILL LIST SHOULD ONLY BE RAW')
  expect(raw.stdout).toContain('NOISY SYSTEM PROMPT SHOULD ONLY BE RAW')
  expect(raw.stdout).toContain('NOISY CLAUDE MD SHOULD ONLY BE RAW')
  expect(raw.stdout).toContain('NOISY GIT STATUS SHOULD ONLY BE RAW')
  expect(raw.stdout).toContain('NOISY OLD STRING SHOULD ONLY BE RAW')
  expect(raw.stdout).toContain('NOISY NEW STRING SHOULD ONLY BE RAW')
})
```

- [ ] **Step 2: Run CLI test and verify RED if Task 2 was not implemented yet**

Run:

```bash
bun test src/trace/__tests__/cli.test.ts
```

Expected before Task 2 implementation: FAIL because default panel still prints at least one noisy raw value.

If Task 2 has already been implemented, expected: PASS. In that case do not weaken the test.

- [ ] **Step 3: Run CLI test after Task 2 and verify GREEN**

Run:

```bash
bun test src/trace/__tests__/cli.test.ts
```

Expected: PASS.

## Task 4: Verify Feature-Gated and Default Paths

**Files:**
- Modify: none
- Test: existing trace tests

- [ ] **Step 1: Run focused panel and CLI tests**

Run:

```bash
bun test src/trace/__tests__/panel.test.ts src/trace/__tests__/cli.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run feature-enabled trace suite**

Run:

```bash
bun test --feature HARNESS_TRACE src/trace src/services/tools/__tests__/toolExecution.trace.test.ts
```

Expected: PASS. This proves the panel change does not break the trace instrumentation tests.

- [ ] **Step 3: Run default trace suite**

Run:

```bash
bun test src/trace
```

Expected: PASS. This proves default feature-off behavior still passes.

- [ ] **Step 4: Run TypeScript strict check**

Run:

```bash
bun run typecheck
```

Expected: PASS with `tsc --noEmit`.

## Task 5: Commit

**Files:**
- Commit only files changed by this plan.

- [ ] **Step 1: Inspect worktree**

Run:

```bash
git status --short --branch
```

Expected: changed files are limited to:

```text
 M src/trace/panel.ts
 M src/trace/__tests__/cli.test.ts
?? src/trace/__tests__/panel.test.ts
?? docs/superpowers/plans/2026-06-18-trace-panel-noise-collapse.md
```

Other pre-existing untracked files such as `.codex/` and `docs/superpowers/plans/2026-06-16-harness-trace.md` must not be staged.

- [ ] **Step 2: Stage exact files**

Run:

```bash
git add src/trace/panel.ts src/trace/__tests__/cli.test.ts src/trace/__tests__/panel.test.ts docs/superpowers/plans/2026-06-18-trace-panel-noise-collapse.md
```

- [ ] **Step 3: Commit with Conventional Commit**

Run:

```bash
git commit -m "fix: collapse noisy trace panel internals"
```

Expected: commit succeeds after pre-commit checks.

## Self-Review

Spec coverage:

- Default panel no longer prints giant raw context: covered by Tasks 1-3.
- Full details remain available in `--raw`: covered by Task 3.
- JSONL source of truth unchanged: captured layers are explicitly out of scope.
- CLI-first, no Web UI: no Web UI files are in scope.
- Trace default off/manual enable unchanged: no config/bus files are in scope.

Placeholder scan:

- No `TBD`, `TODO`, or open-ended implementation steps remain.
- Every code-changing step names exact files and concrete expected output.

Type consistency:

- New tests use `TraceDisplayRecord` from `src/trace/format.ts`.
- New renderer helpers return strings or small summary objects consumed by existing `formatSection()`.
- No production `as any` is required.
