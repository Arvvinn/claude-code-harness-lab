import { describe, expect, test } from 'bun:test'
import { formatTraceLocalTime } from '../time.js'

describe('formatTraceLocalTime', () => {
  test('formats UTC trace timestamps as local display time', () => {
    expect(
      formatTraceLocalTime('2026-06-17T16:03:47.556Z', {
        timeZone: 'Asia/Shanghai',
      }),
    ).toBe('2026-06-18 00:03:47 local')
  })

  test('does not leak raw UTC suffix into human display', () => {
    expect(
      formatTraceLocalTime('2026-06-17T16:03:47.556Z', {
        timeZone: 'Asia/Shanghai',
      }),
    ).not.toContain('Z')
  })

  test('handles invalid timestamps without throwing', () => {
    expect(formatTraceLocalTime('not-a-date')).toBe('invalid local time')
  })
})
