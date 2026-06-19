# Trace Readable Bilingual Stream Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Harness Trace easier to understand at a glance by turning the Agent Loop Stream into a consistently separated, bilingual, stage-explained view with an English-only mode.

**Architecture:** Keep JSONL capture, redaction, and `--raw` behavior unchanged. Extend only the human display layer around `src/trace/liveStream.ts` and `src/trace/cli.ts` so `learn` and `deep` share one block-oriented renderer with localized stage copy. Store no localization state in trace events; language is a CLI display option.

**Tech Stack:** Bun, TypeScript strict, `bun:test`, existing trace CLI modules, ANSI terminal output with non-color fallback.

---

## Product Decisions

- Default human view is bilingual: Chinese plus English in the same label.
- English-only mode is available through `--lang en` for foreign users and open-source readers.
- `--lang zh` is also accepted for compact Chinese-only labels.
- Tool names must stay as original English identifiers, for example `Read`, `Edit`, `Bash`, `TodoWrite`.
- Learn and Deep both use the same separated block layout.
- A new turn starts a new visual block with a blank line before it.
- Major steps inside a turn are visually grouped by consistent stage labels, not by raw event names.
- Low-level event names remain dim metadata only when color is enabled.
- `trace tail --raw` and `trace replay --raw` stay exact JSONL.
- No trace data is injected into model messages, system prompt, user context, or tool input.

## Intended Output Shape

Default `trace tail` / `trace replay`:

```text
Trace Live - Learn
Language: zh+en
Pattern: User -> messages[] -> LLM -> decision -> tools -> results -> loop/return

TURN 1 - 读一下 README.md

  [TURN 轮次 / Turn] 1 - 读一下 README.md
  [USER 用户输入 / User Input] 读一下 README.md
  [PREP 构造上下文 / Context Prep] messages[] prepared user=1 assistant=0 internal=3 attachments=5 tools=25
  [LLM 模型请求 / Model Request] request sent deepseek-v4-pro
  [STREAM 模型流 / Model Stream] tool_use requested Read
  [TOOL 工具 / Tool] Read started path=D:\develop\ClaudeCode\README.md
  [TOOL 工具 / Tool] Read ok duration=6ms size=5031B
  [DECISION 决策 / Decision] tool_result appended, loop back to LLM

  [PREP 构造上下文 / Context Prep] messages[] prepared user=1 assistant=0 internal=3 attachments=5 tools=0
  [LLM 模型请求 / Model Request] request sent deepseek-v4-pro
  [DONE 完成 / Done] completed duration=31.2s
```

English mode:

```text
Trace Live - Learn
Language: en
Pattern: User -> messages[] -> LLM -> decision -> tools -> results -> loop/return

TURN 1 - read README.md

  [TURN / Turn] 1 - read README.md
  [USER / User Input] read README.md
  [PREP / Context Prep] messages[] prepared user=1 assistant=0 internal=3 attachments=5 tools=25
  [LLM / Model Request] request sent deepseek-v4-pro
  [STREAM / Model Stream] tool_use requested Read
  [TOOL / Tool] Read started path=D:\develop\ClaudeCode\README.md
  [DONE / Done] completed duration=31.2s
```

## File Structure

- Modify: `src/trace/liveStream.ts`
  - Add language options, localized stage labels, block spacing, and header legend.
  - Keep tool identifiers and technical field names unchanged.
- Modify: `src/trace/__tests__/liveStream.test.ts`
  - Cover bilingual default, `en`, `zh`, block spacing, tool-name preservation, and no raw-body leaks.
- Modify: `src/trace/cli.ts`
  - Parse `--lang zh|en|both` for `tail` and `replay`.
  - Thread language into the stream renderer and header.
  - Reject invalid language values with a clear CLI error.
- Modify: `src/trace/__tests__/cli.test.ts`
  - Cover default bilingual replay/tail, English replay, invalid language, and raw bypass.
- Modify: `src/commands/trace/trace.ts`
  - Update help/status text so users can discover `claude trace tail --lang en` and `claude trace tail --deep --lang en`.
- Modify: `src/commands/trace/__tests__/trace.test.ts`
  - Assert slash-command text mentions language options without changing trace mode semantics.
- Modify: `README.md`
  - Add a short usage section for bilingual and English trace viewing.

Do not modify these files for this plan:

- `src/query.ts`
- `src/QueryEngine.ts`
- `src/services/api/claude.ts`
- `src/trace/store.ts`
- `src/trace/redaction.ts`
- `src/trace/types.ts`

## Task 1: Localized Stage Labels And Block Spacing

**Files:**
- Modify: `src/trace/liveStream.ts`
- Modify: `src/trace/__tests__/liveStream.test.ts`

- [ ] **Step 1: Add failing label and spacing tests**

In `src/trace/__tests__/liveStream.test.ts`, add tests for default bilingual rendering:

```ts
test('renders bilingual stage labels by default', () => {
  const output = render(coloredStageRecords(), 'learn')

  expect(output).toContain('[TURN 轮次 / Turn]')
  expect(output).toContain('[USER 用户输入 / User Input]')
  expect(output).toContain('[PREP 构造上下文 / Context Prep]')
  expect(output).toContain('[LLM 模型请求 / Model Request]')
  expect(output).toContain('[TOOL 工具 / Tool] Read started')
})
```

Add an English mode test:

```ts
test('renders English-only labels when language is en', () => {
  const output = render(coloredStageRecords(), 'learn', { language: 'en' })

  expect(output).toContain('[TURN / Turn]')
  expect(output).toContain('[USER / User Input]')
  expect(output).toContain('[TOOL / Tool] Read started')
  expect(output).not.toContain('用户输入')
  expect(output).not.toContain('工具]')
})
```

Add a Chinese mode test:

```ts
test('renders Chinese-only labels when language is zh', () => {
  const output = render(coloredStageRecords(), 'learn', { language: 'zh' })

  expect(output).toContain('[TURN 轮次]')
  expect(output).toContain('[USER 用户输入]')
  expect(output).not.toContain('User Input')
})
```

Add a turn block spacing test:

```ts
test('starts each visible turn as a separated block', () => {
  const output = render(
    [
      event({ type: 'turn.start', payload: { messages: [{ type: 'user', message: { content: 'first' } }] } }),
      event({ type: 'turn.end', payload: { resultReason: 'completed' } }),
      event({ type: 'turn.start', payload: { messages: [{ type: 'user', message: { content: 'second' } }] } }),
    ],
    'learn',
  )

  expect(output).toContain('\n\n  [TURN 轮次 / Turn] 2 - second')
})
```

Run:

```bash
bun test src/trace/__tests__/liveStream.test.ts
```

Expected: FAIL until language and spacing are implemented.

- [ ] **Step 2: Add language types and label dictionary**

In `src/trace/liveStream.ts`, add:

```ts
export type TraceDisplayLanguage = 'both' | 'zh' | 'en'

export interface TraceLiveStreamOptions {
  depth: TraceLiveDepth
  color?: boolean
  language?: TraceDisplayLanguage
}
```

Add stage copy:

```ts
interface StageCopy {
  code: string
  zh: string
  en: string
}

const STAGE_COPY: Record<StreamStage, StageCopy> = {
  TURN: { code: 'TURN', zh: '轮次', en: 'Turn' },
  USER: { code: 'USER', zh: '用户输入', en: 'User Input' },
  PREP: { code: 'PREP', zh: '构造上下文', en: 'Context Prep' },
  LLM: { code: 'LLM', zh: '模型请求', en: 'Model Request' },
  STREAM: { code: 'STREAM', zh: '模型流', en: 'Model Stream' },
  DECISION: { code: 'DECISION', zh: '决策', en: 'Decision' },
  TOOL: { code: 'TOOL', zh: '工具', en: 'Tool' },
  HOOK: { code: 'HOOK', zh: '钩子', en: 'Hook' },
  SIDE: { code: 'SIDE', zh: '旁路任务', en: 'Side Task' },
  STORE: { code: 'STORE', zh: '记录写入', en: 'Storage' },
  DONE: { code: 'DONE', zh: '完成', en: 'Done' },
  ERROR: { code: 'ERROR', zh: '错误', en: 'Error' },
}
```

Implement:

```ts
function formatStageLabel(
  stage: StreamStage,
  language: TraceDisplayLanguage,
): string {
  const copy = STAGE_COPY[stage]

  if (language === 'en') {
    return `${copy.code} / ${copy.en}`
  }

  if (language === 'zh') {
    return `${copy.code} ${copy.zh}`
  }

  return `${copy.code} ${copy.zh} / ${copy.en}`
}
```

- [ ] **Step 3: Thread language and spacing through the stream**

Extend `TraceLiveState`:

```ts
language: TraceDisplayLanguage
hasRenderedVisibleTurn: boolean
```

Initialize:

```ts
language: options.language ?? 'both',
hasRenderedVisibleTurn: false,
```

Change `stageLine()` to read language:

```ts
function stageLine(
  stage: StreamStage,
  text: string,
  state: Pick<TraceLiveState, 'color' | 'language'>,
): string[] {
  return [
    `  ${colorize(`[${formatStageLabel(stage, state.language)}]`, STAGE_COLORS[stage], state.color)} ${text}\n`,
  ]
}
```

When rendering a main `turn.start`, prepend one blank line before every visible turn after the first:

```ts
const prefix = state.hasRenderedVisibleTurn ? ['\n'] : []
state.hasRenderedVisibleTurn = true
return [...prefix, ...stageLine('TURN', `${state.turnNumber} - ${userText}`, state)]
```

Do not add blank lines for side turns or hidden events.

- [ ] **Step 4: Preserve technical identifiers**

Keep these strings unchanged in every language mode:

- Tool names: `Read`, `Edit`, `Bash`, `TodoWrite`
- Event metadata: `event=api.request_built`
- Field keys: `messages[]`, `tool_use`, `duration`, `bytes`, `path`, `model`, `provider`
- Query sources: `repl_main_thread`, `session_memory`, `extract_memories`

Run:

```bash
bun test src/trace/__tests__/liveStream.test.ts
```

Expected: PASS.

## Task 2: Localized Header Legend

**Files:**
- Modify: `src/trace/liveStream.ts`
- Modify: `src/trace/__tests__/liveStream.test.ts`

- [ ] **Step 1: Add failing header tests**

Add tests:

```ts
test('renders bilingual header legend by default', () => {
  const header = renderTraceLiveHeader({
    depth: 'learn',
    sessionId: 'live-session',
    eventsPath: 'C:\\trace\\events.jsonl',
    startedAt: '2026-06-17T16:03:47.556Z',
    timeZone: 'Asia/Shanghai',
  })

  expect(header).toContain('Language: zh+en')
  expect(header).toContain('Pattern: User -> messages[] -> LLM -> decision -> tools -> results -> loop/return')
})

test('renders English header language marker', () => {
  const header = renderTraceLiveHeader({
    depth: 'deep',
    sessionId: 'live-session',
    eventsPath: 'C:\\trace\\events.jsonl',
    language: 'en',
  })

  expect(header).toContain('Language: en')
  expect(header).toContain('Trace Live - Deep')
})
```

Run:

```bash
bun test src/trace/__tests__/liveStream.test.ts
```

Expected: FAIL because headers do not accept `language`.

- [ ] **Step 2: Extend header options**

In `src/trace/liveStream.ts`, update:

```ts
export interface TraceLiveHeaderOptions {
  depth: TraceLiveDepth
  sessionId: string
  eventsPath: string
  startedAt?: string
  timeZone?: string
  language?: TraceDisplayLanguage
}
```

Add:

```ts
function formatLanguageMarker(language: TraceDisplayLanguage): string {
  if (language === 'both') {
    return 'zh+en'
  }

  return language
}
```

Include these header lines after `Source:`:

```ts
`Language: ${formatLanguageMarker(language)}`,
'Pattern: User -> messages[] -> LLM -> decision -> tools -> results -> loop/return',
```

Run:

```bash
bun test src/trace/__tests__/liveStream.test.ts
```

Expected: PASS.

## Task 3: CLI `--lang` Wiring For Tail And Replay

**Files:**
- Modify: `src/trace/cli.ts`
- Modify: `src/trace/__tests__/cli.test.ts`

- [ ] **Step 1: Add failing CLI tests**

In `src/trace/__tests__/cli.test.ts`, add:

```ts
test('replay defaults to bilingual stream labels', async () => {
  appendTraceEvent(makeTraceEvent({
    type: 'turn.start',
    payload: { messages: [{ type: 'user', message: { content: 'read README.md' } }] },
  }))

  const result = await runTrace(['replay', 'session-1'])

  expect(result.exitCode).toBe(0)
  expect(result.stdout).toContain('Language: zh+en')
  expect(result.stdout).toContain('[USER 用户输入 / User Input]')
})
```

Add English replay:

```ts
test('replay supports English-only labels', async () => {
  appendTraceEvent(makeTraceEvent({
    type: 'turn.start',
    payload: { messages: [{ type: 'user', message: { content: 'read README.md' } }] },
  }))

  const result = await runTrace(['replay', 'session-1', '--lang', 'en'])

  expect(result.exitCode).toBe(0)
  expect(result.stdout).toContain('Language: en')
  expect(result.stdout).toContain('[USER / User Input]')
  expect(result.stdout).not.toContain('用户输入')
})
```

Add invalid language:

```ts
test('rejects invalid trace language values', async () => {
  const result = await runTrace(['replay', 'session-1', '--lang', 'jp'])

  expect(result.exitCode).toBe(1)
  expect(result.stderr).toContain('Invalid trace language: jp')
})
```

Add raw bypass:

```ts
test('raw replay ignores language renderer', async () => {
  appendTraceEvent(makeTraceEvent({
    type: 'turn.start',
    payload: { messages: [{ type: 'user', message: { content: 'raw prompt' } }] },
  }))

  const result = await runTrace(['replay', 'session-1', '--raw', '--lang', 'en'])

  expect(result.exitCode).toBe(0)
  expect(result.stdout).toContain('"type":"turn.start"')
  expect(result.stdout).not.toContain('Language: en')
  expect(result.stdout).not.toContain('[USER / User Input]')
})
```

Run:

```bash
bun test src/trace/__tests__/cli.test.ts
```

Expected: FAIL until `--lang` is parsed and passed through.

- [ ] **Step 2: Parse language option**

In `src/trace/cli.ts`, import the type:

```ts
import type { TraceDisplayLanguage } from './liveStream.js'
```

Add:

```ts
function getLanguageFlag(args: string[]): TraceDisplayLanguage {
  const langIndex = args.indexOf('--lang')

  if (langIndex === -1) {
    return 'both'
  }

  const value = args[langIndex + 1]
  if (value === 'both' || value === 'zh' || value === 'en') {
    return value
  }

  throw new Error(`Invalid trace language: ${value ?? '<missing>'}`)
}
```

Update usage:

```ts
const USAGE =
  'Usage: claude trace status|off|learn|full|list|tail [sessionId] [--deep] [--lang zh|en|both] [--raw]|replay <sessionId> [--deep] [--lang zh|en|both] [--raw]|inspect <sessionId>'
```

Ensure `getFirstNonFlagArg()` skips the value after `--lang`, not just flags:

```ts
function getFirstNonFlagArg(args: string[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--lang') {
      index += 1
      continue
    }
    if (arg !== undefined && !arg.startsWith('-')) {
      return arg
    }
  }

  return undefined
}
```

- [ ] **Step 3: Thread language into replay and tail**

Update replay call:

```ts
getReplayText(sessionId, hasRawFlag(args), hasDeepFlag(args), getLanguageFlag(args), io.stdout)
```

Update tail call:

```ts
await writeTail(sessionId, io, options.tail, hasRawFlag(args), hasDeepFlag(args), getLanguageFlag(args))
```

Update `getReplayText()` and `writeTail()` signatures and pass `language` into:

```ts
createTraceLiveStream({ depth, color: shouldUseColor(output), language })
renderTraceLiveHeader({ depth, sessionId, eventsPath, language })
```

Run:

```bash
bun test src/trace/__tests__/cli.test.ts
```

Expected: PASS.

## Task 4: Slash Command And README Discoverability

**Files:**
- Modify: `src/commands/trace/trace.ts`
- Modify: `src/commands/trace/__tests__/trace.test.ts`
- Modify: `README.md`

- [ ] **Step 1: Add failing slash command tests**

In `src/commands/trace/__tests__/trace.test.ts`, add or update assertions so status/help text contains:

```ts
expect(result.value).toContain('claude trace tail --lang en')
expect(result.value).toContain('claude trace tail --deep --lang en')
```

Run:

```bash
bun test src/commands/trace/__tests__/trace.test.ts
```

Expected: FAIL until command text is updated.

- [ ] **Step 2: Update slash command output**

In `src/commands/trace/trace.ts`, keep existing mode semantics. Only update human text:

- `Tail: claude trace tail`
- `English: claude trace tail --lang en`
- `Deep English: claude trace tail --deep --lang en`

Do not change `/trace learn`, `/trace full`, or `/trace off` state transitions.

Run:

```bash
bun test src/commands/trace/__tests__/trace.test.ts
```

Expected: PASS.

- [ ] **Step 3: Update README**

In `README.md`, add a short trace usage block:

````markdown
### Trace 查看语言

默认视图是中英双语：

```bash
claude trace tail
claude trace replay <sessionId>
```

英文视图：

```bash
claude trace tail --lang en
claude trace replay <sessionId> --lang en
```

深度英文视图：

```bash
claude trace tail --deep --lang en
claude trace replay <sessionId> --deep --lang en
```

原始 JSONL 仍然使用：

```bash
claude trace tail --raw
claude trace replay <sessionId> --raw
```
````

Run:

```bash
bun test src/commands/trace/__tests__/trace.test.ts
```

Expected: PASS.

## Task 5: Final Verification And Commit

**Files:**
- All files changed by this plan only.

- [ ] **Step 1: Run focused tests**

Run:

```bash
bun test src/trace/__tests__/liveStream.test.ts src/trace/__tests__/cli.test.ts src/commands/trace/__tests__/trace.test.ts
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

- [ ] **Step 5: Inspect status and avoid unrelated files**

Run:

```bash
git status --short --branch
```

Expected unrelated untracked files remain unstaged:

```text
?? .codex/
?? docs/superpowers/plans/2026-06-16-harness-trace.md
```

- [ ] **Step 6: Stage exact files**

Run:

```bash
git add docs/superpowers/plans/2026-06-19-trace-readable-bilingual-stream.md src/trace/liveStream.ts src/trace/__tests__/liveStream.test.ts src/trace/cli.ts src/trace/__tests__/cli.test.ts src/commands/trace/trace.ts src/commands/trace/__tests__/trace.test.ts README.md
```

- [ ] **Step 7: Commit**

Run:

```bash
git commit -m "feat: improve trace stream readability"
```

Expected: commit succeeds.

## Self-Review

Spec coverage:

- Default bilingual human view: Tasks 1, 2, 3.
- English-only mode for foreign users: Tasks 1, 2, 3, 4.
- Chinese-only compact mode: Task 1 and Task 3 parser.
- Block spacing and visual grouping: Task 1.
- Tool names remain English identifiers: Task 1.
- `raw` remains exact JSONL: Task 3.
- No capture semantics change: file scope excludes capture/store/redaction/types.
- CLI-first, no Web UI: all changes stay in trace CLI and docs.

Placeholder scan:

- No `TBD`, `TODO`, or unspecified implementation placeholders.
- Each task names files, commands, and expected outcomes.

Type consistency:

- `TraceDisplayLanguage` is only a display option.
- `TraceLiveDepth` remains `learn | deep`.
- Persisted trace modes remain `off | learn | full`.
- CLI language parsing does not alter session config or JSONL content.
