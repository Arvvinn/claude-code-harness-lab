import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  flushTraceForTesting,
  resetTraceForTesting,
} from '../../../trace/bus.js'
import { loadTraceConfig } from '../../../trace/config.js'
import { getTraceEventsPath } from '../../../trace/paths.js'
import {
  readActiveTraceSession,
  readTraceEvents,
  writeActiveTraceSession,
} from '../../../trace/store.js'

const originalTraceDir = process.env.CLAUDE_CODE_TRACE_DIR
let traceDir: string

describe('/trace command', () => {
  beforeEach(async () => {
    traceDir = await mkdtemp(join(tmpdir(), 'claude-trace-command-'))
    process.env.CLAUDE_CODE_TRACE_DIR = traceDir
    resetTraceForTesting()
  })

  afterEach(async () => {
    await flushTraceForTesting()
    resetTraceForTesting()

    if (originalTraceDir === undefined) {
      delete process.env.CLAUDE_CODE_TRACE_DIR
    } else {
      process.env.CLAUDE_CODE_TRACE_DIR = originalTraceDir
    }

    await rm(traceDir, { recursive: true, force: true })
  })

  test('learn persists mode and starts one trace session for the process', async () => {
    const { call } = await import('../trace.js')

    const first = await call('learn', makeContext())
    const second = await call('learn', makeContext())
    await flushTraceForTesting()

    expect(loadTraceConfig()).toEqual({
      mode: 'learn',
      autoTailWindow: true,
    })
    expect(first).toEqual({
      type: 'text',
      value: expect.stringContaining('Mode: learn'),
    })
    expect(second).toEqual({
      type: 'text',
      value: expect.stringContaining('Mode: learn'),
    })
    const sessionId = readActiveTraceSession()?.sessionId
    expect(sessionId).toBeDefined()
    expect(readTraceEvents(sessionId!)).toHaveLength(1)
    expect(readTraceEvents(sessionId!)[0].type).toBe('trace.session_start')
  })

  test('off persists off, ends live tracing, and hides stale active status', async () => {
    const { call } = await import('../trace.js')

    await call('learn', makeContext())
    await flushTraceForTesting()
    const sessionId = readActiveTraceSession()?.sessionId
    expect(sessionId).toBeDefined()
    const result = await call('off', makeContext())
    await flushTraceForTesting()

    expect(loadTraceConfig().mode).toBe('off')
    expect(result).toEqual({
      type: 'text',
      value: expect.stringContaining('Mode: off'),
    })
    expect(result).toEqual({
      type: 'text',
      value: expect.stringContaining('Session: none'),
    })
    expect(readTraceEvents(sessionId!).map(event => event.type)).toEqual([
      'trace.session_start',
      'trace.session_end',
    ])
    expect(readActiveTraceSession()).toBeNull()
  })

  test('off clears a stale active pointer without in-process trace state', async () => {
    const { call } = await import('../trace.js')

    writeActiveTraceSession({
      sessionId: 'stale-session',
      eventsPath: getTraceEventsPath('stale-session'),
      startedAt: '2026-06-16T00:00:00.000Z',
    })

    const result = await call('off', makeContext())
    await flushTraceForTesting()

    expect(readActiveTraceSession()).toBeNull()
    expect(result).toEqual({
      type: 'text',
      value: expect.stringContaining('Session: none'),
    })
    expect(result).toEqual({
      type: 'text',
      value: expect.stringContaining('Events: none'),
    })
  })

  test('learn after off uses monotonic sequence in the same process', async () => {
    const { call } = await import('../trace.js')

    await call('learn', makeContext())
    await flushTraceForTesting()
    const sessionId = readActiveTraceSession()?.sessionId
    expect(sessionId).toBeDefined()

    await call('off', makeContext())
    await flushTraceForTesting()
    await call('learn', makeContext())
    await flushTraceForTesting()

    const events = readTraceEvents(sessionId!)
    expect(events.map(event => event.type)).toEqual([
      'trace.session_start',
      'trace.session_end',
      'trace.session_start',
    ])
    expect(events.map(event => event.sequence)).toEqual([1, 2, 3])
  })

  test('tail prints the external command without starting tracing', async () => {
    const { call } = await import('../trace.js')

    const result = await call('tail', makeContext())
    await flushTraceForTesting()

    expect(result).toEqual({
      type: 'text',
      value: expect.stringContaining('claude trace tail'),
    })
    expect(readActiveTraceSession()).toBeNull()
  })
})

function makeContext() {
  return {
    options: { commands: [], debug: false, verbose: false },
    abortController: new AbortController(),
    messages: [],
    setAppState: () => {},
    getAppState: () => ({}),
    setMessages: () => {},
  } as never
}
