import { appendFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { traceMain } from '../cli.js'
import { loadTraceConfig, saveTraceConfig } from '../config.js'
import { getTraceEventsPath, getTraceRootDir } from '../paths.js'
import {
  appendTraceEvent,
  readActiveTraceSession,
  writeActiveTraceSession,
} from '../store.js'
import type { TraceEvent } from '../types.js'

const originalTraceDir = process.env.CLAUDE_CODE_TRACE_DIR
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

  test('replay prints an agent loop panel by default', async () => {
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
    expect(result.stdout).toContain('Agent Loop Replay')
    expect(result.stdout).toContain(
      'User -> messages[] -> LLM -> stop_reason/tool_use decision -> tools -> append results -> loop back/return text',
    )
    expect(result.stdout).toContain('[USER]')
    expect(result.stdout).toContain('explain the project')
    expect(result.stdout).toContain('[SYSTEM]')
    expect(result.stdout).toContain('systemPrompt: collapsed 1 block')
    expect(result.stdout).not.toContain('system prompt body')
    expect(result.stdout).toContain('[LLM]')
    expect(result.stdout).toContain('claude-test')
    expect(result.stdout).not.toContain('rawRequestParams')
    expect(result.stdout).not.toContain(
      'raw system prompt should stay out of panel',
    )
    expect(result.stdout).not.toContain(
      'raw request message should stay out of panel',
    )
    expect(result.stdout).toContain('[TOOL]')
    expect(result.stdout).toContain('Read')
    expect(result.stdout).not.toContain('14:03:10 turn.start')
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
    expect(panel.stdout).toContain('read README.md')
    expect(panel.stdout).toContain('attachments/hooks=2 collapsed')
    expect(panel.stdout).toContain('systemPrompt: collapsed 1 block')
    expect(panel.stdout).toContain('input=collapsed')
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

  test('tail prints a refreshing agent loop panel by default', async () => {
    saveTraceConfig({ mode: 'learn', autoTailWindow: true })
    appendTraceEvent(
      makeTraceEvent({
        type: 'turn.start',
        source: 'query',
        payload: {
          messages: [
            {
              type: 'user',
              message: { content: 'tail the live agent loop' },
            },
          ],
        },
      }),
    )

    const result = await runTrace(['tail', 'session-1'])

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('Agent Loop Live')
    expect(result.stdout).toContain('[USER]')
    expect(result.stdout).toContain('tail the live agent loop')
    expect(result.stdout).toContain(
      'User -> messages[] -> LLM -> stop_reason/tool_use decision -> tools -> append results -> loop back/return text',
    )
    expect(result.stdout).not.toContain('"type":"turn.start"')
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
              message: { content: 'raw tail prompt' },
            },
          ],
        },
      }),
    )
    const manuallyFormattedLine =
      '  {"eventId":"manual-tail-event","sessionId":"session-1","sequence":2,"timestamp":"2026-06-16T14:03:11.000Z","mode":"learn","source":"api","type":"api.request_built","payload":{"model":"claude-tail-manual"}}  '
    const malformedLine = 'tail raw malformed line stays raw'
    await appendFile(
      getTraceEventsPath('session-1'),
      `${manuallyFormattedLine}\n${malformedLine}\n`,
    )

    const result = await runTrace(['tail', 'session-1', '--raw'])

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('"type":"turn.start"')
    expect(result.stdout).toContain('raw tail prompt')
    expect(result.stdout.split('\n')).toContain(manuallyFormattedLine)
    expect(result.stdout.split('\n')).toContain(malformedLine)
    expect(result.stdout).not.toContain('trace.read_error')
    expect(result.stdout).not.toContain('Agent Loop Live')
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
  tail: { follow: boolean } = { follow: false },
): Promise<{
  exitCode: number
  stdout: string
  stderr: string
}> {
  let stdout = ''
  let stderr = ''

  const exitCode = await traceMain(args, {
    stdout: {
      write(chunk) {
        stdout += String(chunk)
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
