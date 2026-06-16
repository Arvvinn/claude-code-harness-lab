import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { loadTraceConfig, saveTraceConfig } from './config.js'
import {
  getTraceConfigPath,
  getTraceEventsPath,
  getTraceRootDir,
} from './paths.js'
import {
  formatTraceRecord,
  parseTraceJsonLine,
  type TraceDisplayMode,
  type TraceDisplayRecord,
} from './format.js'
import { clearActiveTraceSession, readActiveTraceSession } from './store.js'
import type { TraceMode } from './types.js'

interface WritableOutput {
  write(chunk: string): unknown
}

export interface TraceTailOptions {
  follow?: boolean
  pollIntervalMs?: number
  idleTimeoutMs?: number
}

export interface TraceMainOptions {
  stdout?: WritableOutput
  stderr?: WritableOutput
  tail?: TraceTailOptions
}

interface TraceIo {
  stdout: WritableOutput
  stderr: WritableOutput
}

interface TraceSessionListing {
  sessionId: string
  eventsPath: string
  eventCount: number
  lastTimestamp: string | null
  sortTimestamp: number
}

const USAGE =
  'Usage: claude trace status|off|learn|full|list|tail|replay <sessionId>|inspect <sessionId>'

export async function traceMain(
  args: string[],
  options: TraceMainOptions = {},
): Promise<number> {
  const io = {
    stdout: options.stdout ?? process.stdout,
    stderr: options.stderr ?? process.stderr,
  }
  const command = args[0] ?? 'status'

  try {
    switch (command) {
      case 'status':
        writeText(io.stdout, getStatusText())
        return 0
      case 'off':
      case 'learn':
      case 'full':
        writeText(io.stdout, setTraceModeText(command))
        return 0
      case 'list':
        writeText(io.stdout, getListText())
        return 0
      case 'replay':
        writeText(io.stdout, getReplayText(requireSessionId(args[1], 'replay')))
        return 0
      case 'inspect':
        writeText(
          io.stdout,
          getInspectText(requireSessionId(args[1], 'inspect')),
        )
        return 0
      case 'tail':
        await writeTail(args[1], io, options.tail)
        return 0
      case '-h':
      case '--help':
      case 'help':
        writeText(io.stdout, `${USAGE}\n`)
        return 0
      default:
        writeText(io.stderr, `Unknown trace command: ${command}\n${USAGE}\n`)
        return 1
    }
  } catch (error) {
    writeText(io.stderr, `Error: ${getErrorMessage(error)}\n${USAGE}\n`)
    return 1
  }
}

export function readTraceRecords(sessionId: string): TraceDisplayRecord[] {
  const eventsPath = getTraceEventsPath(sessionId)

  if (!existsSync(eventsPath)) {
    return []
  }

  return readTraceRecordsFromText(sessionId, readFileSync(eventsPath, 'utf8'))
}

function readTraceRecordsFromText(
  sessionId: string,
  text: string,
): TraceDisplayRecord[] {
  const records: TraceDisplayRecord[] = []
  const lines = text.split(/\r?\n/)

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.trim()

    if (line.length === 0) {
      continue
    }

    records.push(
      parseTraceJsonLine(line, {
        sessionId,
        lineNumber: index + 1,
      }),
    )
  }

  return records
}

function getStatusText(): string {
  const config = loadTraceConfig()
  const activeSession = readActiveTraceSession()
  const lines = [
    'Trace status',
    `Mode: ${config.mode}`,
    `Trace dir: ${getTraceRootDir()}`,
    `Config: ${getTraceConfigPath()}`,
  ]

  if (activeSession === null) {
    lines.push('Active session: none')
  } else {
    lines.push(`Active session: ${activeSession.sessionId}`)
    lines.push(`Started: ${activeSession.startedAt}`)
    lines.push(`Events: ${activeSession.eventsPath}`)
    lines.push(
      `Events file: ${existsSync(activeSession.eventsPath) ? 'present' : 'missing'}`,
    )
  }

  lines.push('Tail command: claude trace tail')

  return `${lines.join('\n')}\n`
}

function setTraceModeText(mode: TraceMode): string {
  const current = loadTraceConfig()

  saveTraceConfig({
    ...current,
    mode,
  })

  if (mode === 'off') {
    clearActiveTraceSession()
  }

  const lines = [`Trace mode set to ${mode}`, `Trace dir: ${getTraceRootDir()}`]
  const activeSession = readActiveTraceSession()

  if (activeSession === null) {
    lines.push('Active session: none')
  } else {
    lines.push(`Active session: ${activeSession.sessionId}`)
    lines.push(`Events: ${activeSession.eventsPath}`)
  }

  lines.push('Tail command: claude trace tail')

  return `${lines.join('\n')}\n`
}

function getListText(): string {
  const sessions = listTraceSessions()

  if (sessions.length === 0) {
    return `Trace sessions\nNo sessions found under ${getTraceRootDir()}\n`
  }

  const lines = ['Trace sessions']

  for (const session of sessions) {
    lines.push(
      `${session.sessionId}  events=${session.eventCount}  last=${
        session.lastTimestamp ?? 'none'
      }  path=${session.eventsPath}`,
    )
  }

  return `${lines.join('\n')}\n`
}

function listTraceSessions(): TraceSessionListing[] {
  const traceRoot = getTraceRootDir()

  if (!existsSync(traceRoot)) {
    return []
  }

  const sessions: TraceSessionListing[] = []

  for (const entry of readdirSync(traceRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue
    }

    let eventsPath: string

    try {
      eventsPath = getTraceEventsPath(entry.name)
    } catch {
      continue
    }

    if (!existsSync(eventsPath)) {
      continue
    }

    const records = readTraceRecords(entry.name)
    const lastTimestamp = getLastTimestamp(records)
    const sortTimestamp =
      lastTimestamp === null
        ? statSync(eventsPath).mtimeMs
        : Date.parse(lastTimestamp)

    sessions.push({
      sessionId: entry.name,
      eventsPath,
      eventCount: records.length,
      lastTimestamp,
      sortTimestamp: Number.isNaN(sortTimestamp) ? 0 : sortTimestamp,
    })
  }

  return sessions.sort(
    (left, right) => right.sortTimestamp - left.sortTimestamp,
  )
}

function getReplayText(sessionId: string): string {
  const records = readTraceRecords(sessionId)

  if (records.length === 0) {
    return `No events found for session ${sessionId}\n`
  }

  const displayMode = getDisplayMode(loadTraceConfig().mode)

  return `${records
    .map(record => formatTraceRecord(record, displayMode))
    .join('\n')}\n`
}

function getInspectText(sessionId: string): string {
  const eventsPath = getTraceEventsPath(sessionId)
  const records = readTraceRecords(sessionId)
  const countsByType: Record<string, number> = {}
  const countsBySource: Record<string, number> = {}

  for (const record of records) {
    countsByType[record.type] = (countsByType[record.type] ?? 0) + 1
    countsBySource[record.source] = (countsBySource[record.source] ?? 0) + 1
  }

  const summary = {
    sessionId,
    eventsPath,
    eventCount: records.length,
    firstTimestamp: records[0]?.timestamp ?? null,
    lastTimestamp: getLastTimestamp(records),
    readErrorCount: records.filter(record => record.type === 'trace.read_error')
      .length,
    countsByType,
    countsBySource,
  }

  return `${JSON.stringify(summary, null, 2)}\n`
}

async function writeTail(
  requestedSessionId: string | undefined,
  io: TraceIo,
  options: TraceTailOptions = {},
): Promise<void> {
  const target = getTailTarget(requestedSessionId)

  if (target === null) {
    writeText(
      io.stdout,
      'No active trace session.\nRun `claude trace list` to find sessions for replay.\n',
    )
    return
  }

  if (!existsSync(target.eventsPath)) {
    writeText(
      io.stdout,
      `Active trace events file is missing: ${target.eventsPath}\nRun \`claude trace status\` for details.\n`,
    )
    return
  }

  const displayMode = getDisplayMode(loadTraceConfig().mode)
  const follow = options.follow ?? true
  const pollIntervalMs = options.pollIntervalMs ?? 500
  let processedLineCount = 0
  let idleStartedAt = Date.now()

  for (;;) {
    const lines = readNonEmptyLines(target.eventsPath)
    const newLines =
      lines.length < processedLineCount
        ? lines
        : lines.slice(processedLineCount)

    if (lines.length < processedLineCount) {
      processedLineCount = 0
    }

    if (newLines.length > 0) {
      for (let index = 0; index < newLines.length; index += 1) {
        const record = parseTraceJsonLine(newLines[index]!, {
          sessionId: target.sessionId,
          lineNumber: processedLineCount + index + 1,
        })
        writeText(io.stdout, `${formatTraceRecord(record, displayMode)}\n`)
      }

      processedLineCount = lines.length
      idleStartedAt = Date.now()
    }

    if (!follow) {
      return
    }

    if (
      options.idleTimeoutMs !== undefined &&
      Date.now() - idleStartedAt >= options.idleTimeoutMs
    ) {
      return
    }

    await delay(pollIntervalMs)
  }
}

function getTailTarget(requestedSessionId: string | undefined): {
  sessionId: string
  eventsPath: string
} | null {
  if (requestedSessionId !== undefined) {
    return {
      sessionId: requestedSessionId,
      eventsPath: getTraceEventsPath(requestedSessionId),
    }
  }

  const activeSession = readActiveTraceSession()

  if (activeSession === null) {
    return null
  }

  return {
    sessionId: activeSession.sessionId,
    eventsPath: activeSession.eventsPath,
  }
}

function readNonEmptyLines(path: string): string[] {
  return readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0)
}

function getDisplayMode(mode: TraceMode): TraceDisplayMode {
  return mode === 'full' ? 'full' : 'learn'
}

function getLastTimestamp(records: TraceDisplayRecord[]): string | null {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const timestamp = records[index]?.timestamp

    if (timestamp !== undefined) {
      return timestamp
    }
  }

  return null
}

function requireSessionId(
  sessionId: string | undefined,
  command: string,
): string {
  if (sessionId === undefined || sessionId.length === 0) {
    throw new Error(`trace ${command} requires a sessionId`)
  }

  getTraceEventsPath(sessionId)

  return sessionId
}

function writeText(output: WritableOutput, text: string): void {
  output.write(text)
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
