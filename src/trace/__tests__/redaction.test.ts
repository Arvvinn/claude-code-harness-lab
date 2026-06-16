import { describe, expect, test } from 'bun:test'
import { redactTracePayload } from '../redaction.js'

describe('redactTracePayload', () => {
  test('redacts secret-looking keys', () => {
    expect(
      redactTracePayload(
        { Authorization: 'Bearer abc', nested: { apiKey: 'sk-test' } },
        'full',
      ),
    ).toEqual({
      Authorization: '[REDACTED]',
      nested: { apiKey: '[REDACTED]' },
    })
  })

  test('keeps learner payloads short', () => {
    const result = redactTracePayload({ text: 'x'.repeat(900) }, 'learn')
    expect((result as { text: string }).text.length).toBeLessThanOrEqual(520)
  })

  test('redacts bearer and basic strings under generic keys', () => {
    expect(
      redactTracePayload(
        {
          header: 'Bearer abc123',
          nested: { value: 'Basic dXNlcjpwYXNz' },
        },
        'full',
      ),
    ).toEqual({
      header: '[REDACTED]',
      nested: { value: '[REDACTED]' },
    })
  })

  test('preserves array and object structure', () => {
    expect(
      redactTracePayload(
        {
          items: [{ text: 'visible' }, { password: 'hidden' }],
          empty: [],
        },
        'full',
      ),
    ).toEqual({
      items: [{ text: 'visible' }, { password: '[REDACTED]' }],
      empty: [],
    })
  })

  test('replaces circular references', () => {
    const payload: { name: string; self?: unknown } = { name: 'trace' }
    payload.self = payload

    expect(redactTracePayload(payload, 'full')).toEqual({
      name: 'trace',
      self: '[Circular]',
    })
  })

  test('caps full payload strings', () => {
    const result = redactTracePayload({ text: 'x'.repeat(21000) }, 'full')
    expect((result as { text: string }).text.length).toBeLessThanOrEqual(20020)
  })
})
