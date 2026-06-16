import { randomUUID } from 'node:crypto'
import { loadTraceConfig } from './config.js'
import { getTraceEventsPath } from './paths.js'
import { redactTracePayload } from './redaction.js'
import {
  appendTraceEvent,
  clearActiveTraceSession,
  writeActiveTraceSession,
} from './store.js'
import type {
  ActiveTraceMode,
  TraceEvent,
  TraceEventType,
  TraceMode,
  TraceSource,
} from './types.js'

export interface EmitTraceInput {
  parentId?: string
  turnId?: string
  source: TraceSource
  type: TraceEventType
  payload?: Record<string, unknown>
}

interface ActiveTraceState {
  sessionId: string
  mode: ActiveTraceMode
}

let activeTrace: ActiveTraceState | null = null
let disabled = false
let sequence = 0
let appendQueue: Promise<void> = Promise.resolve()

export function getTraceMode(): TraceMode {
  if (disabled) {
    return 'off'
  }

  return loadTraceConfig().mode
}

export function getActiveTraceSessionForProcess(): {
  sessionId: string
  mode: ActiveTraceMode
  eventsPath: string
} | null {
  if (activeTrace === null) {
    return null
  }

  return {
    ...activeTrace,
    eventsPath: getTraceEventsPath(activeTrace.sessionId),
  }
}

export function isTraceSessionActive(): boolean {
  return activeTrace !== null
}

export function startTraceSession(input: {
  sessionId: string
  cwd: string
  argv: string[]
}): void {
  const mode = getTraceMode()

  if (mode === 'off') {
    return
  }

  const startedAt = new Date().toISOString()
  activeTrace = {
    sessionId: input.sessionId,
    mode,
  }
  const sessionStartEvent = buildTraceEvent({
    source: 'repl',
    type: 'trace.session_start',
    payload: {
      cwd: input.cwd,
      argv: input.argv,
    },
  })

  enqueueTraceWrite(() => {
    writeActiveTraceSession({
      sessionId: input.sessionId,
      eventsPath: getTraceEventsPath(input.sessionId),
      startedAt,
    })
    appendTraceEvent(sessionStartEvent)
  })
}

export function emitTrace(input: EmitTraceInput): void {
  if (disabled) {
    return
  }

  if (getTraceMode() === 'off') {
    enqueueTraceWrite(() => {
      clearActiveTraceSession()
    })
    activeTrace = null
    return
  }

  if (activeTrace === null) {
    return
  }

  const event = buildTraceEvent(input)

  enqueueTraceWrite(() => {
    appendTraceEvent(event)
  })
}

export function endTraceSession(payload?: Record<string, unknown>): void {
  if (disabled || activeTrace === null) {
    return
  }

  if (getTraceMode() === 'off') {
    return
  }

  const event = buildTraceEvent({
    source: 'repl',
    type: 'trace.session_end',
    payload,
  })

  enqueueTraceWrite(() => {
    appendTraceEvent(event)
    clearActiveTraceSession()
  })
  activeTrace = null
}

export async function flushTraceForTesting(): Promise<void> {
  await appendQueue
}

export function resetTraceForTesting(): void {
  activeTrace = null
  disabled = false
  sequence = 0
  appendQueue = Promise.resolve()
}

function enqueueTraceWrite(write: () => void): void {
  appendQueue = appendQueue.then(() => {
    if (disabled) {
      return
    }

    try {
      write()
    } catch {
      disabled = true
      activeTrace = null
    }
  })
}

function buildTraceEvent(input: EmitTraceInput): TraceEvent {
  if (activeTrace === null) {
    throw new Error('Trace session is not active')
  }

  sequence += 1

  return {
    eventId: randomUUID(),
    parentId: input.parentId,
    sessionId: activeTrace.sessionId,
    turnId: input.turnId,
    sequence,
    timestamp: new Date().toISOString(),
    mode: activeTrace.mode,
    source: input.source,
    type: input.type,
    payload: redactTracePayload(
      input.payload ?? {},
      activeTrace.mode,
    ) as Record<string, unknown>,
  }
}
