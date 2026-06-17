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

  test('redacts common secret key spelling variants', () => {
    expect(
      redactTracePayload(
        {
          OPENAI_API_KEY: 'sk-openai',
          ANTHROPIC_API_KEY: 'sk-anthropic',
          accessToken: 'access-token',
          refresh_token: 'refresh-token',
          client_secret: 'client-secret',
          'x-api-key': 'x-api-key',
          nested: {
            databasePassword: 'password',
            sessionCookie: 'cookie',
          },
        },
        'full',
      ),
    ).toEqual({
      OPENAI_API_KEY: '[REDACTED]',
      ANTHROPIC_API_KEY: '[REDACTED]',
      accessToken: '[REDACTED]',
      refresh_token: '[REDACTED]',
      client_secret: '[REDACTED]',
      'x-api-key': '[REDACTED]',
      nested: {
        databasePassword: '[REDACTED]',
        sessionCookie: '[REDACTED]',
      },
    })
  })

  test('keeps learner payloads short', () => {
    const value = `${'x'.repeat(500)}tail`
    const result = redactTracePayload({ text: value }, 'learn')

    expect((result as { text: string }).text).toHaveLength(500)
    expect((result as { text: string }).text).toBe('x'.repeat(500))
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
    const value = `${'x'.repeat(20000)}tail`
    const result = redactTracePayload({ text: value }, 'full')

    expect((result as { text: string }).text).toHaveLength(20000)
    expect((result as { text: string }).text).toBe('x'.repeat(20000))
  })

  test('does not mutate source objects', () => {
    const payload = {
      token: 'secret-token',
      nested: { text: `${'x'.repeat(500)}tail` },
    }

    expect(redactTracePayload(payload, 'learn')).toEqual({
      token: '[REDACTED]',
      nested: { text: 'x'.repeat(500) },
    })
    expect(payload).toEqual({
      token: 'secret-token',
      nested: { text: `${'x'.repeat(500)}tail` },
    })
  })

  test('handles deeply nested objects without using the call stack', () => {
    const payload: { child?: unknown } = {}
    let cursor = payload

    for (let depth = 0; depth < 20000; depth += 1) {
      const child: { child?: unknown } = {}
      cursor.child = child
      cursor = child
    }

    cursor.child = { token: 'secret-token' }

    const result = redactTracePayload(payload, 'full')
    let resultCursor = result as { child?: unknown }

    for (let depth = 0; depth < 20000; depth += 1) {
      resultCursor = resultCursor.child as { child?: unknown }
    }

    expect(resultCursor.child).toEqual({ token: '[REDACTED]' })
  })
})
