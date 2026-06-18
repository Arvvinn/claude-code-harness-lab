import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
} from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { loadTraceConfig, saveTraceConfig } from './config.js'
import {
  getTraceConfigPath,
  getTraceEventsPath,
  getTraceRootDir,
} from './paths.js'
import { parseTraceJsonLine, type TraceDisplayRecord } from './format.js'
import {
  createTraceLiveStream,
  renderTraceLiveHeader,
  type TraceLiveStream,
} from './liveStream.js'
import { TRACE_TAIL_COMMAND } from './liveWindow.js'
import { clearActiveTraceSession, readActiveTraceSession } from './store.js'
import type { TraceMode } from './types.js'

interface WritableOutput {
  write(chunk: string): unknown
}

export interface TraceTailOptions {
  follow?: boolean
  pollIntervalMs?: number
  idleTimeoutMs?: number
  startAtEnd?: boolean
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

interface TailContinuityMarker {
  offset: number
  bytes: Buffer
}

interface TailReadChunk {
  text: string
  bytesRead: number
}

interface TailReadBytes {
  bytes: Buffer
  bytesRead: number
}

const TAIL_CONTINUITY_MARKER_BYTES = 64

const USAGE =
  'Usage: claude trace status|off|learn|full|list|tail [sessionId] [--deep] [--raw]|replay <sessionId> [--deep] [--raw]|inspect <sessionId>'

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
        writeText(
          io.stdout,
          getReplayText(
            requireSessionId(getFirstNonFlagArg(args.slice(1)), 'replay'),
            hasRawFlag(args),
            hasDeepFlag(args),
          ),
        )
        return 0
      case 'inspect':
        writeText(
          io.stdout,
          getInspectText(requireSessionId(args[1], 'inspect')),
        )
        return 0
      case 'tail':
        await writeTail(
          getFirstNonFlagArg(args.slice(1)),
          io,
          options.tail,
          hasRawFlag(args),
          hasDeepFlag(args),
        )
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

function getLatestMainTurnRecords(
  records: TraceDisplayRecord[],
): TraceDisplayRecord[] {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index]

    if (record?.type === 'turn.start' && isMainTraceRecord(record)) {
      return records.slice(index)
    }
  }

  return []
}

function isMainTraceRecord(record: TraceDisplayRecord): boolean {
  const payload = record.payload

  if (
    typeof payload !== 'object' ||
    payload === null ||
    Array.isArray(payload)
  ) {
    return false
  }

  const querySource = (payload as Record<string, unknown>).querySource

  return (
    querySource === undefined ||
    querySource === 'repl_main_thread' ||
    (typeof querySource === 'string' &&
      querySource.startsWith('repl_main_thread:')) ||
    querySource === 'sdk'
  )
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

  lines.push(`Tail command: ${TRACE_TAIL_COMMAND}`)

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

  lines.push(`Tail command: ${TRACE_TAIL_COMMAND}`)

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

function getReplayText(sessionId: string, raw: boolean, deep: boolean): string {
  if (raw) {
    const lines = readNonEmptyLines(getTraceEventsPath(sessionId))

    if (lines.length === 0) {
      return `No events found for session ${sessionId}\n`
    }

    return `${lines.join('\n')}\n`
  }

  const records = readTraceRecords(sessionId)

  if (records.length === 0) {
    return `No events found for session ${sessionId}\n`
  }

  const depth = deep ? 'deep' : 'learn'
  const stream = createTraceLiveStream({ depth, color: false })
  const lines = [
    depth === 'deep' ? 'Trace Replay - Deep' : 'Trace Replay - Learn',
    `Session: ${sessionId}`,
    '',
  ]

  for (const record of records) {
    lines.push(
      ...stream
        .renderRecord(record)
        .map(line => (line.endsWith('\n') ? line.slice(0, -1) : line)),
    )
  }

  return `${lines.join('\n')}\n`
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
  raw = false,
  deep = false,
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

  const follow = options.follow ?? true
  const pollIntervalMs = options.pollIntervalMs ?? 250
  const startAtEnd = options.startAtEnd ?? follow
  let offset = startAtEnd ? statSync(target.eventsPath).size : 0
  let continuityMarker = readTailContinuityMarker(target.eventsPath, offset)
  if (offset > 0 && continuityMarker === null) {
    offset = 0
  }

  let pending = ''
  let idleStartedAt = Date.now()
  const depth = deep ? 'deep' : 'learn'
  const stream = createTraceLiveStream({ depth })

  if (!raw) {
    writeText(
      io.stdout,
      renderTraceLiveHeader({
        depth,
        sessionId: target.sessionId,
        eventsPath: target.eventsPath,
      }),
    )
  }

  if (!raw && follow && startAtEnd) {
    for (const record of getLatestMainTurnRecords(
      readTraceRecords(target.sessionId),
    )) {
      for (const rendered of stream.renderRecord(record)) {
        writeText(io.stdout, rendered)
      }
    }
  }

  for (;;) {
    const stat = statSync(target.eventsPath)

    if (stat.size < offset) {
      offset = 0
      pending = ''
      continuityMarker = null
    } else if (
      offset > 0 &&
      !tailContinuityMarkerMatches(
        target.eventsPath,
        stat.size,
        continuityMarker,
      )
    ) {
      offset = 0
      pending = ''
      continuityMarker = null
    }

    if (stat.size > offset) {
      const chunk = readFileChunk(target.eventsPath, offset, stat.size - offset)

      if (chunk.bytesRead === 0) {
        offset = 0
        pending = ''
        continuityMarker = null
      } else {
        const nextOffset = offset + chunk.bytesRead
        const nextMarker = readTailContinuityMarker(
          target.eventsPath,
          nextOffset,
        )

        if (nextOffset > 0 && nextMarker === null) {
          offset = 0
          pending = ''
          continuityMarker = null
        } else {
          offset = nextOffset
          continuityMarker = nextMarker
          pending += chunk.text

          const lines = pending.split(/\r?\n/)
          pending = lines.pop() ?? ''
          const completeLines = lines.filter(line => line.trim().length > 0)

          for (const line of completeLines) {
            writeTailLine(line, target.sessionId, io, raw, stream)
          }

          if (completeLines.length > 0) {
            idleStartedAt = Date.now()
          }
        }
      }
    }

    if (!follow) {
      if (pending.trim().length > 0) {
        writeTailLine(pending, target.sessionId, io, raw, stream)
        pending = ''
      }

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
  if (!existsSync(path)) {
    return []
  }

  return readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .filter(line => line.trim().length > 0)
}

function readFileChunk(
  path: string,
  offset: number,
  length: number,
): TailReadChunk {
  const result = readFileBytes(path, offset, length)

  return {
    text: result.bytes.toString('utf8'),
    bytesRead: result.bytesRead,
  }
}

function readFileBytes(
  path: string,
  offset: number,
  length: number,
): TailReadBytes {
  if (length <= 0) {
    return {
      bytes: Buffer.alloc(0),
      bytesRead: 0,
    }
  }

  const fd = openSync(path, 'r')

  try {
    const buffer = Buffer.alloc(length)
    const bytesRead = readSync(fd, buffer, 0, length, offset)
    return {
      bytes: buffer.subarray(0, bytesRead),
      bytesRead,
    }
  } finally {
    closeSync(fd)
  }
}

function readTailContinuityMarker(
  path: string,
  offset: number,
): TailContinuityMarker | null {
  if (offset <= 0) {
    return null
  }

  const length = Math.min(TAIL_CONTINUITY_MARKER_BYTES, offset)
  const markerOffset = offset - length
  const result = readFileBytes(path, markerOffset, length)

  if (result.bytesRead !== length || result.bytesRead === 0) {
    return null
  }

  return {
    offset: markerOffset,
    bytes: result.bytes,
  }
}

function tailContinuityMarkerMatches(
  path: string,
  fileSize: number,
  marker: TailContinuityMarker | null,
): boolean {
  if (marker === null) {
    return false
  }

  if (marker.bytes.length === 0) {
    return false
  }

  if (fileSize < marker.offset + marker.bytes.length) {
    return false
  }

  const result = readFileBytes(path, marker.offset, marker.bytes.length)
  if (result.bytesRead !== marker.bytes.length) {
    return false
  }

  return result.bytes.equals(marker.bytes)
}

export function readTraceTailChunkForTesting(
  path: string,
  offset: number,
  length: number,
): TailReadChunk {
  return readFileChunk(path, offset, length)
}

export function readTraceTailContinuityMarkerForTesting(
  path: string,
  offset: number,
): TailContinuityMarker | null {
  return readTailContinuityMarker(path, offset)
}

function writeTailLine(
  line: string,
  sessionId: string,
  io: TraceIo,
  raw: boolean,
  stream: TraceLiveStream,
): void {
  if (raw) {
    writeText(io.stdout, `${line}\n`)
    return
  }

  const record = parseTraceJsonLine(line, {
    sessionId,
    lineNumber: 0,
  })

  for (const rendered of stream.renderRecord(record)) {
    writeText(io.stdout, rendered)
  }
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

function hasRawFlag(args: string[]): boolean {
  return args.includes('--raw')
}

function hasDeepFlag(args: string[]): boolean {
  return args.includes('--deep')
}

function getFirstNonFlagArg(args: string[]): string | undefined {
  return args.find(arg => !arg.startsWith('-'))
}

function writeText(output: WritableOutput, text: string): void {
  output.write(text)
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
