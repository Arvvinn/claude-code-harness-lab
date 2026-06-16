import { redactTracePayload } from './redaction.js'
import type { ActiveTraceMode, TraceEvent } from './types.js'

export type TraceDisplayMode = ActiveTraceMode

export interface TraceReadErrorRecord {
  eventId: string
  sessionId: string
  sequence: number
  timestamp: string
  mode: ActiveTraceMode
  source: 'trace'
  type: 'trace.read_error'
  payload: {
    lineNumber: number
    message: string
    rawLinePreview: string
  }
}

export type TraceDisplayRecord = TraceEvent | TraceReadErrorRecord

export function parseTraceJsonLine(
  line: string,
  context: {
    sessionId: string
    lineNumber: number
  },
): TraceDisplayRecord {
  try {
    const parsed: unknown = JSON.parse(line)

    if (isTraceEvent(parsed)) {
      return parsed
    }

    return makeReadErrorRecord(context, line, 'Invalid trace event shape')
  } catch (error) {
    return makeReadErrorRecord(context, line, getErrorMessage(error))
  }
}

export function formatTraceRecord(
  record: TraceDisplayRecord,
  mode: TraceDisplayMode,
): string {
  if (mode === 'full') {
    return JSON.stringify(redactTracePayload(record, 'full'))
  }

  const payload = formatLearnerPayload(record.payload)
  const suffix = payload.length > 0 ? ` ${payload}` : ''

  return `${formatTimestamp(record.timestamp)} ${record.type}${suffix}`
}

function makeReadErrorRecord(
  context: {
    sessionId: string
    lineNumber: number
  },
  line: string,
  message: string,
): TraceReadErrorRecord {
  return {
    eventId: `read-error-${context.lineNumber}`,
    sessionId: context.sessionId,
    sequence: context.lineNumber,
    timestamp: '1970-01-01T00:00:00.000Z',
    mode: 'learn',
    source: 'trace',
    type: 'trace.read_error',
    payload: {
      lineNumber: context.lineNumber,
      message,
      rawLinePreview: truncateForDisplay(line.trim(), 120),
    },
  }
}

function isTraceEvent(value: unknown): value is TraceEvent {
  if (value === null || typeof value !== 'object') {
    return false
  }

  const event = value as Record<string, unknown>

  return (
    typeof event.eventId === 'string' &&
    typeof event.sessionId === 'string' &&
    typeof event.sequence === 'number' &&
    typeof event.timestamp === 'string' &&
    (event.mode === 'learn' || event.mode === 'full') &&
    typeof event.source === 'string' &&
    typeof event.type === 'string' &&
    event.payload !== null &&
    typeof event.payload === 'object' &&
    !Array.isArray(event.payload)
  )
}

function formatTimestamp(timestamp: string): string {
  const date = new Date(timestamp)

  if (Number.isNaN(date.getTime())) {
    return '??:??:??'
  }

  return date.toISOString().slice(11, 19)
}

function formatLearnerPayload(payload: Record<string, unknown>): string {
  const keys = Object.keys(payload)
  const entries: Array<[string, string | number | boolean | null]> = []

  for (const [key, value] of Object.entries(payload)) {
    if (shouldShowLearnerField(key, value, keys) && isScalar(value)) {
      entries.push([key, value])
    }
  }

  entries.sort(([left], [right]) => comparePayloadKeys(left, right))

  return entries
    .map(([key, value]) => `${key}=${formatScalar(value)}`)
    .join(' ')
}

function shouldShowLearnerField(
  key: string,
  value: unknown,
  keys: string[],
): boolean {
  if (!isScalar(value)) {
    return false
  }

  const normalizedKey = key.toLowerCase()

  if (normalizedKey.includes('raw')) {
    return false
  }

  if (
    normalizedKey === 'prompt' &&
    keys.some(candidate => candidate.toLowerCase().includes('summary'))
  ) {
    return false
  }

  return true
}

function isScalar(value: unknown): value is string | number | boolean | null {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  )
}

const PREFERRED_PAYLOAD_ORDER = [
  'model',
  'provider',
  'toolName',
  'toolUseId',
  'status',
  'ok',
  'durationMs',
  'inputChars',
  'messageCount',
  'messages',
  'toolCount',
  'tools',
  'promptSummary',
  'lineNumber',
  'message',
]

function comparePayloadKeys(left: string, right: string): number {
  const leftIndex = PREFERRED_PAYLOAD_ORDER.indexOf(left)
  const rightIndex = PREFERRED_PAYLOAD_ORDER.indexOf(right)

  if (leftIndex !== -1 || rightIndex !== -1) {
    return (
      normalizePreferredIndex(leftIndex) - normalizePreferredIndex(rightIndex)
    )
  }

  return left.localeCompare(right)
}

function normalizePreferredIndex(index: number): number {
  return index === -1 ? Number.MAX_SAFE_INTEGER : index
}

function formatScalar(value: string | number | boolean | null): string {
  if (value === null) {
    return 'null'
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }

  const truncated = truncateForDisplay(value, 160)

  if (/^[A-Za-z0-9_./:@-]+$/.test(truncated)) {
    return truncated
  }

  return JSON.stringify(truncated)
}

function truncateForDisplay(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value
  }

  return `${value.slice(0, maxLength - 3)}...`
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
