import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'
import {
  getActiveTracePath,
  getTraceEventsPath,
  getTraceRootDir,
} from './paths.js'
import type { TraceEvent } from './types.js'

export interface ActiveTraceSession {
  sessionId: string
  eventsPath: string
  startedAt: string
}

export function appendTraceEvent(event: TraceEvent): void {
  const eventsPath = getTraceEventsPath(event.sessionId)

  mkdirSync(dirname(eventsPath), { recursive: true })
  appendFileSync(eventsPath, `${JSON.stringify(event)}\n`)
}

export function writeActiveTraceSession(session: ActiveTraceSession): void {
  assertValidActiveTraceSession(session)
  mkdirSync(getTraceRootDir(), { recursive: true })
  writeJsonAtomically(getActiveTracePath(), session)
}

export function clearActiveTraceSession(): void {
  rmSync(getActiveTracePath(), { force: true })
}

export function readActiveTraceSession(): ActiveTraceSession | null {
  const activeTracePath = getActiveTracePath()

  if (!existsSync(activeTracePath)) {
    return null
  }

  try {
    const parsed: unknown = JSON.parse(readFileSync(activeTracePath, 'utf8'))

    if (!isActiveTraceSession(parsed) || !isValidActiveTraceSession(parsed)) {
      return null
    }

    return parsed
  } catch {
    return null
  }
}

export function readTraceEvents(sessionId: string): TraceEvent[] {
  const eventsPath = getTraceEventsPath(sessionId)

  if (!existsSync(eventsPath)) {
    return []
  }

  return readFileSync(eventsPath, 'utf8')
    .split(/\r?\n/)
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line) as TraceEvent)
}

function isActiveTraceSession(value: unknown): value is ActiveTraceSession {
  if (value === null || typeof value !== 'object') {
    return false
  }

  const session = value as Record<string, unknown>

  return (
    typeof session.sessionId === 'string' &&
    typeof session.eventsPath === 'string' &&
    typeof session.startedAt === 'string'
  )
}

function assertValidActiveTraceSession(session: ActiveTraceSession): void {
  if (!isValidActiveTraceSession(session)) {
    throw new Error('Invalid active trace session')
  }
}

function isValidActiveTraceSession(session: ActiveTraceSession): boolean {
  try {
    return session.eventsPath === getTraceEventsPath(session.sessionId)
  } catch {
    return false
  }
}

function writeJsonAtomically(path: string, value: unknown): void {
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`)
  renameSync(tempPath, path)
}
