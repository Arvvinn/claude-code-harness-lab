import type { ActiveTraceMode } from './types.js'

const REDACTED = '[REDACTED]'
const CIRCULAR = '[Circular]'

const SECRET_KEY_PATTERN =
  /api[-_]?key|secret|password|authorization|cookie|set-cookie/i
const SECRET_TOKEN_KEYS = new Set([
  'token',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'authtoken',
])
const AUTH_VALUE_PATTERN = /^(bearer|basic)\s+\S+/i

type ObjectFrame = {
  entries: [string, unknown][]
  index: number
  source: object
  target: Record<string, unknown>
  type: 'object'
}

type ArrayFrame = {
  index: number
  source: object
  sourceArray: unknown[]
  target: unknown[]
  type: 'array'
}

type Frame = ArrayFrame | ObjectFrame

export function redactTracePayload(
  value: unknown,
  mode: ActiveTraceMode,
): unknown {
  const seen = new WeakSet<object>()
  const stack: Frame[] = []
  const root = prepareValue(value, mode, seen, stack)

  while (stack.length > 0) {
    const frame = stack[stack.length - 1]

    if (frame.type === 'array') {
      if (frame.index >= frame.sourceArray.length) {
        seen.delete(frame.source)
        stack.pop()
        continue
      }

      const index = frame.index
      frame.index += 1
      frame.target[index] = prepareValue(
        frame.sourceArray[index],
        mode,
        seen,
        stack,
      )
      continue
    }

    if (frame.index >= frame.entries.length) {
      seen.delete(frame.source)
      stack.pop()
      continue
    }

    const [key, childValue] = frame.entries[frame.index]
    frame.index += 1
    frame.target[key] = shouldRedactKey(key)
      ? REDACTED
      : prepareValue(childValue, mode, seen, stack)
  }

  return root
}

function prepareValue(
  value: unknown,
  mode: ActiveTraceMode,
  seen: WeakSet<object>,
  stack: Frame[],
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
    const target: unknown[] = []
    stack.push({
      index: 0,
      source: value,
      sourceArray: value,
      target,
      type: 'array',
    })
    return target
  }

  const result: Record<string, unknown> = {}
  stack.push({
    entries: Object.entries(value as Record<string, unknown>),
    index: 0,
    source: value,
    target: result,
    type: 'object',
  })
  return result
}

function shouldRedactKey(key: string): boolean {
  return (
    SECRET_KEY_PATTERN.test(key) || SECRET_TOKEN_KEYS.has(normalizeKey(key))
  )
}

function normalizeKey(key: string): string {
  return key.replace(/[-_]/g, '').toLowerCase()
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
