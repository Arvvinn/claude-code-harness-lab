import type { TraceDisplayRecord } from './format.js'
import { formatTraceLocalTime } from './time.js'

export type TraceLiveDepth = 'learn' | 'deep'
export type TraceDisplayLanguage = 'both' | 'zh' | 'en'

export interface TraceLiveStreamOptions {
  depth: TraceLiveDepth
  color?: boolean
  language?: TraceDisplayLanguage
}

type StreamStage =
  | 'TURN'
  | 'USER'
  | 'PREP'
  | 'LLM'
  | 'STREAM'
  | 'DECISION'
  | 'TOOL'
  | 'HOOK'
  | 'SIDE'
  | 'STORE'
  | 'DONE'
  | 'ERROR'

interface StageCopy {
  code: string
  zh: string
  en: string
}

const STAGE_COPY: Record<StreamStage, StageCopy> = {
  TURN: { code: 'TURN', zh: '轮次', en: 'Turn' },
  USER: { code: 'USER', zh: '用户输入', en: 'User Input' },
  PREP: { code: 'PREP', zh: '构造上下文', en: 'Context Prep' },
  LLM: { code: 'LLM', zh: '模型请求', en: 'Model Request' },
  STREAM: { code: 'STREAM', zh: '模型流', en: 'Model Stream' },
  DECISION: { code: 'DECISION', zh: '决策', en: 'Decision' },
  TOOL: { code: 'TOOL', zh: '工具', en: 'Tool' },
  HOOK: { code: 'HOOK', zh: '钩子', en: 'Hook' },
  SIDE: { code: 'SIDE', zh: '旁路任务', en: 'Side Task' },
  STORE: { code: 'STORE', zh: '记录写入', en: 'Storage' },
  DONE: { code: 'DONE', zh: '完成', en: 'Done' },
  ERROR: { code: 'ERROR', zh: '错误', en: 'Error' },
}

const STAGE_COLORS: Record<StreamStage, string> = {
  TURN: '1;36',
  USER: '36',
  PREP: '35',
  LLM: '33',
  STREAM: '93',
  DECISION: '1;37',
  TOOL: '32',
  HOOK: '95',
  SIDE: '90',
  STORE: '34',
  DONE: '32',
  ERROR: '31',
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
  learnInsideMainTurn: boolean
  learnMainTranscriptStoreEntryTypesSeen: Set<string>
  learnBetweenTranscriptStoreEntryTypesSeen: Set<string>
  learnSideTranscriptStoreEntryTypesSeenStack: Set<string>[]
  learnLoopBackRenderedBeforeLoopEnd: boolean
  color: boolean
  language: TraceDisplayLanguage
  hasRenderedVisibleTurn: boolean
  mainTurnHasReadableUser: boolean
  mainTurnHarnessContextRendered: boolean
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
    learnInsideMainTurn: false,
    learnMainTranscriptStoreEntryTypesSeen: new Set(),
    learnBetweenTranscriptStoreEntryTypesSeen: new Set(),
    learnSideTranscriptStoreEntryTypesSeenStack: [],
    learnLoopBackRenderedBeforeLoopEnd: false,
    color: options.color ?? false,
    language: options.language ?? 'both',
    hasRenderedVisibleTurn: false,
    mainTurnHasReadableUser: false,
    mainTurnHarnessContextRendered: false,
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
  const lines = renderRecordLines(record, state, depth)

  if (state.color && lines.length > 0) {
    lines.push(eventMetadataLine(record.type))
  }

  return lines
}

function renderRecordLines(
  record: TraceDisplayRecord,
  state: TraceLiveState,
  depth: TraceLiveDepth,
): string[] {
  const payload = getPayload(record)

  switch (record.type) {
    case 'trace.session_start':
    case 'trace.session_end':
      return renderTraceSession(record.type, state)
    case 'turn.start':
      return renderTurnStart(payload, state, depth)
    case 'query.loop_start':
      return renderQueryLoopStart(payload, state, depth)
    case 'api.request_built':
      return renderRequestBuilt(payload, state, depth)
    case 'api.stream_event':
      return renderStreamEvent(payload, state, depth)
    case 'tool.detected':
      return renderToolDetected(payload, state, depth)
    case 'tool.permission_result':
      return renderPermission(payload, depth, state)
    case 'tool.started':
      return renderToolStarted(payload, state)
    case 'tool.result':
    case 'tool.error':
    case 'tool.cancelled':
      return renderToolDone(record.type, payload, depth, state)
    case 'hook.started':
    case 'hook.result':
      return renderHook(record.type, payload, depth, state)
    case 'transcript.appended':
      return renderTranscriptAppend(payload, state, depth)
    case 'query.loop_end':
      return renderLoopEnd(payload, state, depth)
    case 'turn.end':
      return renderTurnEnd(payload, state, depth)
    case 'api.retry':
      return renderRetry(payload, state)
    case 'api.error':
    case 'trace.read_error':
      return stageLine(
        'ERROR',
        `${record.type} ${compactText(getString(payload, 'message')) ?? 'collapsed'}`,
        state,
      )
    default:
      return []
  }
}

function formatStageLabel(
  stage: StreamStage,
  language: TraceDisplayLanguage,
): string {
  const copy = STAGE_COPY[stage]

  if (language === 'en') {
    return `${copy.code} / ${copy.en}`
  }

  if (language === 'zh') {
    return `${copy.code} ${copy.zh}`
  }

  return `${copy.code} ${copy.zh} / ${copy.en}`
}

function stageLine(
  stage: StreamStage,
  text: string,
  state: Pick<TraceLiveState, 'color' | 'language'>,
): string[] {
  return [
    `  ${colorize(`[${formatStageLabel(stage, state.language)}]`, STAGE_COLORS[stage], state.color)} ${text}\n`,
  ]
}

function eventMetadataLine(eventType: string): string {
  return `    ${colorize(`event=${eventType}`, '90', true)}\n`
}

function colorize(text: string, code: string, enabled: boolean): string {
  return enabled ? `\x1b[${code}m${text}\x1b[0m` : text
}

function renderTurnStart(
  payload: Record<string, unknown>,
  state: TraceLiveState,
  depth: TraceLiveDepth,
): string[] {
  const querySource = getString(payload, 'querySource')

  if (!isMainQuerySource(querySource)) {
    if (depth === 'learn') {
      state.learnSideTranscriptStoreEntryTypesSeenStack.push(new Set())
    }

    return renderSideTurnStart(payload, querySource, depth, state)
  }

  state.turnNumber += 1
  state.learnInsideMainTurn = true
  state.learnLoopBackRenderedBeforeLoopEnd = false
  state.learnMainTranscriptStoreEntryTypesSeen.clear()
  state.learnBetweenTranscriptStoreEntryTypesSeen.clear()
  state.learnSideTranscriptStoreEntryTypesSeenStack.length = 0
  state.mainTurnHasReadableUser = false
  state.mainTurnHarnessContextRendered = false
  state.pendingMessageCounts = hasMessages(payload.messages)
    ? summarizeMessages(payload.messages)
    : undefined

  const extractedUserText =
    extractLatestUserText(payload.messages) ??
    compactText(getString(payload, 'prompt'))
  const userText = extractedUserText ?? 'input collapsed'
  state.mainTurnHasReadableUser = extractedUserText !== undefined
  const source = querySource ?? 'unknown'
  const prefix = state.hasRenderedVisibleTurn ? ['\n'] : []
  state.hasRenderedVisibleTurn = true
  const lines = stageLine('TURN', `${state.turnNumber} - ${userText}`, state)

  if (depth === 'learn') {
    lines.push(...stageLine('USER', userText, state))
    return [...prefix, ...lines]
  }

  lines.push(
    ...stageLine('USER', `INPUT source=${source} text=${userText}`, state),
  )
  if (hasHarnessContext(payload)) {
    lines.push(...stageLine('PREP', formatHarnessContext(payload), state))
    state.mainTurnHarnessContextRendered = true
  }

  return [...prefix, ...lines]
}

function renderQueryLoopStart(
  payload: Record<string, unknown>,
  state: TraceLiveState,
  depth: TraceLiveDepth,
): string[] {
  const querySource = getString(payload, 'querySource')

  if (!isMainQuerySource(querySource)) {
    return []
  }

  const lines: string[] = []
  const source = querySource ?? 'unknown'
  const userText =
    extractLatestUserText(payload.messages) ??
    compactText(getString(payload, 'prompt'))
  const messageCounts = hasMessages(payload.messages)
    ? summarizeMessages(payload.messages)
    : undefined
  const toolCount = getCount(payload, 'toolCount', 'tools') ?? 0

  if (!state.mainTurnHasReadableUser && userText !== undefined) {
    lines.push(
      ...(depth === 'learn'
        ? stageLine('USER', userText, state)
        : stageLine('USER', `INPUT source=${source} text=${userText}`, state)),
    )
    state.mainTurnHasReadableUser = true
  }

  if (messageCounts !== undefined && state.pendingMessageCounts === undefined) {
    lines.push(
      ...renderMessagePreparation(messageCounts, toolCount, state, depth),
    )
  }

  if (depth === 'deep') {
    if (!state.mainTurnHarnessContextRendered && hasHarnessContext(payload)) {
      lines.push(...stageLine('PREP', formatHarnessContext(payload), state))
      state.mainTurnHarnessContextRendered = true
    }
    lines.push(...stageLine('LLM', formatLoopStart(payload), state))
  }

  return lines
}

function renderSideTurnStart(
  payload: Record<string, unknown>,
  querySource: string | undefined,
  depth: TraceLiveDepth,
  state: Pick<TraceLiveState, 'color' | 'language'>,
): string[] {
  const source = formatSideSource(querySource ?? 'side')

  if (depth === 'learn') {
    return stageLine('SIDE', `${source} collapsed`, state)
  }

  const parts = [source]
  const model = getString(payload, 'model')
  const messageCount = getCount(payload, 'messageCount', 'messages')
  const toolCount = getCount(payload, 'toolCount', 'tools')

  if (model !== undefined) {
    parts.push(`model=${model}`)
  }

  if (messageCount !== undefined) {
    parts.push(`messages=${messageCount}`)
  }

  if (toolCount !== undefined) {
    parts.push(`tools=${toolCount}`)
  }

  if (parts.length === 1) {
    parts.push('collapsed')
  }

  return stageLine('SIDE', parts.join(' '), state)
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
    const source = formatSideSource(querySource ?? 'side')

    if (depth === 'learn') {
      return stageLine('SIDE', `${source} collapsed`, state)
    }

    return stageLine(
      'SIDE',
      `${source} model=${model} messages=${messageCount ?? 0} tools=${toolCount ?? 0}`,
      state,
    )
  }

  state.requestNumber += 1
  state.currentRequestNumber = state.requestNumber

  const lines = renderPreparedMessages(payload, state, depth)

  if (depth === 'learn') {
    lines.push(...stageLine('LLM', `request sent ${model}`, state))
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

  lines.push(...stageLine('LLM', requestParts.join(' '), state))
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

  return renderMessagePreparation(counts, toolCount, state, depth)
}

function renderMessagePreparation(
  counts: MessageCounts,
  toolCount: number,
  state: TraceLiveState,
  depth: TraceLiveDepth,
): string[] {
  state.pendingMessageCounts = undefined

  if (depth === 'learn') {
    return stageLine(
      'PREP',
      `messages[] prepared user=${counts.user} assistant=${counts.assistant} internal=${counts.internal} attachments=${counts.attachments} tools=${toolCount}`,
      state,
    )
  }

  return stageLine(
    'PREP',
    `HARNESS messages user=${counts.user} assistant=${counts.assistant} internal=${counts.internal} attachments=${counts.attachments} tools=${toolCount}`,
    state,
  )
}

function formatLoopStart(payload: Record<string, unknown>): string {
  const loopIndex = getNumber(payload, 'loopIndex') ?? 0
  const messageCount = getCount(payload, 'messageCount', 'messages') ?? 0
  const toolCount = getCount(payload, 'toolCount', 'tools') ?? 0
  const querySource = getString(payload, 'querySource') ?? 'unknown'
  const parts = [
    `LOOP #${loopIndex}`,
    `messages=${messageCount}`,
    `tools=${toolCount}`,
    `querySource=${querySource}`,
  ]
  const abortController = getBoolean(payload, 'hasAbortController')

  if (abortController !== undefined) {
    parts.push(`abortController=${abortController}`)
  }

  return parts.join(' ')
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
    return stageLine(
      'STREAM',
      `#${state.currentRequestNumber} content_block_delta ${deltaType}`,
      state,
    )
  }

  if (eventType === 'message_start') {
    return depth === 'learn'
      ? stageLine('STREAM', 'stream started', state)
      : stageLine(
          'STREAM',
          `#${state.currentRequestNumber} message_start`,
          state,
        )
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

    return stageLine(
      'STREAM',
      `#${state.currentRequestNumber} message_delta${suffix}`,
      state,
    )
  }

  return depth === 'learn'
    ? []
    : stageLine('STREAM', `#${state.currentRequestNumber} ${eventType}`, state)
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
      ? stageLine('STREAM', `tool_use requested ${toolName}`, state)
      : stageLine(
          'STREAM',
          `#${state.currentRequestNumber} content_block_start tool_use ${toolName}`,
          state,
        )
  }

  if (depth === 'learn') {
    return []
  }

  const suffix = blockName === undefined ? '' : ` ${blockName}`
  return stageLine(
    'STREAM',
    `#${state.currentRequestNumber} content_block_start ${blockType}${suffix}`,
    state,
  )
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
    ? stageLine('STREAM', `tool_use requested ${toolName}`, state)
    : stageLine('STREAM', `tool_use detected ${toolName}`, state)
}

function renderPermission(
  payload: Record<string, unknown>,
  depth: TraceLiveDepth,
  state: Pick<TraceLiveState, 'color' | 'language'>,
): string[] {
  if (depth === 'learn') {
    return []
  }

  const toolName = getToolName(payload)
  const decision = getString(payload, 'decision') ?? 'unknown'
  const source = getString(payload, 'source')
  const durationMs = getNumber(payload, 'durationMs')
  const parts = [`${toolName} permission ${decision}`]

  if (source !== undefined) {
    parts.push(`source=${source}`)
  }

  if (durationMs !== undefined) {
    parts.push(`duration=${durationMs}ms`)
  }

  return stageLine('TOOL', parts.join(' '), state)
}

function renderToolStarted(
  payload: Record<string, unknown>,
  state: Pick<TraceLiveState, 'color' | 'language'>,
): string[] {
  const toolName = getToolName(payload)
  const parts = [`${toolName} started`]
  const path = getToolPath(payload)

  if (path !== undefined) {
    parts.push(`path=${path}`)
  }

  return stageLine('TOOL', parts.join(' '), state)
}

function renderToolDone(
  eventType: TraceDisplayRecord['type'],
  payload: Record<string, unknown>,
  depth: TraceLiveDepth,
  state: Pick<TraceLiveState, 'color' | 'language'>,
): string[] {
  const toolName = getToolName(payload)
  const status = getToolStatus(eventType, payload)
  const parts =
    depth === 'deep'
      ? [`${toolName} result ${status}`]
      : [`${toolName} ${status}`]
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

  return stageLine('TOOL', parts.join(' '), state)
}

function renderHook(
  eventType: TraceDisplayRecord['type'],
  payload: Record<string, unknown>,
  depth: TraceLiveDepth,
  state: Pick<TraceLiveState, 'color' | 'language'>,
): string[] {
  const hookEvent =
    getString(payload, 'hookEvent') ??
    getString(payload, 'hookEventName') ??
    'Hook'

  if (eventType === 'hook.started') {
    return depth === 'deep'
      ? stageLine('HOOK', `${hookEvent} started`, state)
      : []
  }

  const status = getString(payload, 'status')
  const durationMs = getNumber(payload, 'durationMs')

  if (depth === 'learn' && status === undefined && durationMs === undefined) {
    return []
  }

  const parts = [hookEvent, formatHookStatus(status)]

  if (durationMs !== undefined) {
    parts.push(`duration=${durationMs}ms`)
  }

  return stageLine('HOOK', parts.join(' '), state)
}

function renderTranscriptAppend(
  payload: Record<string, unknown>,
  state: TraceLiveState,
  depth: TraceLiveDepth,
): string[] {
  const entryType = getString(payload, 'entryType') ?? 'entry'

  const lines: string[] = []

  if (depth === 'learn' && entryType === 'tool_result') {
    if (!state.learnLoopBackRenderedBeforeLoopEnd) {
      lines.push(
        ...stageLine(
          'DECISION',
          'tool_result appended, loop back to LLM',
          state,
        ),
      )
      state.learnLoopBackRenderedBeforeLoopEnd = true
    }
  }

  if (!shouldRenderTranscriptStoreEntry(entryType)) {
    return lines
  }

  if (depth === 'learn') {
    const seenEntryTypes = getLearnTranscriptStoreEntryTypesSeen(state)

    if (seenEntryTypes.has(entryType)) {
      return lines
    }

    seenEntryTypes.add(entryType)
  }

  const byteCount = getNumber(payload, 'byteCount')
  const parts = [`transcript appended entry=${entryType}`]

  if (byteCount !== undefined) {
    parts.push(`bytes=${byteCount}`)
  }

  lines.push(...stageLine('STORE', parts.join(' '), state))
  return lines
}

function renderTraceSession(
  eventType: 'trace.session_start' | 'trace.session_end',
  state: Pick<TraceLiveState, 'color' | 'language'>,
): string[] {
  const sessionEvent =
    eventType === 'trace.session_start' ? 'session_start' : 'session_end'

  return stageLine('STORE', `trace ${sessionEvent}`, state)
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

      return stageLine(
        'DECISION',
        'tool_result appended, loop back to LLM',
        state,
      )
    }

    state.learnLoopBackRenderedBeforeLoopEnd = false
    return stageLine('DECISION', `LOOP ${stopReason}`, state)
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

  return stageLine('DECISION', parts.join(' '), state)
}

function renderRetry(
  payload: Record<string, unknown>,
  state: Pick<TraceLiveState, 'color' | 'language'>,
): string[] {
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

  return stageLine(
    'LLM',
    parts.length === 1 ? 'RETRY api retry collapsed' : parts.join(' '),
    state,
  )
}

function renderTurnEnd(
  payload: Record<string, unknown>,
  state: TraceLiveState,
  depth: TraceLiveDepth,
): string[] {
  const resultReason = getTurnEndResultReason(payload)
  const durationMs = getNumber(payload, 'durationMs')

  if (depth === 'learn') {
    const duration =
      formatHumanDurationMs(durationMs) === undefined
        ? ''
        : ` duration=${formatHumanDurationMs(durationMs)}`

    const lines = stageLine('DONE', `${resultReason}${duration}`, state)

    updateLearnTranscriptStoreScopeOnTurnEnd(payload, state)
    return lines
  }

  const parts = [resultReason]

  if (durationMs !== undefined) {
    parts.push(`duration=${durationMs}ms`)
  }

  const finalMessageCount = getNumber(payload, 'finalMessageCount')
  if (finalMessageCount !== undefined) {
    parts.push(`finalMessages=${finalMessageCount}`)
  }

  return stageLine('DONE', parts.join(' '), state)
}

function getLearnTranscriptStoreEntryTypesSeen(
  state: TraceLiveState,
): Set<string> {
  const sideEntryTypesSeen =
    state.learnSideTranscriptStoreEntryTypesSeenStack[
      state.learnSideTranscriptStoreEntryTypesSeenStack.length - 1
    ]

  if (sideEntryTypesSeen !== undefined) {
    return sideEntryTypesSeen
  }

  return state.learnInsideMainTurn
    ? state.learnMainTranscriptStoreEntryTypesSeen
    : state.learnBetweenTranscriptStoreEntryTypesSeen
}

function updateLearnTranscriptStoreScopeOnTurnEnd(
  payload: Record<string, unknown>,
  state: TraceLiveState,
): void {
  const querySource = getString(payload, 'querySource')
  const isSideTurnEnd =
    querySource === undefined
      ? state.learnSideTranscriptStoreEntryTypesSeenStack.length > 0
      : !isMainQuerySource(querySource)

  if (isSideTurnEnd) {
    state.learnSideTranscriptStoreEntryTypesSeenStack.pop()
    return
  }

  state.learnInsideMainTurn = false
  state.learnBetweenTranscriptStoreEntryTypesSeen.clear()
  state.learnSideTranscriptStoreEntryTypesSeenStack.length = 0
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

function hasHarnessContext(payload: Record<string, unknown>): boolean {
  return (
    hasValue(payload.systemPrompt) ||
    hasValue(payload.userContext) ||
    hasValue(payload.systemContext)
  )
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

function hasMessages(messages: unknown): boolean {
  return Array.isArray(messages) && messages.length > 0
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

function formatSideSource(source: string): string {
  if (
    source === 'generate_session_title' ||
    source === 'prompt_suggestion' ||
    source === 'away_summary' ||
    source === 'extract_memories' ||
    source === 'session_memory'
  ) {
    return source
  }

  if (/^[A-Za-z0-9_.:-]{1,64}$/.test(source)) {
    return source
  }

  return 'unknown_side'
}

// STORE summaries are intentionally shape-only. Known transcript entries are
// useful lifecycle signals; metadata-like entries such as title/tag are omitted
// because echoing opaque fields can leak body text or file paths.
function shouldRenderTranscriptStoreEntry(entryType: string): boolean {
  return (
    entryType === 'user' ||
    entryType === 'assistant' ||
    entryType === 'attachment' ||
    entryType === 'tool_result' ||
    entryType === 'system'
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
