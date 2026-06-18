import type { TraceDisplayRecord } from './format.js'
import { formatTraceLocalTime } from './time.js'

export type TraceLiveDepth = 'learn' | 'deep'

export interface TraceLiveStreamOptions {
  depth: TraceLiveDepth
}

export interface TraceLiveHeaderOptions {
  depth: TraceLiveDepth
  sessionId: string
  eventsPath: string
  startedAt?: string
  timeZone?: string
}

export interface TraceLiveStream {
  renderRecord(record: TraceDisplayRecord): string[]
}

interface MessageCounts {
  user: number
  assistant: number
  internal: number
  attachments: number
}

interface TraceLiveState {
  turnNumber: number
  requestNumber: number
  currentRequestNumber: number
  shownToolUseIds: Set<string>
  learnLoopBackRenderedBeforeLoopEnd: boolean
  pendingMessageCounts?: MessageCounts
}

export function renderTraceLiveHeader(options: TraceLiveHeaderOptions): string {
  const title =
    options.depth === 'deep' ? 'Trace Live - Deep' : 'Trace Live - Learn'
  const startedAt = formatTraceLocalTime(
    options.startedAt ?? new Date().toISOString(),
    options.timeZone === undefined ? {} : { timeZone: options.timeZone },
  )

  return [
    title,
    `Started: ${startedAt}`,
    `Session: ${options.sessionId}`,
    `Source: ${options.eventsPath}`,
    '',
  ].join('\n')
}

export function createTraceLiveStream(
  options: TraceLiveStreamOptions,
): TraceLiveStream {
  const state: TraceLiveState = {
    turnNumber: 0,
    requestNumber: 0,
    currentRequestNumber: 0,
    shownToolUseIds: new Set(),
    learnLoopBackRenderedBeforeLoopEnd: false,
  }

  return {
    renderRecord(record) {
      return renderRecord(record, state, options.depth)
    },
  }
}

function renderRecord(
  record: TraceDisplayRecord,
  state: TraceLiveState,
  depth: TraceLiveDepth,
): string[] {
  const payload = getPayload(record)

  switch (record.type) {
    case 'turn.start':
      return renderTurnStart(payload, state, depth)
    case 'api.request_built':
      return renderRequestBuilt(payload, state, depth)
    case 'api.stream_event':
      return renderStreamEvent(payload, state, depth)
    case 'tool.detected':
      return renderToolDetected(payload, state, depth)
    case 'tool.permission_result':
      return renderPermission(payload, depth)
    case 'tool.started':
      return renderToolStarted(payload)
    case 'tool.result':
    case 'tool.error':
    case 'tool.cancelled':
      return renderToolDone(record.type, payload, depth)
    case 'hook.started':
    case 'hook.result':
      return renderHook(record.type, payload, depth)
    case 'transcript.appended':
      return renderTranscriptAppend(payload, state, depth)
    case 'query.loop_end':
      return renderLoopEnd(payload, state, depth)
    case 'turn.end':
      return renderTurnEnd(payload, depth)
    case 'api.retry':
      return renderRetry(payload)
    case 'api.error':
    case 'trace.read_error':
      return [
        `  ERROR ${record.type} ${compactText(getString(payload, 'message')) ?? 'collapsed'}\n`,
      ]
    default:
      return []
  }
}

function renderTurnStart(
  payload: Record<string, unknown>,
  state: TraceLiveState,
  depth: TraceLiveDepth,
): string[] {
  const querySource = getString(payload, 'querySource')

  if (!isMainQuerySource(querySource)) {
    return renderSideTurnStart(payload, querySource, depth)
  }

  state.turnNumber += 1
  state.learnLoopBackRenderedBeforeLoopEnd = false
  state.pendingMessageCounts = summarizeMessages(payload.messages)

  const userText =
    extractLatestUserText(payload.messages) ??
    compactText(getString(payload, 'prompt')) ??
    'input collapsed'
  const source = querySource ?? 'unknown'
  const lines = [`TURN ${state.turnNumber} - ${userText}\n`]

  if (depth === 'learn') {
    lines.push(`  USER ${userText}\n`)
    return lines
  }

  lines.push(`  USER INPUT source=${source} text=${userText}\n`)
  lines.push(`  ${formatHarnessContext(payload)}\n`)

  return lines
}

function renderSideTurnStart(
  payload: Record<string, unknown>,
  querySource: string | undefined,
  depth: TraceLiveDepth,
): string[] {
  const source = querySource ?? 'side'

  if (depth === 'learn') {
    return [`  SIDE ${source} collapsed\n`]
  }

  const parts = [`SIDE ${source}`]
  const messageCount = getCount(payload, 'messageCount', 'messages')
  const toolCount = getCount(payload, 'toolCount', 'tools')

  if (messageCount !== undefined) {
    parts.push(`messages=${messageCount}`)
  }

  if (toolCount !== undefined) {
    parts.push(`tools=${toolCount}`)
  }

  if (parts.length === 1) {
    parts.push('collapsed')
  }

  return [`  ${parts.join(' ')}\n`]
}

function renderRequestBuilt(
  payload: Record<string, unknown>,
  state: TraceLiveState,
  depth: TraceLiveDepth,
): string[] {
  const querySource = getString(payload, 'querySource')
  const model = getString(payload, 'model') ?? 'unknown-model'
  const messageCount = getCount(payload, 'messageCount', 'messages')
  const toolCount = getCount(payload, 'toolCount', 'tools')

  if (!isMainQuerySource(querySource)) {
    const source = querySource ?? 'side'

    if (depth === 'learn') {
      return [`  SIDE ${source} collapsed\n`]
    }

    return [
      `  SIDE ${source} model=${model} messages=${messageCount ?? 0} tools=${toolCount ?? 0}\n`,
    ]
  }

  state.requestNumber += 1
  state.currentRequestNumber = state.requestNumber

  const lines = renderPreparedMessages(payload, state, depth)

  if (depth === 'learn') {
    lines.push(`  LLM request sent ${model}\n`)
    return lines
  }

  const provider = getString(payload, 'provider') ?? 'unknown-provider'
  const source = querySource ?? 'unknown'
  const requestParts = [
    `REQUEST #${state.requestNumber}`,
    `provider=${provider}`,
    `model=${model}`,
    `querySource=${source}`,
  ]

  if (messageCount !== undefined) {
    requestParts.push(`messages=${messageCount}`)
  }

  if (toolCount !== undefined) {
    requestParts.push(`tools=${toolCount}`)
  }

  const maxTokens = getNumber(payload, 'maxTokens')
  if (maxTokens !== undefined) {
    requestParts.push(`maxTokens=${maxTokens}`)
  }

  const effort = getString(payload, 'effort')
  if (effort !== undefined) {
    requestParts.push(`effort=${effort}`)
  }

  lines.push(`  ${requestParts.join(' ')}\n`)
  return lines
}

function renderPreparedMessages(
  payload: Record<string, unknown>,
  state: TraceLiveState,
  depth: TraceLiveDepth,
): string[] {
  const counts = state.pendingMessageCounts
  if (counts === undefined) {
    return []
  }

  state.pendingMessageCounts = undefined
  const toolCount = getCount(payload, 'toolCount', 'tools') ?? 0

  if (depth === 'learn') {
    return [
      `  LOOP messages[] prepared user=${counts.user} assistant=${counts.assistant} internal=${counts.internal} attachments=${counts.attachments} tools=${toolCount}\n`,
    ]
  }

  return [
    `  HARNESS messages user=${counts.user} assistant=${counts.assistant} internal=${counts.internal} attachments=${counts.attachments} tools=${toolCount}\n`,
  ]
}

function renderStreamEvent(
  payload: Record<string, unknown>,
  state: TraceLiveState,
  depth: TraceLiveDepth,
): string[] {
  const eventType = getString(payload, 'eventType') ?? 'stream_event'

  if (eventType === 'content_block_delta') {
    if (depth === 'learn') {
      return []
    }

    const deltaType = getString(payload, 'deltaType') ?? 'delta'
    return [
      `  STREAM #${state.currentRequestNumber} content_block_delta ${deltaType}\n`,
    ]
  }

  if (eventType === 'message_start') {
    return depth === 'learn'
      ? ['  LLM stream started\n']
      : [`  STREAM #${state.currentRequestNumber} message_start\n`]
  }

  if (eventType === 'content_block_start') {
    return renderContentBlockStart(payload, state, depth)
  }

  if (eventType === 'message_delta') {
    if (depth === 'learn') {
      return []
    }

    const stopReason = getString(payload, 'stopReason')
    const suffix = stopReason === undefined ? '' : ` stop_reason=${stopReason}`

    return [`  STREAM #${state.currentRequestNumber} message_delta${suffix}\n`]
  }

  return depth === 'learn'
    ? []
    : [`  STREAM #${state.currentRequestNumber} ${eventType}\n`]
}

function renderContentBlockStart(
  payload: Record<string, unknown>,
  state: TraceLiveState,
  depth: TraceLiveDepth,
): string[] {
  const blockType = getString(payload, 'contentBlockType') ?? 'block'
  const blockName =
    getString(payload, 'toolName') ?? getString(payload, 'contentBlockName')
  const blockId = getString(payload, 'contentBlockId')

  if (blockType === 'tool_use') {
    if (blockId !== undefined) {
      state.shownToolUseIds.add(blockId)
    }

    const toolName = blockName ?? 'unknown'

    return depth === 'learn'
      ? [`  LLM tool_use requested ${toolName}\n`]
      : [
          `  STREAM #${state.currentRequestNumber} content_block_start tool_use ${toolName}\n`,
        ]
  }

  if (depth === 'learn') {
    return []
  }

  const suffix = blockName === undefined ? '' : ` ${blockName}`
  return [
    `  STREAM #${state.currentRequestNumber} content_block_start ${blockType}${suffix}\n`,
  ]
}

function renderToolDetected(
  payload: Record<string, unknown>,
  state: TraceLiveState,
  depth: TraceLiveDepth,
): string[] {
  const toolUseId = getString(payload, 'toolUseId')

  if (toolUseId !== undefined && state.shownToolUseIds.has(toolUseId)) {
    return []
  }

  if (toolUseId !== undefined) {
    state.shownToolUseIds.add(toolUseId)
  }

  const toolName = getToolName(payload)

  return depth === 'learn'
    ? [`  LLM tool_use requested ${toolName}\n`]
    : [`  TOOL ${toolName} detected\n`]
}

function renderPermission(
  payload: Record<string, unknown>,
  depth: TraceLiveDepth,
): string[] {
  if (depth === 'learn') {
    return []
  }

  const toolName = getToolName(payload)
  const decision = getString(payload, 'decision') ?? 'unknown'
  const source = getString(payload, 'source')
  const durationMs = getNumber(payload, 'durationMs')
  const parts = [`TOOL ${toolName} permission ${decision}`]

  if (source !== undefined) {
    parts.push(`source=${source}`)
  }

  if (durationMs !== undefined) {
    parts.push(`duration=${durationMs}ms`)
  }

  return [`  ${parts.join(' ')}\n`]
}

function renderToolStarted(payload: Record<string, unknown>): string[] {
  const toolName = getToolName(payload)
  const parts = [`TOOL ${toolName} started`]
  const path = getToolPath(payload)

  if (path !== undefined) {
    parts.push(`path=${path}`)
  }

  return [`  ${parts.join(' ')}\n`]
}

function renderToolDone(
  eventType: TraceDisplayRecord['type'],
  payload: Record<string, unknown>,
  depth: TraceLiveDepth,
): string[] {
  const toolName = getToolName(payload)
  const status = getToolStatus(eventType, payload)
  const parts =
    depth === 'deep'
      ? [`TOOL ${toolName} result ${status}`]
      : [`TOOL ${toolName} ${status}`]
  const durationMs = getNumber(payload, 'durationMs')

  if (durationMs !== undefined) {
    parts.push(`duration=${durationMs}ms`)
  }

  const sizeBytes =
    getNumber(payload, 'toolResultSizeBytes') ??
    getNumber(payload, 'resultSizeBytes') ??
    getNumber(payload, 'sizeBytes')

  if (sizeBytes !== undefined) {
    parts.push(`size=${sizeBytes}B`)
  }

  return [`  ${parts.join(' ')}\n`]
}

function renderHook(
  eventType: TraceDisplayRecord['type'],
  payload: Record<string, unknown>,
  depth: TraceLiveDepth,
): string[] {
  const hookEvent =
    getString(payload, 'hookEvent') ??
    getString(payload, 'hookEventName') ??
    'Hook'

  if (eventType === 'hook.started') {
    return depth === 'deep' ? [`  HOOK ${hookEvent} started\n`] : []
  }

  const status = getString(payload, 'status')
  const durationMs = getNumber(payload, 'durationMs')

  if (depth === 'learn' && status === undefined && durationMs === undefined) {
    return []
  }

  const parts = [`HOOK ${hookEvent}`, formatHookStatus(status)]

  if (durationMs !== undefined) {
    parts.push(`duration=${durationMs}ms`)
  }

  return [`  ${parts.join(' ')}\n`]
}

function renderTranscriptAppend(
  payload: Record<string, unknown>,
  state: TraceLiveState,
  depth: TraceLiveDepth,
): string[] {
  const entryType = getString(payload, 'entryType') ?? 'entry'

  if (depth === 'learn') {
    if (entryType !== 'tool_result') {
      return []
    }

    if (state.learnLoopBackRenderedBeforeLoopEnd) {
      return []
    }

    state.learnLoopBackRenderedBeforeLoopEnd = true
    return ['  LOOP tool_result appended, loop back to LLM\n']
  }

  const byteCount = getNumber(payload, 'byteCount')
  const suffix = byteCount === undefined ? '' : ` bytes=${byteCount}`

  return [`  HARNESS transcript appended ${entryType}${suffix}\n`]
}

function renderLoopEnd(
  payload: Record<string, unknown>,
  state: TraceLiveState,
  depth: TraceLiveDepth,
): string[] {
  const stopReason = getString(payload, 'stopReason') ?? 'loop_end'

  if (depth === 'learn') {
    if (stopReason === 'next_turn') {
      if (state.learnLoopBackRenderedBeforeLoopEnd) {
        state.learnLoopBackRenderedBeforeLoopEnd = false
        return []
      }

      return ['  LOOP tool_result appended, loop back to LLM\n']
    }

    state.learnLoopBackRenderedBeforeLoopEnd = false
    return [`  LOOP ${stopReason}\n`]
  }

  const loopIndex = getNumber(payload, 'loopIndex') ?? 0
  const toolUseCount = getNumber(payload, 'toolUseCount')
  const toolResultCount = getNumber(payload, 'toolResultCount')
  const durationMs = getNumber(payload, 'durationMs')
  const parts = [`LOOP #${loopIndex} ${stopReason}`]

  if (toolUseCount !== undefined) {
    parts.push(`toolUse=${toolUseCount}`)
  }

  if (toolResultCount !== undefined) {
    parts.push(`toolResult=${toolResultCount}`)
  }

  if (durationMs !== undefined) {
    parts.push(`duration=${durationMs}ms`)
  }

  return [`  ${parts.join(' ')}\n`]
}

function renderRetry(payload: Record<string, unknown>): string[] {
  const retryType = getString(payload, 'retryType') ?? 'api retry'
  const parts = [`RETRY ${retryType}`]

  appendNumberPart(parts, 'attempt', getNumber(payload, 'attempt'))
  appendNumberPart(parts, 'maxRetries', getNumber(payload, 'maxRetries'))
  appendStringPart(parts, 'model', getString(payload, 'model'))
  appendStringPart(parts, 'provider', getString(payload, 'provider'))
  appendNumberPart(parts, 'status', getNumber(payload, 'status'))
  appendStringPart(parts, 'error', getString(payload, 'errorName'))
  appendNumberPart(parts, 'retryInMs', getNumber(payload, 'retryInMs'))
  appendStringPart(parts, 'requestId', getString(payload, 'requestId'))
  appendStringPart(
    parts,
    'clientRequestId',
    getString(payload, 'clientRequestId'),
  )
  appendStringPart(parts, 'fallbackModel', getString(payload, 'fallbackModel'))
  appendNumberPart(
    parts,
    'adjustedMaxTokens',
    getNumber(payload, 'adjustedMaxTokens'),
  )

  return [
    `  ${parts.length === 1 ? 'RETRY api retry collapsed' : parts.join(' ')}\n`,
  ]
}

function renderTurnEnd(
  payload: Record<string, unknown>,
  depth: TraceLiveDepth,
): string[] {
  const resultReason = getTurnEndResultReason(payload)
  const durationMs = getNumber(payload, 'durationMs')

  if (depth === 'learn') {
    const duration =
      formatHumanDurationMs(durationMs) === undefined
        ? ''
        : ` duration=${formatHumanDurationMs(durationMs)}`

    return [`  DONE ${resultReason}${duration}\n`]
  }

  const parts = [`DONE ${resultReason}`]

  if (durationMs !== undefined) {
    parts.push(`duration=${durationMs}ms`)
  }

  const finalMessageCount = getNumber(payload, 'finalMessageCount')
  if (finalMessageCount !== undefined) {
    parts.push(`finalMessages=${finalMessageCount}`)
  }

  return [`  ${parts.join(' ')}\n`]
}

function getTurnEndResultReason(payload: Record<string, unknown>): string {
  const resultReason = getString(payload, 'resultReason')
  if (resultReason !== undefined) {
    return resultReason
  }

  const status = getString(payload, 'status')
  if (status !== undefined) {
    return status
  }

  const stopReason = getString(payload, 'stopReason')
  if (stopReason !== undefined) {
    return stopReason
  }

  if (getBoolean(payload, 'aborted') === true) {
    return 'aborted'
  }

  if (
    getBoolean(payload, 'error') === true ||
    getBoolean(payload, 'success') === false
  ) {
    return 'error'
  }

  return 'completed'
}

function formatHarnessContext(payload: Record<string, unknown>): string {
  return [
    `HARNESS context systemPrompt=${formatBlockCount(payload.systemPrompt)}`,
    `userContext=${formatCollapsedValue(payload.userContext)}`,
    `systemContext=${formatCollapsedValue(payload.systemContext)}`,
  ].join(' ')
}

function summarizeMessages(messages: unknown): MessageCounts {
  const counts: MessageCounts = {
    user: 0,
    assistant: 0,
    internal: 0,
    attachments: 0,
  }

  if (!Array.isArray(messages)) {
    return counts
  }

  for (const message of messages) {
    if (!isRecord(message)) {
      counts.internal += 1
      continue
    }

    const type = getString(message, 'type') ?? getString(message, 'role')
    if (type === 'user') {
      counts.user += 1
    } else if (type === 'assistant') {
      counts.assistant += 1
    } else if (
      type === 'attachment' ||
      type === 'hook' ||
      Object.hasOwn(message, 'attachment') ||
      Object.hasOwn(message, 'hook')
    ) {
      counts.attachments += 1
    } else {
      counts.internal += 1
    }
  }

  return counts
}

function extractLatestUserText(messages: unknown): string | undefined {
  if (!Array.isArray(messages)) {
    return undefined
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!isRecord(message)) {
      continue
    }

    if ((getString(message, 'type') ?? getString(message, 'role')) !== 'user') {
      continue
    }

    const inner = message.message
    if (!isRecord(inner)) {
      continue
    }

    const content = inner.content
    if (typeof content === 'string') {
      return compactText(content)
    }

    if (Array.isArray(content)) {
      const text = content
        .filter(isRecord)
        .map(block =>
          getString(block, 'type') === 'text'
            ? getString(block, 'text')
            : undefined,
        )
        .find(value => value !== undefined)

      return compactText(text)
    }
  }

  return undefined
}

function getPayload(record: TraceDisplayRecord): Record<string, unknown> {
  return isRecord(record.payload) ? record.payload : {}
}

function isMainQuerySource(querySource: string | undefined): boolean {
  return (
    querySource === undefined ||
    querySource === 'repl_main_thread' ||
    querySource.startsWith('repl_main_thread:') ||
    querySource === 'sdk'
  )
}

function getToolName(payload: Record<string, unknown>): string {
  return (
    getString(payload, 'toolName') ??
    getString(payload, 'name') ??
    getString(payload, 'tool') ??
    'unknown'
  )
}

function getToolPath(payload: Record<string, unknown>): string | undefined {
  const toolInput = getRecord(payload, 'toolInput')

  return (
    getString(toolInput, 'file_path') ??
    getString(toolInput, 'path') ??
    getString(payload, 'file_path') ??
    getString(payload, 'path')
  )
}

function getToolStatus(
  eventType: TraceDisplayRecord['type'],
  payload: Record<string, unknown>,
): string {
  const status = getString(payload, 'status')
  if (status !== undefined) {
    return status
  }

  const ok = getBoolean(payload, 'ok')
  if (ok !== undefined) {
    return ok ? 'ok' : 'error'
  }

  if (eventType === 'tool.cancelled') {
    return 'cancelled'
  }

  return eventType === 'tool.error' ? 'error' : 'ok'
}

function formatHookStatus(status: string | undefined): string {
  if (
    status === undefined ||
    status === 'completed' ||
    status === 'ok' ||
    status === 'success'
  ) {
    return 'done'
  }

  return status
}

function formatBlockCount(value: unknown): string {
  const count = Array.isArray(value) ? value.length : hasValue(value) ? 1 : 0
  const suffix = count === 1 ? 'block' : 'blocks'

  return `${count} ${suffix}`
}

function formatCollapsedValue(value: unknown): string {
  return hasValue(value) ? 'collapsed' : 'none'
}

function hasValue(value: unknown): boolean {
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

function getCount(
  payload: Record<string, unknown>,
  countKey: string,
  arrayKey: string,
): number | undefined {
  const count = getNumber(payload, countKey)
  if (count !== undefined) {
    return count
  }

  const value = payload[arrayKey]

  return Array.isArray(value) ? value.length : undefined
}

function appendStringPart(
  parts: string[],
  key: string,
  value: string | undefined,
): void {
  if (value !== undefined) {
    parts.push(`${key}=${value}`)
  }
}

function appendNumberPart(
  parts: string[],
  key: string,
  value: number | undefined,
): void {
  if (value !== undefined) {
    parts.push(`${key}=${value}`)
  }
}

function formatHumanDurationMs(
  durationMs: number | undefined,
): string | undefined {
  if (durationMs === undefined) {
    return undefined
  }

  if (durationMs >= 1000) {
    return `${(durationMs / 1000).toFixed(1)}s`
  }

  return `${durationMs}ms`
}

function compactText(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined
  }

  const normalized = value.replace(/\s+/g, ' ').trim()

  return normalized.length <= 120
    ? normalized
    : `${normalized.slice(0, 117)}...`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function getRecord(
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const value = record[key]

  return isRecord(value) ? value : undefined
}

function getString(
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  if (record === undefined) {
    return undefined
  }

  const value = record[key]
  return typeof value === 'string' ? value : undefined
}

function getNumber(
  record: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = record[key]
  return typeof value === 'number' ? value : undefined
}

function getBoolean(
  record: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = record[key]
  return typeof value === 'boolean' ? value : undefined
}
