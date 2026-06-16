import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  emitTrace,
  endTraceSession,
  flushTraceForTesting,
  getTraceMode,
  resetTraceForTesting,
  startTraceSession,
} from '../bus.js'
import {
  getTraceConfigPath,
  getTraceEventsPath,
  getTraceRootDir,
} from '../paths.js'
import { readActiveTraceSession, readTraceEvents } from '../store.js'
import type { TraceConfig } from '../types.js'

const originalTraceDir = process.env.CLAUDE_CODE_TRACE_DIR
let traceDir: string

describe('TraceBus', () => {
  beforeEach(async () => {
    traceDir = await mkdtemp(join(tmpdir(), 'claude-trace-bus-'))
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

  test('off mode creates no trace files', async () => {
    expect(getTraceMode()).toBe('off')

    startTraceSession({
      sessionId: 'session-off',
      cwd: 'C:\\workspace',
      argv: ['ccb', '-p'],
    })
    emitTrace({
      source: 'query',
      type: 'query.loop_start',
      payload: { token: 'secret-token' },
    })

    await flushTraceForTesting()

    expect(await readdir(getTraceRootDir())).toEqual([])
  })

  test('learn mode writes session start and emitted events in order', async () => {
    await writeTraceConfig({ mode: 'learn', autoTailWindow: true })

    startTraceSession({
      sessionId: 'session-learn',
      cwd: 'C:\\workspace',
      argv: ['ccb', '-p'],
    })
    emitTrace({
      parentId: 'parent-1',
      turnId: 'turn-1',
      source: 'query',
      type: 'query.loop_start',
      payload: { step: 1 },
    })

    await flushTraceForTesting()

    expect(readActiveTraceSession()).toEqual({
      sessionId: 'session-learn',
      eventsPath: getTraceEventsPath('session-learn'),
      startedAt: expect.any(String),
    })

    const events = readTraceEvents('session-learn')
    expect(events).toHaveLength(2)
    expect(events.map(event => event.type)).toEqual([
      'trace.session_start',
      'query.loop_start',
    ])
    expect(events.map(event => event.sequence)).toEqual([1, 2])
    expect(events[0]).toMatchObject({
      sessionId: 'session-learn',
      mode: 'learn',
      source: 'repl',
      type: 'trace.session_start',
      payload: {
        cwd: 'C:\\workspace',
        argv: ['ccb', '-p'],
      },
    })
    expect(events[1]).toMatchObject({
      parentId: 'parent-1',
      turnId: 'turn-1',
      sessionId: 'session-learn',
      mode: 'learn',
      source: 'query',
      type: 'query.loop_start',
      payload: { step: 1 },
    })
  })

  test('redacts secret payload fields before writing', async () => {
    await writeTraceConfig({ mode: 'learn', autoTailWindow: true })

    startTraceSession({
      sessionId: 'session-redaction',
      cwd: 'C:\\workspace',
      argv: ['ccb'],
    })
    emitTrace({
      source: 'api',
      type: 'api.request_built',
      payload: {
        Authorization: 'Bearer abc123',
        nested: { apiKey: 'sk-test', visible: 'kept' },
      },
    })

    await flushTraceForTesting()

    const events = readTraceEvents('session-redaction')
    expect(events[1].payload).toEqual({
      Authorization: '[REDACTED]',
      nested: { apiKey: '[REDACTED]', visible: 'kept' },
    })
  })

  test('endTraceSession writes a session end event before clearing state', async () => {
    await writeTraceConfig({ mode: 'learn', autoTailWindow: true })

    startTraceSession({
      sessionId: 'session-end',
      cwd: 'C:\\workspace',
      argv: ['ccb'],
    })
    endTraceSession({ reason: 'complete' })
    emitTrace({
      source: 'query',
      type: 'query.loop_start',
      payload: { step: 'after-end' },
    })

    await flushTraceForTesting()

    const events = readTraceEvents('session-end')
    expect(events.map(event => event.type)).toEqual([
      'trace.session_start',
      'trace.session_end',
    ])
    expect(events[1].payload).toEqual({ reason: 'complete' })
  })

  test('write failures disable tracing for the current process', async () => {
    await writeTraceConfig({ mode: 'learn', autoTailWindow: true })
    await writeFile(join(traceDir, 'session-fail'), 'not a directory')

    expect(() =>
      startTraceSession({
        sessionId: 'session-fail',
        cwd: 'C:\\workspace',
        argv: ['ccb'],
      }),
    ).not.toThrow()
    await expect(flushTraceForTesting()).resolves.toBeUndefined()

    expect(existsSync(getTraceEventsPath('session-fail'))).toBe(false)

    startTraceSession({
      sessionId: 'session-after-failure',
      cwd: 'C:\\workspace',
      argv: ['ccb'],
    })
    emitTrace({
      source: 'query',
      type: 'query.loop_start',
      payload: { step: 2 },
    })
    await flushTraceForTesting()

    expect(existsSync(getTraceEventsPath('session-after-failure'))).toBe(false)
    expect(readActiveTraceSession()?.sessionId).toBe('session-fail')
  })
})

async function writeTraceConfig(config: TraceConfig): Promise<void> {
  await mkdir(getTraceRootDir(), { recursive: true })
  await writeFile(getTraceConfigPath(), `${JSON.stringify(config, null, 2)}\n`)
}
