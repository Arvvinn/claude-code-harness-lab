import {
  appendFile,
  mkdir,
  mkdtemp,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  readTraceTailChunkForTesting,
  readTraceTailContinuityMarkerForTesting,
  readTraceTailOrientationRecordsForTesting,
  traceMain,
} from '../cli.js'
import { loadTraceConfig, saveTraceConfig } from '../config.js'
import { getTraceEventsPath, getTraceRootDir } from '../paths.js'
import {
  appendTraceEvent,
  readActiveTraceSession,
  writeActiveTraceSession,
} from '../store.js'
import type { TraceEvent } from '../types.js'

const originalTraceDir = process.env.CLAUDE_CODE_TRACE_DIR
const originalNoColor = process.env.NO_COLOR
let traceDir: string

describe('trace CLI', () => {
  beforeEach(async () => {
    traceDir = await mkdtemp(join(tmpdir(), 'claude-trace-cli-'))
    process.env.CLAUDE_CODE_TRACE_DIR = traceDir
  })

  afterEach(async () => {
    if (originalTraceDir === undefined) {
      delete process.env.CLAUDE_CODE_TRACE_DIR
    } else {
      process.env.CLAUDE_CODE_TRACE_DIR = originalTraceDir
    }

    if (originalNoColor === undefined) {
      delete process.env.NO_COLOR
    } else {
      process.env.NO_COLOR = originalNoColor
    }

    await rm(traceDir, { recursive: true, force: true })
  })

  test('status works with an empty trace directory', async () => {
    const result = await runTrace(['status'])

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout).toContain('Trace status')
    expect(result.stdout).toContain('Mode: off')
    expect(result.stdout).toContain(`Trace dir: ${traceDir}`)
    expect(result.stdout).toContain('Active session: none')
  })

  test('mode commands persist config and off clears the active pointer', async () => {
    await mkdir(getTraceRootDir(), { recursive: true })
    writeActiveTraceSession({
      sessionId: 'session-1',
      eventsPath: getTraceEventsPath('session-1'),
      startedAt: '2026-06-16T00:00:00.000Z',
    })

    expect((await runTrace(['learn'])).exitCode).toBe(0)
    expect(loadTraceConfig().mode).toBe('learn')
    expect(readActiveTraceSession()?.sessionId).toBe('session-1')

    expect((await runTrace(['full'])).exitCode).toBe(0)
    expect(loadTraceConfig().mode).toBe('full')
    expect(readActiveTraceSession()?.sessionId).toBe('session-1')

    expect((await runTrace(['off'])).exitCode).toBe(0)
    expect(loadTraceConfig().mode).toBe('off')
    expect(readActiveTraceSession()).toBeNull()
  })

  test('list prints newest sessions first with counts and last timestamps', async () => {
    appendTraceEvent(
      makeTraceEvent({
        sessionId: 'older',
        timestamp: '2026-06-16T01:00:00.000Z',
      }),
    )
    appendTraceEvent(
      makeTraceEvent({
        sessionId: 'newer',
        timestamp: '2026-06-16T02:00:00.000Z',
      }),
    )
    appendTraceEvent(
      makeTraceEvent({
        eventId: 'event-2',
        sessionId: 'newer',
        sequence: 2,
        timestamp: '2026-06-16T03:00:00.000Z',
      }),
    )

    const result = await runTrace(['list'])

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('Trace sessions')
    expect(result.stdout.indexOf('newer')).toBeLessThan(
      result.stdout.indexOf('older'),
    )
    expect(result.stdout).toContain(
      'newer  events=2  last=2026-06-16T03:00:00.000Z',
    )
    expect(result.stdout).toContain(
      'older  events=1  last=2026-06-16T01:00:00.000Z',
    )
  })

  test('replay prints agent loop stream output by default', async () => {
    saveTraceConfig({ mode: 'learn', autoTailWindow: true })
    appendTraceEvent(
      makeTraceEvent({
        type: 'turn.start',
        source: 'query',
        payload: {
          inputChars: 41,
          messages: [
            {
              type: 'user',
              message: { content: 'explain the project' },
            },
          ],
          systemPrompt: [{ type: 'text', text: 'system prompt body' }],
        },
      }),
    )
    appendTraceEvent(
      makeTraceEvent({
        eventId: 'event-2',
        sequence: 2,
        type: 'api.request_built',
        source: 'api',
        payload: {
          model: 'claude-test',
          provider: 'firstParty',
          messageCount: 1,
          toolCount: 1,
          rawRequestParams: {
            system: 'raw system prompt should stay out of panel',
            messages: [
              {
                role: 'user',
                content: 'raw request message should stay out of panel',
              },
            ],
          },
        },
      }),
    )
    appendTraceEvent(
      makeTraceEvent({
        eventId: 'event-3',
        sequence: 3,
        type: 'tool.detected',
        source: 'tool',
        payload: {
          toolName: 'Read',
          toolUseId: 'toolu_1',
          toolInput: { file_path: 'README.md' },
        },
      }),
    )
    appendTraceEvent(
      makeTraceEvent({
        eventId: 'event-4',
        sequence: 4,
        type: 'query.loop_end',
        source: 'query',
        payload: {
          stopReason: 'next_turn',
          toolUseCount: 1,
          toolResultCount: 0,
        },
      }),
    )

    const result = await runTrace(['replay', 'session-1'])

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('Trace Replay - Learn')
    expect(result.stdout).toContain('Language: zh+en')
    expect(result.stdout).toContain('[USER 用户输入 / User Input]')
    expect(result.stdout).toContain('[LLM 模型请求 / Model Request]')
    expect(result.stdout).toContain('explain the project')
    expect(result.stdout).not.toContain('Agent Loop Replay')
    expect(result.stdout).not.toContain('[SYSTEM]')
    expect(result.stdout).not.toContain('rawRequestParams')
  })

  test('replay defaults to bilingual stream labels', async () => {
    appendTraceEvent(
      makeTraceEvent({
        type: 'turn.start',
        payload: {
          messages: [
            {
              type: 'user',
              message: { content: 'read README.md' },
            },
          ],
        },
      }),
    )

    const result = await runTrace(['replay', 'session-1'])

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('Language: zh+en')
    expect(result.stdout).toContain('[USER 用户输入 / User Input]')
  })

  test('replay supports English-only labels', async () => {
    appendTraceEvent(
      makeTraceEvent({
        type: 'turn.start',
        payload: {
          messages: [
            {
              type: 'user',
              message: { content: 'read README.md' },
            },
          ],
        },
      }),
    )

    const result = await runTrace(['replay', 'session-1', '--lang', 'en'])

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('Language: en')
    expect(result.stdout).toContain('[USER / User Input]')
    expect(result.stdout).not.toContain('用户输入')
  })

  test('replay accepts language before the session id', async () => {
    appendTraceEvent(
      makeTraceEvent({
        type: 'turn.start',
        payload: {
          messages: [
            {
              type: 'user',
              message: { content: 'read README.md' },
            },
          ],
        },
      }),
    )

    const result = await runTrace(['replay', '--lang', 'en', 'session-1'])

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('Language: en')
    expect(result.stdout).toContain('[USER / User Input]')
  })

  test('rejects invalid trace language values', async () => {
    const result = await runTrace(['replay', 'session-1', '--lang', 'jp'])

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('Invalid trace language: jp')
  })

  test('rejects missing trace language value', async () => {
    const result = await runTrace(['replay', 'session-1', '--lang'])

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('Invalid trace language: <missing>')
  })

  test('replay uses colored labels when stdout is a TTY', async () => {
    saveTraceConfig({ mode: 'learn', autoTailWindow: true })
    appendTraceEvent(
      makeTraceEvent({
        type: 'turn.start',
        source: 'query',
        payload: {
          messages: [
            {
              type: 'user',
              message: { content: 'inspect color output' },
            },
          ],
        },
      }),
    )

    const result = await runTrace(
      ['replay', 'session-1'],
      { follow: false, startAtEnd: false },
      { stdoutIsTTY: true },
    )

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('\x1b[36m[USER')
    expect(result.stdout).toContain('\x1b[0m')
  })

  test('replay disables colored labels when NO_COLOR is set', async () => {
    process.env.NO_COLOR = '1'
    saveTraceConfig({ mode: 'learn', autoTailWindow: true })
    appendTraceEvent(
      makeTraceEvent({
        type: 'turn.start',
        source: 'query',
        payload: {
          messages: [
            {
              type: 'user',
              message: { content: 'inspect uncolored output' },
            },
          ],
        },
      }),
    )

    const result = await runTrace(
      ['replay', 'session-1'],
      { follow: false, startAtEnd: false },
      { stdoutIsTTY: true },
    )

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('[USER')
    expect(result.stdout).not.toContain('\x1b[')
  })

  test('replay --deep prints deep agent loop stream output', async () => {
    saveTraceConfig({ mode: 'full', autoTailWindow: true })
    appendTraceEvent(
      makeTraceEvent({
        type: 'turn.start',
        source: 'query',
        payload: {
          messages: [
            {
              type: 'user',
              message: { content: 'explain the project' },
            },
          ],
        },
      }),
    )
    appendTraceEvent(
      makeTraceEvent({
        eventId: 'event-2',
        sequence: 2,
        type: 'api.request_built',
        source: 'api',
        payload: {
          model: 'claude-test',
          provider: 'firstParty',
          messageCount: 1,
          toolCount: 1,
        },
      }),
    )

    const result = await runTrace(['replay', 'session-1', '--deep'])

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('Trace Replay - Deep')
    expect(result.stdout).toContain('[PREP 构造上下文 / Context Prep]')
    expect(result.stdout).toContain('messages=')
  })

  test('replay collapses noisy internal detail by default while raw preserves it', async () => {
    const noisyStrings = [
      'NOISY HOOK COMMAND SHOULD ONLY BE RAW',
      'NOISY SKILL LIST SHOULD ONLY BE RAW',
      'NOISY SYSTEM PROMPT SHOULD ONLY BE RAW',
      'NOISY CLAUDE MD SHOULD ONLY BE RAW',
      'NOISY GIT STATUS SHOULD ONLY BE RAW',
      'NOISY OLD STRING SHOULD ONLY BE RAW',
      'NOISY NEW STRING SHOULD ONLY BE RAW',
    ]

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
              message: { content: 'read README.md' },
            },
          ],
          systemPrompt: [
            {
              type: 'text',
              text: 'NOISY SYSTEM PROMPT SHOULD ONLY BE RAW',
            },
          ],
          userContext: {
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
        eventId: 'event-2',
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
    expect(panel.stdout).toContain('Trace Replay - Learn')
    expect(panel.stdout).toContain(
      '[USER 用户输入 / User Input] read README.md',
    )
    expect(panel.stdout).toContain('[TOOL 工具 / Tool] Edit started')
    for (const noisyString of noisyStrings) {
      expect(panel.stdout).not.toContain(noisyString)
    }

    expect(raw.exitCode).toBe(0)
    for (const noisyString of noisyStrings) {
      expect(raw.stdout).toContain(noisyString)
    }
  })

  test('replay --raw prints raw JSONL events', async () => {
    saveTraceConfig({ mode: 'learn', autoTailWindow: true })
    appendTraceEvent(
      makeTraceEvent({
        type: 'turn.start',
        payload: {
          inputChars: 41,
          messages: [
            {
              type: 'user',
              message: { content: 'raw prompt is visible in raw mode' },
            },
          ],
        },
      }),
    )
    const manuallyFormattedLine =
      '  {"eventId":"manual-event","sessionId":"session-1","sequence":2,"timestamp":"2026-06-16T14:03:11.000Z","mode":"learn","source":"api","type":"api.request_built","payload":{"model":"claude-manual"}}  '
    const malformedLine = 'this is not valid JSONL but raw mode preserves it'
    await appendFile(
      getTraceEventsPath('session-1'),
      `${manuallyFormattedLine}\n${malformedLine}\n`,
    )

    const result = await runTrace(['replay', 'session-1', '--raw'])

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('"type":"turn.start"')
    expect(result.stdout).toContain('raw prompt is visible in raw mode')
    expect(result.stdout.split('\n')).toContain(manuallyFormattedLine)
    expect(result.stdout.split('\n')).toContain(malformedLine)
    expect(result.stdout).not.toContain('trace.read_error')
  })

  test('replay --raw --deep keeps raw JSONL output', async () => {
    saveTraceConfig({ mode: 'full', autoTailWindow: true })
    appendTraceEvent(
      makeTraceEvent({
        type: 'turn.start',
        source: 'query',
        payload: {
          messages: [
            {
              type: 'user',
              message: { content: 'raw and deep stays raw' },
            },
          ],
        },
      }),
    )

    const result = await runTrace(['replay', 'session-1', '--raw', '--deep'])

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('"type":"turn.start"')
    expect(result.stdout).toContain('raw and deep stays raw')
    expect(result.stdout).not.toContain('Trace Replay - Learn')
    expect(result.stdout).not.toContain('Trace Replay - Deep')
    expect(result.stdout).not.toContain('[USER')
  })

  test('raw replay ignores language renderer', async () => {
    appendTraceEvent(
      makeTraceEvent({
        type: 'turn.start',
        payload: {
          messages: [
            {
              type: 'user',
              message: { content: 'raw prompt' },
            },
          ],
        },
      }),
    )

    const result = await runTrace([
      'replay',
      'session-1',
      '--raw',
      '--lang',
      'en',
    ])

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('"type":"turn.start"')
    expect(result.stdout).not.toContain('Language: en')
    expect(result.stdout).not.toContain('[USER / User Input]')
  })

  test('tail orients to the latest main turn then streams newly appended Learn events', async () => {
    saveTraceConfig({ mode: 'learn', autoTailWindow: true })
    appendTraceEvent(
      makeTraceEvent({
        eventId: 'event-old-turn',
        sequence: 1,
        type: 'turn.start',
        source: 'query',
        payload: {
          querySource: 'repl_main_thread',
          messages: [
            {
              type: 'user',
              message: { content: 'old turn should not orient' },
            },
          ],
        },
      }),
    )
    appendTraceEvent(
      makeTraceEvent({
        eventId: 'event-latest-turn',
        sequence: 2,
        type: 'turn.start',
        source: 'query',
        payload: {
          querySource: 'repl_main_thread',
          messages: [
            {
              type: 'user',
              message: { content: 'latest turn should orient' },
            },
          ],
        },
      }),
    )

    const tailPromise = runTrace(['tail', 'session-1'], {
      follow: true,
      pollIntervalMs: 10,
      idleTimeoutMs: 500,
    })
    await delay(50)
    appendTraceEvent(
      makeTraceEvent({
        eventId: 'event-new-tool',
        sequence: 3,
        type: 'tool.started',
        source: 'tool',
        payload: {
          toolName: 'Read',
          toolUseId: 'toolu_1',
          toolInput: { file_path: 'README.md' },
        },
      }),
    )

    const result = await tailPromise
    const raw = await runTrace(['tail', 'session-1', '--raw'], {
      follow: true,
      pollIntervalMs: 10,
      idleTimeoutMs: 50,
    })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('Trace Live - Learn')
    expect(result.stdout).toContain('latest turn should orient')
    expect(result.stdout).toContain('Read started')
    expect(result.stdout).not.toContain('old turn should not orient')
    expect(result.stdout).not.toContain('\x1b[2J\x1b[H')
    expect(result.stdout).not.toContain('Agent Loop Live')
    expect(result.stdout).not.toContain('"type":"turn.start"')
    expect(raw.stdout).not.toContain('latest turn should orient')
  })

  test('tail supports English-only labels', async () => {
    saveTraceConfig({ mode: 'learn', autoTailWindow: true })
    appendTraceEvent(
      makeTraceEvent({
        type: 'turn.start',
        source: 'query',
        payload: {
          querySource: 'repl_main_thread',
          messages: [
            {
              type: 'user',
              message: { content: 'tail language prompt' },
            },
          ],
        },
      }),
    )

    const result = await runTrace(['tail', 'session-1', '--lang', 'en'], {
      follow: true,
      pollIntervalMs: 10,
      idleTimeoutMs: 50,
    })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('Language: en')
    expect(result.stdout).toContain('[USER / User Input] tail language prompt')
    expect(result.stdout).not.toContain('用户输入')
  })

  test('raw tail ignores language renderer and prints exact JSONL', async () => {
    saveTraceConfig({ mode: 'learn', autoTailWindow: true })
    const line = JSON.stringify(
      makeTraceEvent({
        type: 'turn.start',
        source: 'query',
        payload: {
          messages: [
            {
              type: 'user',
              message: { content: 'raw tail language prompt' },
            },
          ],
        },
      }),
    )
    const eventsPath = getTraceEventsPath('session-1')
    await mkdir(dirname(eventsPath), { recursive: true })
    await writeFile(eventsPath, line)

    const result = await runTrace([
      'tail',
      'session-1',
      '--raw',
      '--lang',
      'en',
    ])

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout).toBe(`${line}\n`)
    expect(result.stdout).not.toContain('Language: en')
    expect(result.stdout).not.toContain('[USER / User Input]')
    expect(result.stdout).not.toContain('Trace Live - Learn')
  })

  test.each([
    [
      'unsupported value',
      ['tail', 'session-1', '--lang', 'jp'],
      'Invalid trace language: jp',
    ],
    [
      'missing value',
      ['tail', 'session-1', '--lang'],
      'Invalid trace language: <missing>',
    ],
  ])('tail rejects %s for trace language', async (_, args, message) => {
    const result = await runTrace(args)

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain(message)
  })

  test('tail orientation slices from the latest main turn and keeps only later side turns', async () => {
    saveTraceConfig({ mode: 'learn', autoTailWindow: true })
    appendTraceEvent(
      makeTraceEvent({
        eventId: 'event-old-main-turn',
        sequence: 1,
        type: 'turn.start',
        source: 'query',
        payload: {
          querySource: 'repl_main_thread',
          messages: [
            {
              type: 'user',
              message: { content: 'old main should not orient' },
            },
          ],
        },
      }),
    )
    appendTraceEvent(
      makeTraceEvent({
        eventId: 'event-old-side-turn',
        sequence: 2,
        type: 'turn.start',
        source: 'query',
        payload: {
          querySource: 'old_side_after_old_main',
          messages: [
            {
              type: 'user',
              message: { content: 'old side should not orient' },
            },
          ],
        },
      }),
    )
    appendTraceEvent(
      makeTraceEvent({
        eventId: 'event-latest-main-turn',
        sequence: 3,
        type: 'turn.start',
        source: 'query',
        payload: {
          querySource: 'repl_main_thread',
          messages: [
            {
              type: 'user',
              message: { content: 'latest main should orient with side' },
            },
          ],
        },
      }),
    )
    appendTraceEvent(
      makeTraceEvent({
        eventId: 'event-latest-side-turn',
        sequence: 4,
        type: 'turn.start',
        source: 'query',
        payload: {
          querySource: 'latest_side_after_latest_main',
          messages: [
            {
              type: 'user',
              message: { content: 'latest side may orient' },
            },
          ],
        },
      }),
    )

    const tailPromise = runTrace(['tail', 'session-1'], {
      follow: true,
      pollIntervalMs: 10,
      idleTimeoutMs: 500,
    })
    await delay(50)
    appendTraceEvent(
      makeTraceEvent({
        eventId: 'event-new-tool-after-orientation',
        sequence: 5,
        type: 'tool.started',
        source: 'tool',
        payload: {
          toolName: 'Read',
          toolUseId: 'toolu_after_orientation',
          toolInput: { file_path: 'fresh.md' },
        },
      }),
    )

    const result = await tailPromise

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('latest main should orient with side')
    expect(result.stdout).toContain('latest_side_after_latest_main collapsed')
    expect(result.stdout).toContain('Read started')
    expect(result.stdout).not.toContain('old main should not orient')
    expect(result.stdout).not.toContain('old_side_after_old_main')
    expect(result.stdout).not.toContain('old side should not orient')
  })

  test('tail orientation uses the captured EOF snapshot and streams post-offset events once', async () => {
    saveTraceConfig({ mode: 'learn', autoTailWindow: true })
    appendTraceEvent(
      makeTraceEvent({
        eventId: 'event-snapshot-main-turn',
        sequence: 1,
        type: 'turn.start',
        source: 'query',
        payload: {
          querySource: 'repl_main_thread',
          messages: [
            {
              type: 'user',
              message: { content: 'snapshot latest turn should orient' },
            },
          ],
        },
      }),
    )

    let appendedAfterOffset = false
    const result = await runTrace(
      ['tail', 'session-1'],
      {
        follow: true,
        pollIntervalMs: 10,
        idleTimeoutMs: 200,
      },
      {
        onStdoutWrite(chunk) {
          if (appendedAfterOffset || !chunk.includes('Trace Live - Learn')) {
            return
          }

          appendedAfterOffset = true
          appendTraceEvent(
            makeTraceEvent({
              eventId: 'event-post-offset-main-turn',
              sequence: 2,
              type: 'turn.start',
              source: 'query',
              payload: {
                querySource: 'repl_main_thread',
                messages: [
                  {
                    type: 'user',
                    message: {
                      content: 'post-offset turn must stream once only',
                    },
                  },
                ],
              },
            }),
          )
        },
      },
    )

    expect(appendedAfterOffset).toBe(true)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('snapshot latest turn should orient')
    expect(
      countMatchingLines(
        result.stdout,
        '[TURN',
        'post-offset turn must stream once only',
      ),
    ).toBe(1)
  })

  test('tail --deep streams Deep events', async () => {
    saveTraceConfig({ mode: 'full', autoTailWindow: true })
    appendTraceEvent(
      makeTraceEvent({
        type: 'api.request_built',
        source: 'api',
        payload: {
          querySource: 'repl_main_thread',
          provider: 'firstParty',
          model: 'old-model-should-not-print',
          messageCount: 1,
          toolCount: 1,
        },
      }),
    )

    const tailPromise = runTrace(['tail', 'session-1', '--deep'], {
      follow: true,
      pollIntervalMs: 10,
      idleTimeoutMs: 500,
    })
    await delay(50)
    appendTraceEvent(
      makeTraceEvent({
        eventId: 'event-2',
        sequence: 2,
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
    expect(result.stdout).toContain(
      'REQUEST #1 provider=firstParty model=deepseek-v4-pro',
    )
    expect(result.stdout).not.toContain('old-model-should-not-print')
  })

  test('tail --raw keeps streaming raw JSONL display', async () => {
    saveTraceConfig({ mode: 'learn', autoTailWindow: true })
    appendTraceEvent(
      makeTraceEvent({
        type: 'turn.start',
        source: 'query',
        payload: {
          messages: [
            {
              type: 'user',
              message: { content: 'old raw prompt should not print' },
            },
          ],
        },
      }),
    )
    const manuallyFormattedLine =
      '  {"eventId":"manual-tail-event","sessionId":"session-1","sequence":3,"timestamp":"2026-06-16T14:03:12.000Z","mode":"learn","source":"api","type":"api.request_built","payload":{"model":"claude-tail-manual"}}  '
    const malformedLine = 'tail raw malformed line stays raw'

    const tailPromise = runTrace(['tail', 'session-1', '--raw'], {
      follow: true,
      pollIntervalMs: 10,
      idleTimeoutMs: 500,
    })
    await delay(50)
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
              message: { content: 'raw tail prompt' },
            },
          ],
        },
      }),
    )
    await appendFile(
      getTraceEventsPath('session-1'),
      `${manuallyFormattedLine}\n${malformedLine}\n`,
    )

    const result = await tailPromise

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('"type":"turn.start"')
    expect(result.stdout).toContain('raw tail prompt')
    expect(result.stdout).not.toContain('old raw prompt should not print')
    expect(result.stdout.split('\n')).toContain(manuallyFormattedLine)
    expect(result.stdout.split('\n')).toContain(malformedLine)
    expect(result.stdout).not.toContain('trace.read_error')
    expect(result.stdout).not.toContain('Agent Loop Live')
    expect(result.stdout).not.toContain('Trace Live - Learn')
  })

  test('non-follow tail flushes a final record without trailing newline', async () => {
    saveTraceConfig({ mode: 'learn', autoTailWindow: true })
    const eventsPath = getTraceEventsPath('session-1')
    const line = JSON.stringify(
      makeTraceEvent({
        type: 'turn.start',
        source: 'query',
        payload: {
          messages: [
            {
              type: 'user',
              message: { content: 'unterminated tail prompt' },
            },
          ],
        },
      }),
    )
    await mkdir(dirname(eventsPath), { recursive: true })
    await writeFile(eventsPath, line)

    const raw = await runTrace(['tail', 'session-1', '--raw'])
    const semantic = await runTrace(['tail', 'session-1'])

    expect(raw.exitCode).toBe(0)
    expect(raw.stdout).toBe(`${line}\n`)
    expect(semantic.exitCode).toBe(0)
    expect(semantic.stdout).toContain('Trace Live - Learn')
    expect(semantic.stdout).toContain('unterminated tail prompt')
  })

  test('follow tail reads rewritten events after truncation', async () => {
    saveTraceConfig({ mode: 'learn', autoTailWindow: true })
    appendTraceEvent(
      makeTraceEvent({
        type: 'turn.start',
        source: 'query',
        payload: {
          querySource: 'background',
          messages: [
            {
              type: 'user',
              message: {
                content: `old prompt should not print ${'padding '.repeat(80)}`,
              },
            },
          ],
        },
      }),
    )

    const eventsPath = getTraceEventsPath('session-1')
    const tailPromise = runTrace(['tail', 'session-1'], {
      follow: true,
      pollIntervalMs: 10,
      idleTimeoutMs: 500,
    })
    await delay(50)
    await writeFile(
      eventsPath,
      `${JSON.stringify(
        makeTraceEvent({
          eventId: 'event-rewritten',
          sequence: 1,
          type: 'turn.start',
          source: 'query',
          payload: {
            messages: [
              {
                type: 'user',
                message: { content: 'rewritten prompt prints' },
              },
            ],
          },
        }),
      )}\n`,
    )

    const result = await tailPromise

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('Trace Live - Learn')
    expect(result.stdout).toContain('rewritten prompt prints')
    expect(result.stdout).not.toContain('old prompt should not print')
  })

  test('follow tail detects rewrite when new file is larger than previous EOF', async () => {
    saveTraceConfig({ mode: 'learn', autoTailWindow: true })
    appendTraceEvent(
      makeTraceEvent({
        type: 'turn.start',
        source: 'query',
        payload: {
          querySource: 'background',
          messages: [
            {
              type: 'user',
              message: { content: 'old small prompt should not print' },
            },
          ],
        },
      }),
    )

    const eventsPath = getTraceEventsPath('session-1')
    const tailPromise = runTrace(['tail', 'session-1'], {
      follow: true,
      pollIntervalMs: 10,
      idleTimeoutMs: 500,
    })
    await delay(50)
    await writeFile(
      eventsPath,
      `${JSON.stringify(
        makeTraceEvent({
          eventId: 'event-rewritten-larger',
          sequence: 1,
          type: 'turn.start',
          source: 'query',
          payload: {
            messages: [
              {
                type: 'user',
                message: {
                  content: `rewritten larger prompt prints ${'padding '.repeat(
                    120,
                  )}`,
                },
              },
            ],
          },
        }),
      )}\n`,
    )

    const result = await tailPromise

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('Trace Live - Learn')
    expect(result.stdout).toContain('rewritten larger prompt prints')
    expect(result.stdout).not.toContain('old small prompt should not print')
  })

  test('tail chunk reads report actual bytes read', async () => {
    const path = join(traceDir, 'chunk.txt')
    await writeFile(path, 'abcdef')

    expect(readTraceTailChunkForTesting(path, 4, 10)).toEqual({
      text: 'ef',
      bytesRead: 2,
    })
  })

  test('tail continuity marker rejects short reads', async () => {
    const path = join(traceDir, 'marker.txt')
    await writeFile(path, 'abc')

    expect(readTraceTailContinuityMarkerForTesting(path, 10)).toBeNull()
    expect(
      readTraceTailContinuityMarkerForTesting(path, 3)?.bytes.toString('utf8'),
    ).toBe('abc')
  })

  test('tail orientation snapshot is bounded and locates the latest main turn in the suffix', async () => {
    saveTraceConfig({ mode: 'learn', autoTailWindow: true })
    appendTraceEvent(
      makeTraceEvent({
        eventId: 'event-old-main-outside-window',
        sequence: 1,
        type: 'turn.start',
        source: 'query',
        payload: {
          querySource: 'repl_main_thread',
          messages: [
            {
              type: 'user',
              message: { content: 'old outside bounded window' },
            },
          ],
        },
      }),
    )

    for (let index = 0; index < 80; index += 1) {
      appendTraceEvent(
        makeTraceEvent({
          eventId: `event-padding-${index}`,
          sequence: index + 2,
          type: 'tool.result',
          source: 'tool',
          payload: {
            toolName: 'Read',
            status: 'ok',
            toolResultSizeBytes: 10,
            padding: 'x'.repeat(180),
          },
        }),
      )
    }

    appendTraceEvent(
      makeTraceEvent({
        eventId: 'event-latest-main-in-window',
        sequence: 100,
        type: 'turn.start',
        source: 'query',
        payload: {
          querySource: 'repl_main_thread',
          messages: [
            {
              type: 'user',
              message: { content: 'latest inside bounded window' },
            },
          ],
        },
      }),
    )

    const eventsPath = getTraceEventsPath('session-1')
    const fileSize = (await stat(eventsPath)).size
    const snapshot = readTraceTailOrientationRecordsForTesting(
      'session-1',
      eventsPath,
      fileSize,
      4096,
    )

    expect(fileSize).toBeGreaterThan(4096)
    expect(snapshot.bytesRead).toBeLessThan(fileSize)
    expect(snapshot.bytesRead).toBeLessThanOrEqual(4096)
    expect(
      snapshot.records.some(
        record => record.eventId === 'event-latest-main-in-window',
      ),
    ).toBe(true)
    expect(
      snapshot.records.some(
        record => record.eventId === 'event-old-main-outside-window',
      ),
    ).toBe(false)

    const result = await runTrace(['tail', 'session-1'], {
      follow: true,
      pollIntervalMs: 10,
      idleTimeoutMs: 50,
    })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('latest inside bounded window')
    expect(result.stdout).not.toContain('old outside bounded window')
  })

  test('tail orientation keeps a full record when the bounded window starts on a line boundary', async () => {
    const oldMain = JSON.stringify(
      makeTraceEvent({
        eventId: 'event-old-main-before-window',
        sequence: 1,
        type: 'turn.start',
        source: 'query',
        payload: {
          querySource: 'repl_main_thread',
          messages: [
            {
              type: 'user',
              message: { content: 'old main before line boundary' },
            },
          ],
        },
      }),
    )
    const latestMain = JSON.stringify(
      makeTraceEvent({
        eventId: 'event-latest-main-at-window-start',
        sequence: 2,
        type: 'turn.start',
        source: 'query',
        payload: {
          querySource: 'repl_main_thread',
          messages: [
            {
              type: 'user',
              message: { content: 'latest main at window start' },
            },
          ],
        },
      }),
    )
    const firstLine = `${oldMain}\n`
    const secondLine = `${latestMain}\n`
    const eventsPath = getTraceEventsPath('session-1')

    await mkdir(dirname(eventsPath), { recursive: true })
    await writeFile(eventsPath, `${firstLine}${secondLine}`)

    const snapshot = readTraceTailOrientationRecordsForTesting(
      'session-1',
      eventsPath,
      Buffer.byteLength(firstLine) + Buffer.byteLength(secondLine),
      Buffer.byteLength(secondLine),
    )

    expect(snapshot.bytesRead).toBe(Buffer.byteLength(secondLine))
    expect(snapshot.records.map(record => record.eventId)).toEqual([
      'event-latest-main-at-window-start',
    ])
  })

  test('inspect prints a JSON summary with counts by type and source', async () => {
    appendTraceEvent(makeTraceEvent({ type: 'turn.start', source: 'repl' }))
    appendTraceEvent(
      makeTraceEvent({
        eventId: 'event-2',
        sequence: 2,
        type: 'tool.started',
        source: 'tool',
      }),
    )

    const result = await runTrace(['inspect', 'session-1'])
    const summary = JSON.parse(result.stdout)

    expect(result.exitCode).toBe(0)
    expect(summary).toMatchObject({
      sessionId: 'session-1',
      eventCount: 2,
      countsByType: {
        'turn.start': 1,
        'tool.started': 1,
      },
      countsBySource: {
        repl: 1,
        tool: 1,
      },
    })
  })

  test('tail reports a clear fallback when no active events file exists', async () => {
    const result = await runTrace(['tail'], { follow: false })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('No active trace session.')
  })
})

async function runTrace(
  args: string[],
  tail: {
    follow?: boolean
    pollIntervalMs?: number
    idleTimeoutMs?: number
    startAtEnd?: boolean
  } = { follow: false, startAtEnd: false },
  hooks: {
    onStdoutWrite?: (chunk: string) => void
    stdoutIsTTY?: boolean
  } = {},
): Promise<{
  exitCode: number
  stdout: string
  stderr: string
}> {
  let stdout = ''
  let stderr = ''

  const exitCode = await traceMain(args, {
    stdout: {
      isTTY: hooks.stdoutIsTTY,
      write(chunk) {
        const text = String(chunk)
        stdout += text
        hooks.onStdoutWrite?.(text)
        return true
      },
    },
    stderr: {
      write(chunk) {
        stderr += String(chunk)
        return true
      },
    },
    tail,
  })

  return {
    exitCode,
    stdout,
    stderr,
  }
}

function countMatchingLines(
  text: string,
  firstNeedle: string,
  secondNeedle: string,
): number {
  return text
    .split(/\r?\n/)
    .filter(line => line.includes(firstNeedle) && line.includes(secondNeedle))
    .length
}

function makeTraceEvent(overrides: Partial<TraceEvent> = {}): TraceEvent {
  return {
    eventId: 'event-1',
    sessionId: 'session-1',
    sequence: 1,
    timestamp: '2026-06-16T14:03:10.000Z',
    mode: 'learn',
    source: 'repl',
    type: 'trace.session_start',
    payload: {},
    ...overrides,
  }
}
