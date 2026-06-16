import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import {
  getActiveTracePath,
  getTraceConfigPath,
  getTraceEventsPath,
  getTraceRootDir,
} from '../paths.js'
import {
  appendTraceEvent,
  readActiveTraceSession,
  readTraceEvents,
  writeActiveTraceSession,
} from '../store.js'
import type { TraceEvent } from '../types.js'

const originalTraceDir = process.env.CLAUDE_CODE_TRACE_DIR
let traceDir: string

describe('trace store', () => {
  beforeEach(async () => {
    traceDir = await mkdtemp(join(tmpdir(), 'claude-trace-store-'))
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

  test('resolves trace paths under the configured trace directory', () => {
    expect(getTraceRootDir()).toBe(traceDir)
    expect(getTraceConfigPath()).toBe(join(traceDir, 'config.json'))
    expect(getActiveTracePath()).toBe(join(traceDir, 'active-session.json'))
    expect(getTraceEventsPath('session-1')).toBe(
      join(traceDir, 'session-1', 'events.jsonl'),
    )
  })

  test('appends trace events and reads valid non-empty JSONL lines', async () => {
    const first = makeTraceEvent({ eventId: 'event-1', sequence: 1 })
    const second = makeTraceEvent({ eventId: 'event-2', sequence: 2 })

    appendTraceEvent(first)
    await writeFile(getTraceEventsPath(first.sessionId), '\n', { flag: 'a' })
    appendTraceEvent(second)

    expect(await readFile(getTraceEventsPath(first.sessionId), 'utf8')).toBe(
      `${JSON.stringify(first)}\n\n${JSON.stringify(second)}\n`,
    )
    expect(readTraceEvents(first.sessionId)).toEqual([first, second])
  })

  test('returns null when no active trace session exists', () => {
    expect(readActiveTraceSession()).toBeNull()
  })

  test('writes and reads the active trace session pointer', () => {
    const activeSession = {
      sessionId: 'session-1',
      eventsPath: getTraceEventsPath('session-1'),
      startedAt: '2026-06-16T00:00:00.000Z',
    }

    writeActiveTraceSession(activeSession)

    expect(readActiveTraceSession()).toEqual(activeSession)
  })
})

function makeTraceEvent(overrides: Partial<TraceEvent> = {}): TraceEvent {
  return {
    eventId: 'event-1',
    sessionId: 'session-1',
    sequence: 1,
    timestamp: '2026-06-16T00:00:00.000Z',
    mode: 'learn',
    source: 'repl',
    type: 'trace.session_start',
    payload: { cwd: 'C:\\workspace' },
    ...overrides,
  }
}
