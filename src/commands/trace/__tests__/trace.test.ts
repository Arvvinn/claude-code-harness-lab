import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  emitTrace,
  flushTraceForTesting,
  getActiveTraceSessionForProcess,
  resetTraceForTesting,
} from '../../../trace/bus.js'
import { loadTraceConfig } from '../../../trace/config.js'
import {
  TRACE_TAIL_DEEP_COMMAND,
  resetTraceTailWindowForTesting,
  setTraceTailWindowSpawnForTesting,
} from '../../../trace/liveWindow.js'
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
    resetTraceTailWindowForTesting()
    setTraceTailWindowSpawnForTesting(async () => ({ ok: true }))
  })

  afterEach(async () => {
    await flushTraceForTesting()
    resetTraceForTesting()
    resetTraceTailWindowForTesting()

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
      type: 'display',
      value: expect.stringContaining('Mode: learn'),
    })
    expect(second).toEqual({
      type: 'display',
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
      type: 'display',
      value: expect.stringContaining('Mode: off'),
    })
    expect(result).toEqual({
      type: 'display',
      value: expect.stringContaining('Session: none'),
    })
    expect(result).toEqual({
      type: 'display',
      value: expect.stringContaining('Tail: claude trace tail'),
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
      type: 'display',
      value: expect.stringContaining('Session: none'),
    })
    expect(result).toEqual({
      type: 'display',
      value: expect.stringContaining('Events: none'),
    })
  })

  test('full updates an active learn session without restarting it', async () => {
    const { call } = await import('../trace.js')

    await call('learn', makeContext())
    await flushTraceForTesting()
    const before = getActiveTraceSessionForProcess()
    expect(before).toMatchObject({ mode: 'learn' })

    await call('full', makeContext())
    const after = getActiveTraceSessionForProcess()
    expect(after).toMatchObject({
      sessionId: before?.sessionId,
      mode: 'full',
    })
    expect(after?.eventsPath).toBe(before?.eventsPath)

    const fullOnlyText = 'x'.repeat(600)
    emitTrace({
      source: 'api',
      type: 'api.request_built',
      payload: { fullOnlyText },
    })
    await flushTraceForTesting()

    const events = readTraceEvents(before!.sessionId)
    expect(events.map(event => event.type)).toEqual([
      'trace.session_start',
      'api.request_built',
    ])
    expect(events.map(event => event.sequence)).toEqual([1, 2])
    expect(events[1]).toMatchObject({
      mode: 'full',
      payload: { fullOnlyText },
    })
  })

  test('full reports the deep tail command', async () => {
    const { call } = await import('../trace.js')

    const result = await call('full', makeContext())
    await flushTraceForTesting()

    expect(result).toEqual({
      type: 'display',
      value: expect.stringContaining('Tail: claude trace tail --deep'),
    })
  })

  test('full launches a deep tail after learn launched a shallow tail', async () => {
    const { call } = await import('../trace.js')
    const calls: Array<{ executable: string; args: string[] }> = []
    setTraceTailWindowSpawnForTesting(async (executable, args) => {
      calls.push({ executable, args })
      return { ok: true }
    })

    await call('learn', makeContext())
    const result = await call('full', makeContext())
    await flushTraceForTesting()

    expect(result).toEqual({
      type: 'display',
      value: expect.stringContaining('Tail: claude trace tail --deep'),
    })
    expect(calls).toHaveLength(2)
    expect(calls[1]?.args.join(' ')).toContain(TRACE_TAIL_DEEP_COMMAND)
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
      type: 'display',
      value: expect.stringContaining('claude trace tail'),
    })
    expect(result).toEqual({
      type: 'display',
      value: expect.stringContaining('claude trace tail --deep'),
    })
    expect(readActiveTraceSession()).toBeNull()
  })

  test('learn prints the manual fallback when auto tail launch fails', async () => {
    const { call } = await import('../trace.js')
    setTraceTailWindowSpawnForTesting(async () => ({
      ok: false,
      error: new Error('no terminal available'),
    }))

    const result = await call('learn', makeContext())
    await flushTraceForTesting()

    expect(result).toEqual({
      type: 'display',
      value: expect.stringContaining(
        'Tail window: auto-launch unavailable: launch_failed',
      ),
    })
    expect(result).toEqual({
      type: 'display',
      value: expect.stringContaining('claude trace tail'),
    })
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
