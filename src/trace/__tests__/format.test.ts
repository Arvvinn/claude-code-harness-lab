import { describe, expect, test } from 'bun:test'
import {
  formatTraceRecord,
  parseTraceJsonLine,
  type TraceDisplayMode,
} from '../format.js'
import type { TraceEvent } from '../types.js'

describe('trace formatters', () => {
  test('formats learner events as compact human-readable lines', () => {
    const line = formatTraceRecord(
      makeTraceEvent({
        timestamp: '2026-06-16T14:03:10.123Z',
        type: 'turn.start',
        payload: {
          inputChars: 41,
          rawPrompt: 'do not print this raw prompt',
          promptSummary: 'short task',
        },
      }),
      'learn',
    )

    expect(line).toBe(
      '14:03:10 turn.start inputChars=41 promptSummary="short task"',
    )
    expect(line).not.toContain('raw prompt')
  })

  test('formats full events as compact redacted JSON', () => {
    const line = formatTraceRecord(
      makeTraceEvent({
        type: 'api.request_built',
        payload: {
          model: 'claude-sonnet',
          Authorization: 'Bearer secret-token',
        },
      }),
      'full',
    )

    expect(JSON.parse(line)).toMatchObject({
      type: 'api.request_built',
      payload: {
        model: 'claude-sonnet',
        Authorization: '[REDACTED]',
      },
    })
    expect(line).not.toContain('secret-token')
  })

  test('uses learner display for off mode replays', () => {
    const mode: TraceDisplayMode = 'learn'

    expect(
      formatTraceRecord(makeTraceEvent({ type: 'tool.started' }), mode),
    ).toContain('tool.started')
  })

  test('turns malformed JSONL lines into synthetic read errors', () => {
    const record = parseTraceJsonLine('{bad json', {
      sessionId: 'session-1',
      lineNumber: 3,
    })

    expect(record).toMatchObject({
      sessionId: 'session-1',
      sequence: 3,
      source: 'trace',
      type: 'trace.read_error',
      payload: {
        lineNumber: 3,
      },
    })
    expect(formatTraceRecord(record, 'learn')).toContain('trace.read_error')
  })
})

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
