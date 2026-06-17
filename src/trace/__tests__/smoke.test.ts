import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { traceMain } from '../cli.js'
import { loadTraceConfig, resetTraceConfigCacheForTesting } from '../config.js'
import { formatTraceRecord } from '../format.js'
import { appendTraceEvent, readTraceEvents } from '../store.js'
import type { TraceEvent } from '../types.js'

const originalTraceDir = process.env.CLAUDE_CODE_TRACE_DIR
let traceDir: string

describe('harness trace smoke coverage', () => {
  beforeEach(async () => {
    traceDir = await mkdtemp(join(tmpdir(), 'claude-trace-smoke-'))
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

  test('config persists off to learn to full to off through CLI mode commands', async () => {
    useSmokeTraceDir()
    expect(loadTraceConfig().mode).toBe('off')

    expect((await runTrace(['learn'])).exitCode).toBe(0)
    useSmokeTraceDir()
    expect(loadTraceConfig().mode).toBe('learn')

    expect((await runTrace(['full'])).exitCode).toBe(0)
    useSmokeTraceDir()
    expect(loadTraceConfig().mode).toBe('full')

    expect((await runTrace(['off'])).exitCode).toBe(0)
    useSmokeTraceDir()
    expect(loadTraceConfig().mode).toBe('off')
  })

  test('status works with an empty trace directory', async () => {
    useSmokeTraceDir()
    const result = await runTrace(['status'])

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout).toContain('Trace status')
    expect(result.stdout).toContain('Mode: off')
    expect(result.stdout).toContain(`Trace dir: ${traceDir}`)
    expect(result.stdout).toContain('Active session: none')
  })

  test('store replays a synthetic session with turn, api, tool, and subagent events', async () => {
    useSmokeTraceDir()
    const events = [
      makeTraceEvent({
        eventId: 'event-turn',
        sequence: 1,
        source: 'repl',
        type: 'turn.start',
        payload: {
          inputChars: 12,
          messages: [
            {
              type: 'user',
              message: { content: 'summarize trace smoke' },
            },
          ],
        },
      }),
      makeTraceEvent({
        eventId: 'event-api',
        sequence: 2,
        source: 'api',
        type: 'api.request_built',
        payload: { model: 'claude-sonnet', messageCount: 2 },
      }),
      makeTraceEvent({
        eventId: 'event-tool',
        sequence: 3,
        source: 'tool',
        type: 'tool.result',
        payload: { toolName: 'Read', ok: true },
      }),
      makeTraceEvent({
        eventId: 'event-subagent',
        sequence: 4,
        source: 'subagent',
        type: 'subagent.ended',
        payload: { status: 'completed' },
      }),
    ]

    for (const event of events) {
      appendTraceEvent(event)
    }

    expect(readTraceEvents('session-1').map(event => event.type)).toEqual([
      'turn.start',
      'api.request_built',
      'tool.result',
      'subagent.ended',
    ])

    const result = await runTrace(['replay', 'session-1'])

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('Agent Loop Replay')
    expect(result.stdout).toContain('Pattern: User -> messages[] -> LLM')
    expect(result.stdout).toContain('[USER]')
    expect(result.stdout).toContain('summarize trace smoke')
    expect(result.stdout).toContain('[LLM]')
    expect(result.stdout).toContain('claude-sonnet')
    expect(result.stdout).toContain('"messageCount": 2')
    expect(result.stdout).toContain('[TOOL]')
    expect(result.stdout).toContain('Read')
    expect(result.stdout).toContain('[SUBAGENT]')
    expect(result.stdout).toContain('completed')
    expect(result.stdout).not.toContain('turn.start inputChars=12')

    const rawResult = await runTrace(['replay', 'session-1', '--raw'])

    expect(rawResult.exitCode).toBe(0)
    expect(rawResult.stdout).toContain('"type":"turn.start"')
    expect(rawResult.stdout).toContain('"inputChars":12')
    expect(rawResult.stdout).toContain('"type":"api.request_built"')
    expect(rawResult.stdout).toContain('"type":"tool.result"')
    expect(rawResult.stdout).toContain('"type":"subagent.ended"')
    expect(rawResult.stdout).not.toContain('Agent Loop Replay')
  })

  test('learn formatter hides raw prompt text when summary is present', () => {
    const line = formatTraceRecord(
      makeTraceEvent({
        type: 'turn.start',
        payload: {
          prompt: 'raw prompt text that must not be printed',
          promptSummary: 'user asked for trace smoke tests',
          rawPrompt: 'second raw prompt field',
        },
      }),
      'learn',
    )

    expect(line).toContain('promptSummary="user asked for trace smoke tests"')
    expect(line).not.toContain('raw prompt text')
    expect(line).not.toContain('second raw prompt field')
  })

  test('full formatter prints compact JSON with redacted secret fields', () => {
    const line = formatTraceRecord(
      makeTraceEvent({
        type: 'api.request_built',
        payload: {
          model: 'claude-sonnet',
          nested: {
            token: 'secret-token',
            Authorization: 'Bearer nested-secret',
          },
        },
      }),
      'full',
    )

    expect(line).not.toContain('\n')
    expect(line).not.toContain('secret-token')
    expect(line).not.toContain('nested-secret')
    expect(JSON.parse(line)).toMatchObject({
      type: 'api.request_built',
      payload: {
        model: 'claude-sonnet',
        nested: {
          token: '[REDACTED]',
          Authorization: '[REDACTED]',
        },
      },
    })
  })
})

async function runTrace(args: string[]): Promise<{
  exitCode: number
  stdout: string
  stderr: string
}> {
  useSmokeTraceDir()
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
    tail: { follow: false },
  })

  return {
    exitCode,
    stdout,
    stderr,
  }
}

function useSmokeTraceDir(): void {
  process.env.CLAUDE_CODE_TRACE_DIR = traceDir
  resetTraceConfigCacheForTesting()
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
