import type { TraceDisplayRecord } from './format.js'

type PanelSection =
  | 'USER'
  | 'SYSTEM'
  | 'MESSAGES'
  | 'LLM'
  | 'DECISION'
  | 'TOOL'
  | 'INTERNAL'
  | 'STORE'
  | 'RAW'
  | 'ERROR'

export interface TracePanelOptions {
  title: string
}

const SECTION_COLORS: Record<PanelSection, string> = {
  USER: '36',
  SYSTEM: '35',
  MESSAGES: '34',
  LLM: '33',
  DECISION: '37',
  TOOL: '32',
  INTERNAL: '95',
  STORE: '90',
  RAW: '96',
  ERROR: '31',
}

const AGENT_LOOP_PATTERN =
  'User -> messages[] -> LLM -> stop_reason/tool_use decision -> tools -> append results -> loop back/return text'

const MAX_PANEL_TEXT_CHARS = 240
const MAX_USER_PREVIEW_MESSAGES = 5

export function formatTracePanel(
  records: TraceDisplayRecord[],
  options: TracePanelOptions,
): string {
  if (records.length === 0) {
    return `${options.title}\nNo events found.\n`
  }

  const lastRecord = records[records.length - 1]!
  const lines = [
    options.title,
    `Session: ${lastRecord.sessionId}`,
    `Events: ${records.length}`,
    `Last: ${lastRecord.timestamp}`,
    `Pattern: ${AGENT_LOOP_PATTERN}`,
    '',
  ]

  const userInput = findLatestMainPayloadValue(records, 'messages')
  const systemPrompt = findLatestMainPayloadValue(records, 'systemPrompt')
  const userContext = findLatestMainPayloadValue(records, 'userContext')
  const systemContext = findLatestMainPayloadValue(records, 'systemContext')

  lines.push(formatSection('USER', extractUserInput(userInput)))
  lines.push(
    formatSection(
      'SYSTEM',
      summarizeSystemContext(systemPrompt, userContext, systemContext),
    ),
  )
  lines.push(formatSection('MESSAGES', summarizeMessages(userInput)))
  lines.push(formatSection('LLM', formatLlmRequest(records)))
  lines.push(formatSection('DECISION', summarizeDecision(records)))
  lines.push(formatSection('TOOL', summarizeTools(records)))
  lines.push(formatSection('INTERNAL', summarizeInternal(records)))
  lines.push(formatSection('STORE', summarizeStore(records)))
  lines.push(
    formatSection(
      'RAW',
      'Run `bun run dev trace tail --raw` for full payloads.',
    ),
  )
  lines.push(formatSection('ERROR', summarizeErrors(records)))

  return `${lines.join('\n')}\n`
}

function formatSection(section: PanelSection, value: unknown): string {
  const label = colorize(`[${section}]`, SECTION_COLORS[section])
  return `${label}\n${indent(formatValue(value))}`
}

function colorize(value: string, colorCode: string): string {
  return `\x1b[${colorCode}m${value}\x1b[0m`
}

function indent(value: string): string {
  return value
    .split('\n')
    .map(line => `  ${line}`)
    .join('\n')
}

function formatValue(value: unknown): string {
  if (value === undefined) {
    return 'none'
  }

  if (typeof value === 'string') {
    return value.length === 0 ? 'empty string' : value
  }

  return JSON.stringify(value, null, 2)
}

function findLatestPayloadValue(
  records: TraceDisplayRecord[],
  key: string,
  includePayload?: (payload: Record<string, unknown>) => boolean,
): unknown {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const payload = toRecord(records[index]?.payload)
    if (
      payload !== undefined &&
      (includePayload === undefined || includePayload(payload)) &&
      Object.hasOwn(payload, key)
    ) {
      return payload[key]
    }
  }

  return undefined
}

function findLatestMainPayloadValue(
  records: TraceDisplayRecord[],
  key: string,
): unknown {
  return findLatestPayloadValue(records, key, isMainRequest)
}

function extractUserInput(messages: unknown): unknown {
  if (!Array.isArray(messages)) {
    return typeof messages === 'string' ? formatPreview(messages) : undefined
  }

  const userTexts: string[] = []

  for (const message of messages) {
    if (typeof message !== 'object' || message === null) {
      continue
    }

    const record = message as Record<string, unknown>
    if (record.type !== 'user') {
      continue
    }

    const inner = record.message
    if (typeof inner !== 'object' || inner === null) {
      continue
    }

    const content = (inner as Record<string, unknown>).content
    collectText(content, userTexts)
  }

  if (userTexts.length === 0) {
    return undefined
  }

  const previewTexts = userTexts.slice(0, MAX_USER_PREVIEW_MESSAGES)
  const hiddenCount = userTexts.length - previewTexts.length
  const lines = previewTexts.map(formatPreview)

  if (hiddenCount > 0) {
    lines.push(`... ${hiddenCount} more user messages collapsed`)
  }

  return lines.join('\n\n')
}

function collectText(value: unknown, output: string[]): void {
  if (typeof value === 'string') {
    output.push(value)
    return
  }

  if (!Array.isArray(value)) {
    return
  }

  for (const block of value) {
    if (typeof block !== 'object' || block === null) {
      continue
    }

    const record = block as Record<string, unknown>
    if (record.type === 'text' && typeof record.text === 'string') {
      output.push(record.text)
    }
  }
}

function summarizeMessages(messages: unknown): string {
  if (!Array.isArray(messages)) {
    return 'user=0 assistant=0 system/internal=0 collapsed attachments/hooks=0 collapsed'
  }

  let userCount = 0
  let assistantCount = 0
  let internalCount = 0
  let attachmentCount = 0

  for (const message of messages) {
    if (!isRecord(message)) {
      internalCount += 1
      continue
    }

    const messageType =
      getStringField(message, 'type') ?? getStringField(message, 'role')

    if (messageType === 'user') {
      userCount += 1
    } else if (messageType === 'assistant') {
      assistantCount += 1
    } else if (
      messageType === 'attachment' ||
      messageType === 'hook' ||
      Object.hasOwn(message, 'attachment') ||
      Object.hasOwn(message, 'hook')
    ) {
      attachmentCount += 1
    } else {
      internalCount += 1
    }
  }

  return [
    `user=${userCount}`,
    `assistant=${assistantCount}`,
    `system/internal=${internalCount} collapsed`,
    `attachments/hooks=${attachmentCount} collapsed`,
  ].join(' ')
}

function summarizeSystemContext(
  systemPrompt: unknown,
  userContext: unknown,
  systemContext: unknown,
): string {
  return [
    `systemPrompt: ${formatCollapsedBlocks(systemPrompt)}`,
    `userContext: ${hasPanelValue(userContext) ? 'collapsed' : 'none'}`,
    `systemContext: ${hasPanelValue(systemContext) ? 'collapsed' : 'none'}`,
  ].join('\n')
}

function formatCollapsedBlocks(value: unknown): string {
  if (!hasPanelValue(value)) {
    return 'none'
  }

  const count = Array.isArray(value) ? value.length : 1
  const suffix = count === 1 ? 'block' : 'blocks'

  return `collapsed ${count} ${suffix}`
}

function formatLlmRequest(records: TraceDisplayRecord[]): string | undefined {
  const requests = records.filter(record => record.type === 'api.request_built')
  const assistantMessages = records.filter(
    record => record.type === 'api.assistant_message',
  )

  if (requests.length === 0 && assistantMessages.length === 0) {
    return undefined
  }

  const mainRequests = requests.filter(record => isMainRequest(record.payload))
  const sideRequests = requests.filter(record => !isMainRequest(record.payload))
  const lines: string[] = []

  const mainRequest = mainRequests[0]
  if (mainRequest !== undefined) {
    lines.push(`main: ${formatSingleLlmRequest(mainRequest.payload)}`)
  }

  if (sideRequests.length > 0) {
    lines.push(`side: ${sideRequests.map(formatSideRequest).join(' / ')}`)
  }

  if (assistantMessages.length > 0) {
    lines.push(`assistant: ${assistantMessages.length} message(s) collapsed`)
  }

  return lines.join('\n')
}

function isMainRequest(payload: unknown): boolean {
  if (!isRecord(payload)) {
    return false
  }

  const querySource = getStringField(payload, 'querySource')

  return (
    querySource === undefined ||
    querySource === 'repl_main_thread' ||
    querySource.startsWith('repl_main_thread:') ||
    querySource === 'sdk'
  )
}

function formatSingleLlmRequest(payload: unknown): string {
  if (!isRecord(payload)) {
    return 'unknown collapsed'
  }

  const model = getStringField(payload, 'model') ?? 'unknown-model'
  const source = getStringField(payload, 'querySource')
  const messageCount = getNumberField(payload, 'messageCount')
  const toolCount = getNumberField(payload, 'toolCount')
  const parts = [model]

  if (source !== undefined) {
    parts.push(`source=${source}`)
  }

  if (messageCount !== undefined) {
    parts.push(`messages=${messageCount}`)
  }

  if (toolCount !== undefined) {
    parts.push(`tools=${toolCount}`)
  }

  return parts.join(' ')
}

function formatSideRequest(record: TraceDisplayRecord): string {
  if (!isRecord(record.payload)) {
    return `${record.type} collapsed`
  }

  const querySource = getStringField(record.payload, 'querySource')
  const model = getStringField(record.payload, 'model')

  return `${querySource ?? model ?? record.type} collapsed`
}

function summarizeDecision(records: TraceDisplayRecord[]): string | undefined {
  const loopEnds = records.filter(record => record.type === 'query.loop_end')
  let turnEnd: TraceDisplayRecord | undefined
  for (let index = records.length - 1; index >= 0; index -= 1) {
    if (records[index]?.type === 'turn.end') {
      turnEnd = records[index]
      break
    }
  }

  if (loopEnds.length === 0 && turnEnd === undefined) {
    return undefined
  }

  const lines = loopEnds.map(record => summarizeLoopEnd(record.payload))

  if (turnEnd !== undefined) {
    lines.push(summarizeTurnEnd(turnEnd.payload))
  }

  return lines.join('\n')
}

function summarizeLoopEnd(payload: unknown): string {
  if (!isRecord(payload)) {
    return 'loop collapsed'
  }

  const parts: string[] = []
  const loopIndex = getNumberField(payload, 'loopIndex')
  const stopReason = getStringField(payload, 'stopReason')
  const toolUseCount = getNumberField(payload, 'toolUseCount')
  const toolResultCount = getNumberField(payload, 'toolResultCount')

  parts.push(loopIndex === undefined ? 'loop' : `loop=${loopIndex}`)

  if (stopReason !== undefined) {
    parts.push(`stop=${stopReason}`)
  }

  if (toolUseCount !== undefined) {
    parts.push(`toolUse=${toolUseCount}`)
  }

  if (toolResultCount !== undefined) {
    parts.push(`toolResult=${toolResultCount}`)
  }

  return parts.join(' ')
}

function summarizeTurnEnd(payload: unknown): string {
  if (!isRecord(payload)) {
    return 'turnEnd collapsed'
  }

  const parts = ['turnEnd']
  const durationMs = getNumberField(payload, 'durationMs')
  const status = getStringField(payload, 'status')

  if (status !== undefined) {
    parts.push(`status=${status}`)
  }

  if (durationMs !== undefined) {
    parts.push(`durationMs=${durationMs}`)
  }

  return parts.join(' ')
}

function summarizeTools(records: TraceDisplayRecord[]): string | undefined {
  const tools = records.filter(record => record.source === 'tool')

  return tools.length === 0
    ? undefined
    : tools.map(summarizeToolRecord).join('\n')
}

function summarizeToolRecord(record: TraceDisplayRecord): string {
  const payload = record.payload

  if (!isRecord(payload)) {
    return `${record.type} input=collapsed`
  }

  const toolName =
    getStringField(payload, 'toolName') ??
    getStringField(payload, 'name') ??
    getStringField(payload, 'tool') ??
    record.type
  const toolInput = getRecordField(payload, 'toolInput')
  const path =
    getStringField(toolInput, 'file_path') ??
    getStringField(toolInput, 'path') ??
    getStringField(payload, 'file_path') ??
    getStringField(payload, 'path')
  const status = getStringField(payload, 'status')
  const decision = getStringField(payload, 'decision')
  const ok = getBooleanField(payload, 'ok')
  const parts = [record.type, toolName]

  if (path !== undefined) {
    parts.push(`path=${formatPreview(path)}`)
  }

  if (status !== undefined) {
    parts.push(`status=${status}`)
  }

  if (decision !== undefined) {
    parts.push(`decision=${decision}`)
  }

  if (ok !== undefined) {
    parts.push(`ok=${ok}`)
  }

  parts.push(`input=${toolInput === undefined ? 'none' : 'collapsed'}`)

  return parts.join(' ')
}

function summarizeInternal(records: TraceDisplayRecord[]): string {
  const hookCount = records.filter(record => record.source === 'hook').length
  const subagentEventCount = records.filter(
    record => record.source === 'subagent',
  ).length
  const sideQueryRecords = records.filter(isSideQueryLifecycleRecord)
  const subagentQueryRecordCount = sideQueryRecords.filter(record =>
    isAgentRequest(record.payload),
  ).length
  const subagentCount = subagentEventCount + subagentQueryRecordCount
  const titleGenerationCount = sideQueryRecords.filter(record =>
    hasQuerySource(record.payload, 'generate_session_title'),
  ).length
  const memorySessionCount = sideQueryRecords.filter(record =>
    isMemoryOrSessionSideTask(record.payload),
  ).length

  return [
    `hooks=${hookCount} collapsed`,
    `subagents=${subagentCount} collapsed`,
    `titleGeneration=${titleGenerationCount} collapsed`,
    `memory/session=${memorySessionCount} collapsed`,
  ].join('\n')
}

function isSideQueryLifecycleRecord(record: TraceDisplayRecord): boolean {
  if (
    record.type !== 'api.request_built' &&
    record.type !== 'turn.start' &&
    record.type !== 'query.loop_start'
  ) {
    return false
  }

  return isSideQueryPayload(record.payload)
}

function isSideQueryPayload(payload: unknown): boolean {
  if (!isRecord(payload)) {
    return false
  }

  return (
    getStringField(payload, 'querySource') !== undefined &&
    !isMainRequest(payload)
  )
}

function hasQuerySource(payload: unknown, querySource: string): boolean {
  return (
    isRecord(payload) && getStringField(payload, 'querySource') === querySource
  )
}

function isMemoryOrSessionSideTask(payload: unknown): boolean {
  if (!isRecord(payload)) {
    return false
  }

  const querySource = getStringField(payload, 'querySource')
  if (querySource === undefined || querySource === 'generate_session_title') {
    return false
  }

  const normalized = querySource.toLowerCase()

  return normalized.includes('memory') || normalized.includes('session')
}

function isAgentRequest(payload: unknown): boolean {
  if (!isRecord(payload)) {
    return false
  }

  return getStringField(payload, 'querySource')?.startsWith('agent:') === true
}

function summarizeStore(records: TraceDisplayRecord[]): string {
  const transcriptEvents = records.filter(
    record => record.type === 'transcript.appended',
  )
  const sessionEvents = records.filter(record =>
    record.type.startsWith('trace.session_'),
  )
  const sessionTypes = [...new Set(sessionEvents.map(record => record.type))]

  return [
    `transcriptAppendCount=${transcriptEvents.length}`,
    `sessionEvents=${sessionEvents.length}${
      sessionTypes.length > 0 ? ` ${sessionTypes.join(',')} collapsed` : ''
    }`,
  ].join('\n')
}

function summarizeErrors(records: TraceDisplayRecord[]): string | undefined {
  const errors = records.filter(
    record =>
      record.type.endsWith('.error') ||
      record.type === 'api.retry' ||
      record.type === 'trace.read_error',
  )

  if (errors.length === 0) {
    return undefined
  }

  return errors.map(summarizeErrorRecord).join('\n')
}

function summarizeErrorRecord(record: TraceDisplayRecord): string {
  const payload = record.payload

  if (!isRecord(payload)) {
    return `${record.type} collapsed`
  }

  const message = getStringField(payload, 'message')
  const lineNumber = getNumberField(payload, 'lineNumber')
  const parts: string[] = [record.type]

  if (lineNumber !== undefined) {
    parts.push(`line=${lineNumber}`)
  }

  if (message !== undefined) {
    parts.push(formatPreview(message))
  } else {
    parts.push('collapsed')
  }

  return parts.join(' ')
}

function formatPreview(value: string): string {
  if (value.length <= MAX_PANEL_TEXT_CHARS) {
    return value
  }

  return `${value.slice(0, MAX_PANEL_TEXT_CHARS - 3)}...`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function toRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined
}

function getRecordField(
  record: Record<string, unknown> | undefined,
  key: string,
): Record<string, unknown> | undefined {
  if (record === undefined) {
    return undefined
  }

  const value = record[key]

  return isRecord(value) ? value : undefined
}

function getStringField(
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  if (record === undefined) {
    return undefined
  }

  const value = record[key]

  return typeof value === 'string' ? value : undefined
}

function getNumberField(
  record: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  if (record === undefined) {
    return undefined
  }

  const value = record[key]

  return typeof value === 'number' ? value : undefined
}

function getBooleanField(
  record: Record<string, unknown> | undefined,
  key: string,
): boolean | undefined {
  if (record === undefined) {
    return undefined
  }

  const value = record[key]

  return typeof value === 'boolean' ? value : undefined
}

function hasPanelValue(value: unknown): boolean {
  if (value === undefined || value === null) {
    return false
  }

  if (typeof value === 'string') {
    return value.length > 0
  }

  if (Array.isArray(value)) {
    return value.length > 0
  }

  if (isRecord(value)) {
    return Object.keys(value).length > 0
  }

  return true
}
