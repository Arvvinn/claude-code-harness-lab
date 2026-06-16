import type { ActiveTraceMode } from './types.js'

const REDACTED = '[REDACTED]'
const CIRCULAR = '[Circular]'

const SECRET_KEYS = new Set([
  'api_key',
  'apikey',
  'authorization',
  'token',
  'secret',
  'password',
  'cookie',
  'set-cookie',
])

const AUTH_VALUE_PATTERN = /^(bearer|basic)\s+\S+/i

export function redactTracePayload(
  value: unknown,
  mode: ActiveTraceMode,
): unknown {
  return redactValue(value, mode, new WeakSet<object>())
}

function redactValue(
  value: unknown,
  mode: ActiveTraceMode,
  seen: WeakSet<object>,
): unknown {
  if (typeof value === 'string') {
    return redactString(value, mode)
  }

  if (value === null || typeof value !== 'object') {
    return value
  }

  if (seen.has(value)) {
    return CIRCULAR
  }

  seen.add(value)

  if (Array.isArray(value)) {
    const result = value.map(item => redactValue(item, mode, seen))
    seen.delete(value)
    return result
  }

  const result: Record<string, unknown> = {}

  for (const [key, childValue] of Object.entries(
    value as Record<string, unknown>,
  )) {
    result[key] = shouldRedactKey(key)
      ? REDACTED
      : redactValue(childValue, mode, seen)
  }

  seen.delete(value)
  return result
}

function shouldRedactKey(key: string): boolean {
  return SECRET_KEYS.has(key.toLowerCase())
}

function redactString(value: string, mode: ActiveTraceMode): string {
  if (AUTH_VALUE_PATTERN.test(value)) {
    return REDACTED
  }

  const maxLength = mode === 'learn' ? 500 : 20000

  if (value.length <= maxLength) {
    return value
  }

  return value.slice(0, maxLength)
}
