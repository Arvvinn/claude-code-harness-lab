import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import {
  flushTraceForTesting,
  resetTraceForTesting,
} from '../../../trace/bus.js'
import { loadTraceConfig } from '../../../trace/config.js'
import { getTraceEventsPath } from '../../../trace/paths.js'
import { readTraceEvents } from '../../../trace/store.js'

mock.module('../../../bootstrap/state.js', () => ({
  getSessionId: () => 'trace-command-session',
}))

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
    expect(readTraceEvents('trace-command-session')).toHaveLength(1)
    expect(readTraceEvents('trace-command-session')[0].type).toBe(
      'trace.session_start',
    )
  })

  test('off persists off and ends live tracing for the process', async () => {
    const { call } = await import('../trace.js')

    await call('learn', makeContext())
    await flushTraceForTesting()
    const result = await call('off', makeContext())
    await flushTraceForTesting()

    expect(loadTraceConfig().mode).toBe('off')
    expect(result).toEqual({
      type: 'text',
      value: expect.stringContaining('Mode: off'),
    })
    expect(
      readTraceEvents('trace-command-session').map(event => event.type),
    ).toEqual(['trace.session_start', 'trace.session_end'])
  })

  test('tail prints the external command without starting tracing', async () => {
    const { call } = await import('../trace.js')

    const result = await call('tail', makeContext())
    await flushTraceForTesting()

    expect(result).toEqual({
      type: 'text',
      value: expect.stringContaining('claude trace tail'),
    })
    expect(() => readTraceEvents('trace-command-session')).not.toThrow()
    expect(readTraceEvents('trace-command-session')).toEqual([])
    expect(getTraceEventsPath('trace-command-session')).toContain(traceDir)
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
