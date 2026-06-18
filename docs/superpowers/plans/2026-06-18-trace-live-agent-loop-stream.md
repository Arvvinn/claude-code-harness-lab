# Trace Live Agent Loop Stream Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `claude trace tail`'s clearing panel with an append-only realtime Agent Loop stream, while keeping `--raw` as JSONL source-of-truth output and `trace replay` as historical review.

**Architecture:** Leave trace capture unchanged. Keep `src/trace/panel.ts` for `trace replay` summaries, add a new semantic live-stream layer that maps JSONL events into Agent Loop steps, and change `trace tail` to follow appended bytes from the current file end. `/trace learn` opens `claude trace tail`; `/trace full` opens `claude trace tail --deep`.

**Tech Stack:** Bun, TypeScript strict, `bun:test`, existing `src/trace` CLI/store/config modules, Ink slash command integration in `src/commands/trace/trace.ts`.

---

## File Structure

- Create: `src/trace/time.ts`
  - Human-facing local time formatter. JSONL timestamps remain UTC.
- Create: `src/trace/__tests__/time.test.ts`
  - Stable tests for local display formatting via explicit timezone.
- Create: `src/trace/liveStream.ts`
  - Converts `TraceDisplayRecord` into semantic live steps.
  - Renders those steps as Learn or Deep append-only lines.
  - Maintains small stream state for turn numbers, request numbers, and duplicate suppression.
- Create: `src/trace/__tests__/liveStream.test.ts`
  - Unit tests for Learn/Deep rendering, side-task collapse, stream delta aggregation, hook/tool visibility, and raw-body exclusion.
- Modify: `src/trace/cli.ts`
  - Parse `--deep`.
  - Keep `replay --raw` and `tail --raw`.
  - Change `tail` to read appended bytes from EOF by default.
  - Use live-stream renderer for `tail` and panel renderer for `replay`.
- Modify: `src/trace/__tests__/cli.test.ts`
  - Update old tail-panel expectations to stream expectations.
  - Add EOF-only tailing tests.
  - Add `--deep` and `--raw` coverage.
- Modify: `src/trace/panel.ts`
  - Convert `Last:` from UTC ISO to local display for human replay panels.
- Modify: `src/trace/__tests__/panel.test.ts`
  - Assert `Last:` no longer displays raw `Z` timestamp.
- Modify: `src/trace/liveWindow.ts`
  - Add mode-aware tail command selection.
  - Launch `claude trace tail --deep` for full mode.
- Modify: `src/trace/__tests__/liveWindow.test.ts`
  - Assert learn/full launch commands.
- Modify: `src/commands/trace/trace.ts`
  - Display the mode-aware tail command in `/trace full` status/fallback output.
- Modify: `src/commands/trace/__tests__/trace.test.ts`
  - Assert `/trace full` reports and launches `claude trace tail --deep`.

Do not modify these capture/source-of-truth files for this plan:

- `src/query.ts`
- `src/QueryEngine.ts`
- `src/services/api/claude.ts`
- `src/services/tools/toolExecution.ts`
- `src/services/tools/toolOrchestration.ts`
- `src/trace/redaction.ts`
- `src/trace/store.ts`

## Behavior Contract

`claude trace tail` prints:

```text
Trace Live - Learn
Started: 2026-06-18 00:03:47 local
Session: 991fab44-931a-450c-90f3-2994b00aea6b
Source: C:\Users\asuka\.claude\harness-traces\991fab44-...\events.jsonl

TURN 1 - read README.md
  USER read README.md
  LOOP messages[] prepared user=1 assistant=0 internal=7 tools=25
  LLM request sent deepseek-v4-pro
  LLM stream started
  LLM tool_use requested Read
  TOOL Read started path=D:\develop\ClaudeCode\README.md
  TOOL Read ok duration=2ms size=5031B
  LOOP tool_result appended, loop back to LLM
  DONE completed duration=309.9s
```

`claude trace tail --deep` prints the same causal chain with more structure:

```text
Trace Live - Deep
Started: 2026-06-18 00:03:47 local
Session: 991fab44-931a-450c-90f3-2994b00aea6b
Source: C:\Users\asuka\.claude\harness-traces\991fab44-...\events.jsonl

TURN 1 - read README.md
  USER INPUT source=repl_main_thread text=read README.md
  HARNESS context systemPrompt=13 blocks userContext=collapsed systemContext=collapsed
  HARNESS messages user=1 assistant=0 internal=7 attachments=6 tools=25
  REQUEST #1 provider=firstParty model=deepseek-v4-pro querySource=repl_main_thread messages=12 tools=25 maxTokens=32000 effort=medium
  STREAM #1 message_start
  STREAM #1 content_block_start tool_use Read
  STREAM #1 message_delta stop_reason=tool_use
  TOOL Read permission allow source=mode duration=0ms
  HOOK PreToolUse done duration=60415ms
  TOOL Read result ok duration=2ms size=5031B
  HOOK PostToolUse done duration=120419ms
  HARNESS transcript appended assistant bytes=628
  LOOP #1 next_turn toolUse=1 toolResult=1 duration=141715ms
  DONE completed duration=309900ms finalMessages=31
```

`claude trace tail --raw` prints appended JSONL lines exactly. No local time conversion, no renderer, no redaction beyond what the stored JSONL already contains.

## Task 1: Local Time Formatter And Replay Panel Timestamp

**Files:**
- Create: `src/trace/time.ts`
- Create: `src/trace/__tests__/time.test.ts`
- Modify: `src/trace/panel.ts`
- Modify: `src/trace/__tests__/panel.test.ts`

- [ ] **Step 1: Write failing formatter tests**

Create `src/trace/__tests__/time.test.ts`:

```ts
import { describe, expect, test } from 'bun:test'
import { formatTraceLocalTime } from '../time.js'

describe('formatTraceLocalTime', () => {
  test('formats UTC trace timestamps as local display time', () => {
    expect(
      formatTraceLocalTime('2026-06-17T16:03:47.556Z', {
        timeZone: 'Asia/Shanghai',
      }),
    ).toBe('2026-06-18 00:03:47 local')
  })

  test('does not leak raw UTC suffix into human display', () => {
    expect(
      formatTraceLocalTime('2026-06-17T16:03:47.556Z', {
        timeZone: 'Asia/Shanghai',
      }),
    ).not.toContain('Z')
  })

  test('handles invalid timestamps without throwing', () => {
    expect(formatTraceLocalTime('not-a-date')).toBe('invalid local time')
  })
})
```

Run:

```bash
bun test src/trace/__tests__/time.test.ts
```

Expected: FAIL because `src/trace/time.ts` does not exist.

- [ ] **Step 2: Implement the formatter**

Create `src/trace/time.ts`:

```ts
export interface TraceLocalTimeOptions {
  timeZone?: string
}

export function formatTraceLocalTime(
  timestamp: string,
  options: TraceLocalTimeOptions = {},
): string {
  const date = new Date(timestamp)

  if (Number.isNaN(date.getTime())) {
    return 'invalid local time'
  }

  const formatter = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    hourCycle: 'h23',
    ...(options.timeZone === undefined ? {} : { timeZone: options.timeZone }),
  })
  const parts = Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter(part => part.type !== 'literal')
      .map(part => [part.type, part.value]),
  )

  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second} local`
}
```

Run:

```bash
bun test src/trace/__tests__/time.test.ts
```

Expected: PASS.

- [ ] **Step 3: Use local time in replay panel**

In `src/trace/panel.ts`, add:

```ts
import { formatTraceLocalTime } from './time.js'
```

Change the existing line:

```ts
`Last: ${lastRecord.timestamp}`,
```

to:

```ts
`Last: ${formatTraceLocalTime(lastRecord.timestamp)}`,
```

- [ ] **Step 4: Add replay panel timestamp assertion**

In `src/trace/__tests__/panel.test.ts`, add a focused test:

```ts
test('formats Last timestamp as local human time instead of raw UTC', () => {
  const panel = formatTracePanel(
    [
      record({
        type: 'turn.start',
        source: 'query',
        timestamp: '2026-06-17T16:03:47.556Z',
        payload: {
          messages: [
            {
              type: 'user',
              message: { content: 'hello' },
            },
          ],
        },
      }),
    ],
    { title: 'Agent Loop Replay' },
  )

  expect(panel).toContain('Last:')
  expect(panel).not.toContain('Last: 2026-06-17T16:03:47.556Z')
})
```

Run:

```bash
bun test src/trace/__tests__/time.test.ts src/trace/__tests__/panel.test.ts
```

Expected: PASS.

## Task 2: Semantic Live Stream Mapper And Renderers

**Files:**
- Create: `src/trace/liveStream.ts`
- Create: `src/trace/__tests__/liveStream.test.ts`

- [ ] **Step 1: Write failing Learn/Deep tests**

Create `src/trace/__tests__/liveStream.test.ts`:

```ts
import { describe, expect, test } from 'bun:test'
import {
  createTraceLiveStream,
  renderTraceLiveHeader,
  type TraceLiveDepth,
} from '../liveStream.js'
import type { TraceEvent } from '../types.js'

function event(overrides: Partial<TraceEvent>): TraceEvent {
  return {
    eventId: overrides.eventId ?? `${overrides.type ?? 'event'}-1`,
    sessionId: overrides.sessionId ?? 'live-session',
    turnId: overrides.turnId,
    sequence: overrides.sequence ?? 1,
    timestamp: overrides.timestamp ?? '2026-06-17T16:03:47.556Z',
    mode: overrides.mode ?? 'learn',
    source: overrides.source ?? 'query',
    type: overrides.type ?? 'turn.start',
    payload: overrides.payload ?? {},
  }
}

function render(records: TraceEvent[], depth: TraceLiveDepth): string {
  const stream = createTraceLiveStream({ depth })

  return records.flatMap(record => stream.renderRecord(record)).join('')
}

describe('trace live stream', () => {
  test('renders Learn as concise agent-loop narration', () => {
    const output = render(
      [
        event({
          type: 'turn.start',
          source: 'query',
          payload: {
            querySource: 'repl_main_thread',
            messages: [
              { type: 'system', content: 'SYSTEM BODY SHOULD NOT PRINT' },
              {
                type: 'attachment',
                attachment: {
                  type: 'hook_success',
                  command: 'HOOK COMMAND SHOULD NOT PRINT',
                },
              },
              { type: 'user', message: { content: 'read README.md' } },
            ],
            systemPrompt: [{ type: 'text', text: 'PROMPT BODY SHOULD NOT PRINT' }],
            userContext: { claudeMd: 'CLAUDE MD SHOULD NOT PRINT' },
            systemContext: { gitStatus: 'GIT STATUS SHOULD NOT PRINT' },
          },
        }),
        event({
          type: 'api.request_built',
          source: 'api',
          payload: {
            querySource: 'repl_main_thread',
            provider: 'firstParty',
            model: 'deepseek-v4-pro',
            messageCount: 12,
            toolCount: 25,
            maxTokens: 32000,
            effort: 'medium',
            rawRequestParams: {
              system: 'RAW REQUEST SHOULD NOT PRINT',
            },
          },
        }),
        event({
          type: 'api.stream_event',
          source: 'api',
          payload: { eventType: 'message_start' },
        }),
        event({
          type: 'api.stream_event',
          source: 'api',
          payload: {
            eventType: 'content_block_start',
            contentBlockType: 'tool_use',
            contentBlockName: 'Read',
            contentBlockId: 'toolu_1',
          },
        }),
        event({
          type: 'tool.detected',
          source: 'tool',
          payload: {
            toolName: 'Read',
            toolUseId: 'toolu_1',
            toolInput: { file_path: 'D:\\develop\\ClaudeCode\\README.md' },
          },
        }),
        event({
          type: 'tool.started',
          source: 'tool',
          payload: {
            toolName: 'Read',
            toolUseId: 'toolu_1',
            status: 'started',
            toolInput: { file_path: 'D:\\develop\\ClaudeCode\\README.md' },
          },
        }),
        event({
          type: 'tool.result',
          source: 'tool',
          payload: {
            toolName: 'Read',
            toolUseId: 'toolu_1',
            status: 'ok',
            ok: true,
            durationMs: 2,
            toolResultSizeBytes: 5031,
          },
        }),
        event({
          type: 'transcript.appended',
          source: 'transcript',
          payload: { entryType: 'assistant', byteCount: 628 },
        }),
        event({
          type: 'query.loop_end',
          source: 'query',
          payload: {
            loopIndex: 1,
            stopReason: 'next_turn',
            toolUseCount: 1,
            toolResultCount: 1,
            durationMs: 141715,
          },
        }),
        event({
          type: 'turn.end',
          source: 'query',
          payload: {
            resultReason: 'completed',
            durationMs: 309900,
            finalMessageCount: 31,
          },
        }),
      ],
      'learn',
    )

    expect(output).toContain('TURN 1 - read README.md')
    expect(output).toContain('USER read README.md')
    expect(output).toContain('LOOP messages[] prepared user=1 assistant=0 internal=1 attachments=1 tools=25')
    expect(output).toContain('LLM request sent deepseek-v4-pro')
    expect(output).toContain('LLM stream started')
    expect(output).toContain('LLM tool_use requested Read')
    expect(output).toContain('TOOL Read started path=D:\\develop\\ClaudeCode\\README.md')
    expect(output).toContain('TOOL Read ok duration=2ms size=5031B')
    expect(output).toContain('LOOP tool_result appended, loop back to LLM')
    expect(output).toContain('DONE completed duration=309.9s')

    expect(output).not.toContain('SYSTEM BODY SHOULD NOT PRINT')
    expect(output).not.toContain('HOOK COMMAND SHOULD NOT PRINT')
    expect(output).not.toContain('PROMPT BODY SHOULD NOT PRINT')
    expect(output).not.toContain('CLAUDE MD SHOULD NOT PRINT')
    expect(output).not.toContain('GIT STATUS SHOULD NOT PRINT')
    expect(output).not.toContain('RAW REQUEST SHOULD NOT PRINT')
    expect(output.match(/tool_use requested Read/g)).toHaveLength(1)
  })

  test('renders Deep with harness and protocol structure', () => {
    const output = render(
      [
        event({
          type: 'turn.start',
          source: 'query',
          payload: {
            querySource: 'repl_main_thread',
            messages: [{ type: 'user', message: { content: 'read README.md' } }],
            systemPrompt: [{ type: 'text', text: 'PROMPT BODY SHOULD NOT PRINT' }],
            userContext: { claudeMd: 'CLAUDE MD SHOULD NOT PRINT' },
            systemContext: { gitStatus: 'GIT STATUS SHOULD NOT PRINT' },
          },
        }),
        event({
          type: 'api.request_built',
          source: 'api',
          payload: {
            querySource: 'repl_main_thread',
            provider: 'firstParty',
            model: 'deepseek-v4-pro',
            messageCount: 12,
            toolCount: 25,
            maxTokens: 32000,
            effort: 'medium',
          },
        }),
        event({
          type: 'hook.result',
          source: 'hook',
          payload: {
            hookEvent: 'PreToolUse',
            toolName: 'Read',
            status: 'completed',
            durationMs: 60415,
          },
        }),
        event({
          type: 'tool.permission_result',
          source: 'tool',
          payload: {
            toolName: 'Read',
            decision: 'allow',
            source: 'mode',
            durationMs: 0,
          },
        }),
        event({
          type: 'query.loop_end',
          source: 'query',
          payload: {
            loopIndex: 1,
            stopReason: 'next_turn',
            toolUseCount: 1,
            toolResultCount: 1,
            durationMs: 141715,
          },
        }),
      ],
      'deep',
    )

    expect(output).toContain('HARNESS context systemPrompt=1 block userContext=collapsed systemContext=collapsed')
    expect(output).toContain('REQUEST #1 provider=firstParty model=deepseek-v4-pro querySource=repl_main_thread messages=12 tools=25 maxTokens=32000 effort=medium')
    expect(output).toContain('HOOK PreToolUse done duration=60415ms')
    expect(output).toContain('TOOL Read permission allow source=mode duration=0ms')
    expect(output).toContain('LOOP #1 next_turn toolUse=1 toolResult=1 duration=141715ms')
    expect(output).not.toContain('PROMPT BODY SHOULD NOT PRINT')
    expect(output).not.toContain('CLAUDE MD SHOULD NOT PRINT')
    expect(output).not.toContain('GIT STATUS SHOULD NOT PRINT')
  })

  test('collapses side systems in Learn and shows request shape in Deep', () => {
    const sideEvent = event({
      type: 'api.request_built',
      source: 'api',
      payload: {
        querySource: 'generate_session_title',
        model: 'DeepSeek-V4-Flash',
        messageCount: 1,
        toolCount: 0,
        rawRequestParams: {
          messages: 'SIDE BODY SHOULD NOT PRINT',
        },
      },
    })

    expect(render([sideEvent], 'learn')).toContain('SIDE generate_session_title collapsed')
    expect(render([sideEvent], 'learn')).not.toContain('SIDE BODY SHOULD NOT PRINT')
    expect(render([sideEvent], 'deep')).toContain('SIDE generate_session_title model=DeepSeek-V4-Flash messages=1 tools=0')
    expect(render([sideEvent], 'deep')).not.toContain('SIDE BODY SHOULD NOT PRINT')
  })

  test('renders header with local start time', () => {
    const header = renderTraceLiveHeader({
      depth: 'learn',
      sessionId: 'live-session',
      eventsPath: 'C:\\trace\\events.jsonl',
      startedAt: '2026-06-17T16:03:47.556Z',
      timeZone: 'Asia/Shanghai',
    })

    expect(header).toContain('Trace Live - Learn')
    expect(header).toContain('Started: 2026-06-18 00:03:47 local')
    expect(header).toContain('Session: live-session')
    expect(header).toContain('Source: C:\\trace\\events.jsonl')
  })
})
```

Run:

```bash
bun test src/trace/__tests__/liveStream.test.ts
```

Expected: FAIL because `src/trace/liveStream.ts` does not exist.

- [ ] **Step 2: Implement exported types and header renderer**

Create `src/trace/liveStream.ts` with these exports:

```ts
import { formatTraceLocalTime } from './time.js'
import type { TraceDisplayRecord } from './format.js'

export type TraceLiveDepth = 'learn' | 'deep'

export interface TraceLiveStreamOptions {
  depth: TraceLiveDepth
}

export interface TraceLiveHeaderOptions {
  depth: TraceLiveDepth
  sessionId: string
  eventsPath: string
  startedAt?: string
  timeZone?: string
}

export interface TraceLiveStream {
  renderRecord(record: TraceDisplayRecord): string[]
}

interface TraceLiveState {
  turnNumber: number
  requestNumber: number
  currentRequestNumber: number
  shownToolUseIds: Set<string>
}

export function renderTraceLiveHeader(options: TraceLiveHeaderOptions): string {
  const title =
    options.depth === 'deep' ? 'Trace Live - Deep' : 'Trace Live - Learn'
  const startedAt = formatTraceLocalTime(
    options.startedAt ?? new Date().toISOString(),
    options.timeZone === undefined ? {} : { timeZone: options.timeZone },
  )

  return [
    title,
    `Started: ${startedAt}`,
    `Session: ${options.sessionId}`,
    `Source: ${options.eventsPath}`,
    '',
  ].join('\n')
}

export function createTraceLiveStream(
  options: TraceLiveStreamOptions,
): TraceLiveStream {
  const state: TraceLiveState = {
    turnNumber: 0,
    requestNumber: 0,
    currentRequestNumber: 0,
    shownToolUseIds: new Set(),
  }

  return {
    renderRecord(record) {
      return renderRecord(record, state, options.depth)
    },
  }
}
```

- [ ] **Step 3: Implement safe field helpers**

In `src/trace/liveStream.ts`, add helpers:

```ts
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function getString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' ? value : undefined
}

function getNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key]
  return typeof value === 'number' ? value : undefined
}

function getBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key]
  return typeof value === 'boolean' ? value : undefined
}

function getPayload(record: TraceDisplayRecord): Record<string, unknown> {
  return isRecord(record.payload) ? record.payload : {}
}

function isMainQuerySource(querySource: string | undefined): boolean {
  return (
    querySource === undefined ||
    querySource === 'repl_main_thread' ||
    querySource.startsWith('repl_main_thread:') ||
    querySource === 'sdk'
  )
}

function formatDurationMs(durationMs: number | undefined): string | undefined {
  if (durationMs === undefined) {
    return undefined
  }

  if (durationMs >= 1000) {
    return `${(durationMs / 1000).toFixed(1)}s`
  }

  return `${durationMs}ms`
}

function compactText(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined
  }

  const normalized = value.replace(/\s+/g, ' ').trim()

  return normalized.length <= 120 ? normalized : `${normalized.slice(0, 117)}...`
}
```

- [ ] **Step 4: Implement message and user extraction**

Add:

```ts
interface MessageCounts {
  user: number
  assistant: number
  internal: number
  attachments: number
}

function summarizeMessages(messages: unknown): MessageCounts {
  const counts: MessageCounts = {
    user: 0,
    assistant: 0,
    internal: 0,
    attachments: 0,
  }

  if (!Array.isArray(messages)) {
    return counts
  }

  for (const message of messages) {
    if (!isRecord(message)) {
      counts.internal += 1
      continue
    }

    const type = getString(message, 'type') ?? getString(message, 'role')
    if (type === 'user') {
      counts.user += 1
    } else if (type === 'assistant') {
      counts.assistant += 1
    } else if (
      type === 'attachment' ||
      type === 'hook' ||
      Object.hasOwn(message, 'attachment') ||
      Object.hasOwn(message, 'hook')
    ) {
      counts.attachments += 1
    } else {
      counts.internal += 1
    }
  }

  return counts
}

function extractLatestUserText(messages: unknown): string | undefined {
  if (!Array.isArray(messages)) {
    return undefined
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!isRecord(message)) {
      continue
    }

    if ((getString(message, 'type') ?? getString(message, 'role')) !== 'user') {
      continue
    }

    const inner = message.message
    if (!isRecord(inner)) {
      continue
    }

    const content = inner.content
    if (typeof content === 'string') {
      return compactText(content)
    }

    if (Array.isArray(content)) {
      const text = content
        .filter(isRecord)
        .map(block => (getString(block, 'type') === 'text' ? getString(block, 'text') : undefined))
        .find(value => value !== undefined)
      return compactText(text)
    }
  }

  return undefined
}
```

- [ ] **Step 5: Implement record dispatch**

Add `renderRecord()` and small formatters. The output strings must end with `\n`; `trace tail` will write them as-is.

```ts
function renderRecord(
  record: TraceDisplayRecord,
  state: TraceLiveState,
  depth: TraceLiveDepth,
): string[] {
  const payload = getPayload(record)

  switch (record.type) {
    case 'turn.start':
      return renderTurnStart(payload, state, depth)
    case 'api.request_built':
      return renderRequestBuilt(payload, state, depth)
    case 'api.stream_event':
      return renderStreamEvent(payload, state, depth)
    case 'tool.detected':
      return renderToolDetected(payload, state, depth)
    case 'tool.permission_result':
      return renderPermission(payload, depth)
    case 'tool.started':
      return renderToolStarted(payload)
    case 'tool.result':
    case 'tool.error':
    case 'tool.cancelled':
      return renderToolDone(record.type, payload)
    case 'hook.started':
    case 'hook.result':
      return renderHook(record.type, payload, depth)
    case 'transcript.appended':
      return renderTranscriptAppend(payload, depth)
    case 'query.loop_end':
      return renderLoopEnd(payload, depth)
    case 'turn.end':
      return renderTurnEnd(payload)
    case 'api.error':
    case 'api.retry':
    case 'trace.read_error':
      return [`  ERROR ${record.type} ${compactText(getString(payload, 'message')) ?? 'collapsed'}\n`]
    default:
      return []
  }
}
```

Implement the functions with the behavior asserted in Step 1. Key details:

- `renderTurnStart()` increments `state.turnNumber`, extracts latest user text from `payload.messages`, and prints `TURN <n> - <text>`.
- `renderTurnStart()` Learn line includes `LOOP messages[] prepared user=<n> assistant=<n> internal=<n> attachments=<n> tools=<toolCount>`.
- `renderTurnStart()` Deep lines include `USER INPUT`, `HARNESS context`, and `HARNESS messages`.
- `renderRequestBuilt()` checks `querySource`. Main requests increment `state.requestNumber`, update `state.currentRequestNumber`, and render LLM/REQUEST lines. Side requests render `SIDE <querySource> collapsed` in Learn and `SIDE <querySource> model=<model> messages=<messageCount> tools=<toolCount>` in Deep.
- `renderStreamEvent()` ignores `content_block_delta` in Learn. In Deep it may render a compact `STREAM #<n> content_block_delta <deltaType>` line without raw payload bodies.
- `renderStreamEvent()` uses `contentBlockId` to suppress duplicate Learn `tool_use requested <name>` lines if `tool.detected` later repeats the same tool.
- `renderToolDetected()` suppresses duplicates when `toolUseId` was already shown.
- `renderHook()` only renders `hook.result` in Learn when it has a visible duration/status. Deep renders both lifecycle events.
- `renderTranscriptAppend()` prints Learn loop-back only for useful append signals and Deep entry/byte count.
- `renderLoopEnd()` maps `stopReason=next_turn` to loop-back language in Learn and exact loop details in Deep.
- `renderTurnEnd()` prints duration in seconds for Learn and raw ms/final messages for Deep.

Run:

```bash
bun test src/trace/__tests__/liveStream.test.ts
```

Expected: PASS.

## Task 3: Incremental EOF Tail And CLI Mode Wiring

**Files:**
- Modify: `src/trace/cli.ts`
- Modify: `src/trace/__tests__/cli.test.ts`

- [ ] **Step 1: Update CLI tests for append-only tail**

In `src/trace/__tests__/cli.test.ts`, import `setTimeout` delay:

```ts
import { setTimeout as delay } from 'node:timers/promises'
```

Change `runTrace()` helper signature from:

```ts
tail: { follow: boolean } = { follow: false },
```

to:

```ts
tail: {
  follow?: boolean
  pollIntervalMs?: number
  idleTimeoutMs?: number
  startAtEnd?: boolean
} = { follow: false, startAtEnd: false },
```

Pass the full `tail` object into `traceMain()`.

Replace the old test named `tail prints a refreshing agent loop panel by default` with:

```ts
test('tail starts at EOF and streams newly appended Learn events', async () => {
  saveTraceConfig({ mode: 'learn', autoTailWindow: true })
  appendTraceEvent(
    makeTraceEvent({
      type: 'turn.start',
      source: 'query',
      payload: {
        messages: [
          {
            type: 'user',
            message: { content: 'old prompt should not print' },
          },
        ],
      },
    }),
  )

  const tailPromise = runTrace(['tail', 'session-1'], {
    follow: true,
    pollIntervalMs: 5,
    idleTimeoutMs: 80,
  })
  await delay(10)
  appendTraceEvent(
    makeTraceEvent({
      eventId: 'event-2',
      sequence: 2,
      type: 'turn.start',
      source: 'query',
      payload: {
        messages: [
          {
            type: 'user',
            message: { content: 'new prompt prints' },
          },
        ],
      },
    }),
  )

  const result = await tailPromise

  expect(result.exitCode).toBe(0)
  expect(result.stdout).toContain('Trace Live - Learn')
  expect(result.stdout).toContain('new prompt prints')
  expect(result.stdout).not.toContain('old prompt should not print')
  expect(result.stdout).not.toContain('\x1b[2J\x1b[H')
  expect(result.stdout).not.toContain('Agent Loop Live')
})
```

Add:

```ts
test('tail --deep streams Deep events', async () => {
  saveTraceConfig({ mode: 'full', autoTailWindow: true })

  const tailPromise = runTrace(['tail', 'session-1', '--deep'], {
    follow: true,
    pollIntervalMs: 5,
    idleTimeoutMs: 80,
  })
  await delay(10)
  appendTraceEvent(
    makeTraceEvent({
      type: 'api.request_built',
      source: 'api',
      payload: {
        querySource: 'repl_main_thread',
        provider: 'firstParty',
        model: 'deepseek-v4-pro',
        messageCount: 2,
        toolCount: 25,
      },
    }),
  )

  const result = await tailPromise

  expect(result.exitCode).toBe(0)
  expect(result.stdout).toContain('Trace Live - Deep')
  expect(result.stdout).toContain('REQUEST #1 provider=firstParty model=deepseek-v4-pro')
})
```

Update `tail --raw keeps streaming raw JSONL display` so it also starts the tail before appending the raw line. It must assert:

```ts
expect(result.stdout).toContain('"type":"turn.start"')
expect(result.stdout).toContain('raw tail prompt')
expect(result.stdout).not.toContain('old raw prompt should not print')
expect(result.stdout).not.toContain('Trace Live - Learn')
```

Run:

```bash
bun test src/trace/__tests__/cli.test.ts
```

Expected: FAIL because `tail` still reads existing lines and clears/redraws the panel.

- [ ] **Step 2: Add `--deep` parsing and tail options**

In `src/trace/cli.ts`, change `TraceTailOptions`:

```ts
export interface TraceTailOptions {
  follow?: boolean
  pollIntervalMs?: number
  idleTimeoutMs?: number
  startAtEnd?: boolean
}
```

Add:

```ts
function hasDeepFlag(args: string[]): boolean {
  return args.includes('--deep')
}
```

Update `USAGE` to:

```ts
const USAGE =
  'Usage: claude trace status|off|learn|full|list|tail [sessionId] [--deep] [--raw]|replay <sessionId> [--raw]|inspect <sessionId>'
```

In the `tail` case, pass `hasDeepFlag(args)`:

```ts
await writeTail(
  getFirstNonFlagArg(args.slice(1)),
  io,
  options.tail,
  hasRawFlag(args),
  hasDeepFlag(args),
)
```

- [ ] **Step 3: Replace panel tailing with incremental byte tailing**

In `src/trace/cli.ts`, update imports:

```ts
import { existsSync, openSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { closeSync, readSync } from 'node:fs'
import {
  createTraceLiveStream,
  renderTraceLiveHeader,
} from './liveStream.js'
```

Change `writeTail()` signature:

```ts
async function writeTail(
  requestedSessionId: string | undefined,
  io: TraceIo,
  options: TraceTailOptions = {},
  raw = false,
  deep = false,
): Promise<void> {
```

Replace the current `processedLineCount` loop with byte-offset logic:

```ts
  const follow = options.follow ?? true
  const pollIntervalMs = options.pollIntervalMs ?? 250
  const startAtEnd = options.startAtEnd ?? follow
  let offset = startAtEnd ? statSync(target.eventsPath).size : 0
  let pending = ''
  let idleStartedAt = Date.now()
  const stream = createTraceLiveStream({ depth: deep ? 'deep' : 'learn' })

  if (!raw) {
    writeText(
      io.stdout,
      renderTraceLiveHeader({
        depth: deep ? 'deep' : 'learn',
        sessionId: target.sessionId,
        eventsPath: target.eventsPath,
      }),
    )
  }

  for (;;) {
    const stat = statSync(target.eventsPath)
    if (stat.size < offset) {
      offset = startAtEnd ? stat.size : 0
      pending = ''
    }

    if (stat.size > offset) {
      const chunk = readFileChunk(target.eventsPath, offset, stat.size - offset)
      offset = stat.size
      pending += chunk
      const lines = pending.split(/\r?\n/)
      pending = lines.pop() ?? ''
      const completeLines = lines.filter(line => line.trim().length > 0)

      for (let index = 0; index < completeLines.length; index += 1) {
        const line = completeLines[index]!
        if (raw) {
          writeText(io.stdout, `${line}\n`)
          continue
        }

        const record = parseTraceJsonLine(line, {
          sessionId: target.sessionId,
          lineNumber: 0,
        })
        for (const rendered of stream.renderRecord(record)) {
          writeText(io.stdout, rendered)
        }
      }

      if (completeLines.length > 0) {
        idleStartedAt = Date.now()
      }
    }

    if (!follow) {
      return
    }

    if (
      options.idleTimeoutMs !== undefined &&
      Date.now() - idleStartedAt >= options.idleTimeoutMs
    ) {
      return
    }

    await delay(pollIntervalMs)
  }
```

Add the chunk reader:

```ts
function readFileChunk(path: string, offset: number, length: number): string {
  if (length <= 0) {
    return ''
  }

  const fd = openSync(path, 'r')
  try {
    const buffer = Buffer.alloc(length)
    const bytesRead = readSync(fd, buffer, 0, length, offset)
    return buffer.subarray(0, bytesRead).toString('utf8')
  } finally {
    closeSync(fd)
  }
}
```

Run:

```bash
bun test src/trace/__tests__/cli.test.ts
```

Expected: PASS.

- [ ] **Step 4: Preserve non-follow historical tail behavior for tests**

If existing smoke tests call `traceMain(['tail'], { tail: { follow: false } })`, they should set `startAtEnd: false` or rely on the default `startAtEnd = follow`. Verify by running:

```bash
bun test src/trace/__tests__/smoke.test.ts src/trace/__tests__/cli.test.ts
```

Expected: PASS.

## Task 4: Mode-Aware Tail Window And Slash Command Output

**Files:**
- Modify: `src/trace/liveWindow.ts`
- Modify: `src/trace/__tests__/liveWindow.test.ts`
- Modify: `src/commands/trace/trace.ts`
- Modify: `src/commands/trace/__tests__/trace.test.ts`

- [ ] **Step 1: Add failing live window tests**

In `src/trace/__tests__/liveWindow.test.ts`, update the Windows launch test to keep learn behavior and add a full-mode test:

```ts
test('launches deep tail command for full mode on Windows', async () => {
  const calls: Array<{ executable: string; args: string[] }> = []
  resetTraceTailWindowForTesting()
  setTraceTailWindowSpawnForTesting(async (executable, args) => {
    calls.push({ executable, args })
    return { ok: true }
  })

  const result = await launchTraceTailWindow({
    config: { mode: 'full', autoTailWindow: true },
    platform: 'win32',
  })

  expect(result).toMatchObject({
    ok: true,
    command: 'claude trace tail --deep',
    launcher: 'pwsh',
  })
  expect(calls[0]?.args).toEqual([
    '-NoProfile',
    '-Command',
    "Start-Process pwsh -ArgumentList '-NoExit','-Command','claude trace tail --deep'",
  ])
})
```

In `src/commands/trace/__tests__/trace.test.ts`, add:

```ts
test('full reports the deep tail command', async () => {
  const { call } = await import('../trace.js')

  const result = await call('full', makeContext())
  await flushTraceForTesting()

  expect(result).toEqual({
    type: 'display',
    value: expect.stringContaining('Tail: claude trace tail --deep'),
  })
})
```

Run:

```bash
bun test src/trace/__tests__/liveWindow.test.ts src/commands/trace/__tests__/trace.test.ts
```

Expected: FAIL because the command is still always `claude trace tail`.

- [ ] **Step 2: Add mode-aware command helper**

In `src/trace/liveWindow.ts`, keep the existing constant and add:

```ts
export const TRACE_TAIL_DEEP_COMMAND = 'claude trace tail --deep'

export function getTraceTailCommand(config: Pick<TraceConfig, 'mode'>): string {
  return config.mode === 'full' ? TRACE_TAIL_DEEP_COMMAND : TRACE_TAIL_COMMAND
}
```

Inside `launchTraceTailWindow()`, compute:

```ts
const command = getTraceTailCommand(config)
```

Return `command` instead of `TRACE_TAIL_COMMAND` in every result object.

- [ ] **Step 3: Make launcher candidates command-aware**

Change:

```ts
const candidates = getLauncherCandidates(options.platform ?? process.platform)
```

to:

```ts
const candidates = getLauncherCandidates(
  options.platform ?? process.platform,
  command,
)
```

Change the function signature:

```ts
function getLauncherCandidates(
  platform: typeof process.platform,
  command: string,
): LauncherCandidate[] {
```

Replace hardcoded command strings:

```ts
`Start-Process pwsh -ArgumentList '-NoExit','-Command','${command}'`
`Start-Process powershell -ArgumentList '-NoExit','-Command','${command}'`
`tell application "Terminal" to do script "${command}"`
command.split(' ')
```

For Linux, avoid shell splitting bugs by using explicit arrays:

```ts
const commandArgs =
  command === TRACE_TAIL_DEEP_COMMAND
    ? ['claude', 'trace', 'tail', '--deep']
    : ['claude', 'trace', 'tail']
```

Use `commandArgs` for `wt`, `gnome-terminal`, and `xterm`.

- [ ] **Step 4: Use mode-aware command in slash command output**

In `src/commands/trace/trace.ts`, change import:

```ts
import {
  getTraceTailCommand,
  launchTraceTailWindow,
  TRACE_TAIL_COMMAND,
  type TraceTailWindowLaunchResult,
} from '../../trace/liveWindow.js'
```

In `formatTraceStatus()`, compute the config/mode command:

```ts
const mode = getTraceMode()
const tailCommand = getTraceTailCommand({ mode })
```

Use `tailCommand` for all `Tail:` lines in that function.

For `action === 'tail'`, keep the explicit manual command as the shallow default:

```ts
value: `Trace tail command:\n${TRACE_TAIL_COMMAND}\nDeep tail command:\n${getTraceTailCommand({ mode: 'full' })}`,
```

Run:

```bash
bun test src/trace/__tests__/liveWindow.test.ts src/commands/trace/__tests__/trace.test.ts
```

Expected: PASS.

## Task 5: Final Trace Suite, Typecheck, And Commit

**Files:**
- Commit only files changed by this plan plus the already committed design spec already present on this branch.

- [ ] **Step 1: Run focused tests**

Run:

```bash
bun test src/trace/__tests__/time.test.ts src/trace/__tests__/liveStream.test.ts src/trace/__tests__/cli.test.ts src/trace/__tests__/liveWindow.test.ts src/commands/trace/__tests__/trace.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run full trace tests**

Run:

```bash
bun test src/trace
```

Expected: PASS.

- [ ] **Step 3: Run command trace tests**

Run:

```bash
bun test src/commands/trace
```

Expected: PASS.

- [ ] **Step 4: Run strict typecheck**

Run:

```bash
bun run typecheck
```

Expected: PASS with `tsc --noEmit`.

- [ ] **Step 5: Inspect exact worktree state**

Run:

```bash
git status --short --branch
```

Expected tracked changes include this plan and implementation files. Pre-existing untracked files must remain untracked and unstaged:

```text
?? .codex/
?? docs/superpowers/plans/2026-06-16-harness-trace.md
```

- [ ] **Step 6: Stage exact files**

Run:

```bash
git add docs/superpowers/plans/2026-06-18-trace-live-agent-loop-stream.md src/trace/time.ts src/trace/liveStream.ts src/trace/cli.ts src/trace/panel.ts src/trace/liveWindow.ts src/trace/__tests__/time.test.ts src/trace/__tests__/liveStream.test.ts src/trace/__tests__/cli.test.ts src/trace/__tests__/panel.test.ts src/trace/__tests__/liveWindow.test.ts src/commands/trace/trace.ts src/commands/trace/__tests__/trace.test.ts
```

- [ ] **Step 7: Commit with Conventional Commit**

Run:

```bash
git commit -m "feat: stream trace live agent loop"
```

Expected: commit succeeds.

## Self-Review

Spec coverage:

- `trace tail` realtime stream by default: Task 3.
- `trace tail --deep`: Tasks 2 and 3.
- `trace tail --raw`: Task 3 preserves exact JSONL.
- Append-only, no clear-screen redraw: Task 3 assertions.
- Starts from current EOF: Task 3 assertions and implementation.
- Local time once at startup: Tasks 1 and 2.
- Replay `Last:` local display: Task 1.
- `/trace learn` shallow and `/trace full` deep auto tail: Task 4.
- Side systems collapsed in Learn and shaped in Deep: Task 2.
- Stream delta flood avoided: Task 2 ignores/compacts `content_block_delta`.
- No capture-layer mutation: file scope explicitly excludes query/API/tool execution capture files.
- CLI-first, no Web UI: no UI or web files in scope.

Placeholder scan:

- No `TBD`, `TODO`, or "fill later" placeholders.
- Each task names exact files, commands, and expected outcomes.
- Code snippets define the public interfaces subagents need.

Type consistency:

- `TraceLiveDepth` is used consistently by header, stream factory, tests, and CLI `--deep`.
- `TraceTailOptions.startAtEnd` defaults to `follow`, preserving non-follow historical tests.
- `TraceMode` remains `off | learn | full`; `--deep` is display depth, not persisted trace mode.
- `TRACE_TAIL_COMMAND` remains shallow; `getTraceTailCommand({ mode: 'full' })` returns deep.
