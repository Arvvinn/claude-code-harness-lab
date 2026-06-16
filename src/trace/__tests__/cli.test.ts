import { mkdir, mkdtemp, rm } from 'node:fs/promises'
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

  test('replay prints formatted event streams using the current display mode', async () => {
    saveTraceConfig({ mode: 'learn', autoTailWindow: true })
    appendTraceEvent(
      makeTraceEvent({
        type: 'turn.start',
        payload: {
          inputChars: 41,
          rawPrompt: 'hidden raw prompt',
        },
      }),
    )

    const result = await runTrace(['replay', 'session-1'])

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('14:03:10 turn.start inputChars=41')
    expect(result.stdout).not.toContain('hidden raw prompt')
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
