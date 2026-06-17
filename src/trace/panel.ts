import type { TraceDisplayRecord } from './format.js'

type PanelSection =
  | 'USER'
  | 'SYSTEM'
  | 'MESSAGES'
  | 'LLM'
  | 'DECISION'
  | 'TOOL'
  | 'HOOK'
  | 'SUBAGENT'
  | 'STORE'
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
  HOOK: '95',
  SUBAGENT: '96',
  STORE: '90',
  ERROR: '31',
}

const AGENT_LOOP_PATTERN =
  'User -> messages[] -> LLM -> stop_reason/tool_use decision -> tools -> append results -> loop back/return text'

const LLM_REQUEST_SUMMARY_KEYS = [
  'provider',
  'model',
  'querySource',
  'attempt',
  'messageCount',
  'toolCount',
  'betaCount',
  'betaFlags',
  'maxTokens',
  'thinkingType',
  'toolChoiceType',
  'outputFormatType',
  'effort',
  'speed',
  'hasTemperature',
  'clientRequestId',
  'previousRequestId',
] as const

const ASSISTANT_MESSAGE_SUMMARY_KEYS = [
  'provider',
  'model',
  'messageId',
  'requestId',
  'attempt',
  'durationMs',
  'stopReason',
  'contentBlockCount',
  'usage',
] as const

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

  const userInput = findLatestPayloadValue(records, 'messages')
  const systemPrompt = findLatestPayloadValue(records, 'systemPrompt')
  const userContext = findLatestPayloadValue(records, 'userContext')
  const systemContext = findLatestPayloadValue(records, 'systemContext')

  lines.push(formatSection('USER', extractUserInput(userInput)))
  lines.push(formatSection('SYSTEM', systemPrompt))
  lines.push(formatSection('MESSAGES', userInput))

  if (userContext !== undefined || systemContext !== undefined) {
    lines.push(
      formatSection('STORE', {
        userContext: userContext ?? null,
        systemContext: systemContext ?? null,
      }),
    )
  }

  lines.push(formatSection('LLM', summarizeLlm(records)))
  lines.push(formatSection('DECISION', summarizeDecision(records)))
  lines.push(formatSection('TOOL', summarizeTools(records)))
  lines.push(formatSection('HOOK', summarizeHooks(records)))
  lines.push(formatSection('SUBAGENT', summarizeSubagents(records)))
  lines.push(formatSection('STORE', summarizeStore(records)))
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
): unknown {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const payload = records[index]?.payload
    if (payload !== undefined && Object.hasOwn(payload, key)) {
      return (payload as Record<string, unknown>)[key]
    }
  }

  return undefined
}

function extractUserInput(messages: unknown): unknown {
  if (!Array.isArray(messages)) {
    return messages
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

  return userTexts.length === 0 ? messages : userTexts.join('\n\n')
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

function summarizeLlm(records: TraceDisplayRecord[]): unknown {
  const requests = records
    .filter(record => record.type === 'api.request_built')
    .map(record => pickSummaryFields(record.payload, LLM_REQUEST_SUMMARY_KEYS))
  const assistantMessages = records
    .filter(record => record.type === 'api.assistant_message')
    .map(record =>
      pickSummaryFields(record.payload, ASSISTANT_MESSAGE_SUMMARY_KEYS),
    )

  if (requests.length === 0 && assistantMessages.length === 0) {
    return undefined
  }

  return {
    requests,
    assistantMessages,
  }
}

function pickSummaryFields(
  payload: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (!isRecord(payload)) {
    return {}
  }

  const summary: Record<string, unknown> = {}

  for (const key of keys) {
    const value = payload[key]

    if (value !== undefined) {
      summary[key] = value
    }
  }

  return summary
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function summarizeDecision(records: TraceDisplayRecord[]): unknown {
  const loopEnds = records
    .filter(record => record.type === 'query.loop_end')
    .map(record => record.payload)
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

  return {
    loops: loopEnds,
    turnEnd: turnEnd?.payload ?? null,
  }
}

function summarizeTools(records: TraceDisplayRecord[]): unknown {
  const tools = records
    .filter(record => record.source === 'tool')
    .map(record => ({
      type: record.type,
      payload: record.payload,
    }))

  return tools.length === 0 ? undefined : tools
}

function summarizeHooks(records: TraceDisplayRecord[]): unknown {
  const hooks = records
    .filter(record => record.source === 'hook')
    .map(record => ({
      type: record.type,
      payload: record.payload,
    }))

  return hooks.length === 0 ? undefined : hooks
}

function summarizeSubagents(records: TraceDisplayRecord[]): unknown {
  const subagents = records
    .filter(record => record.source === 'subagent')
    .map(record => ({
      type: record.type,
      payload: record.payload,
    }))

  return subagents.length === 0 ? undefined : subagents
}

function summarizeStore(records: TraceDisplayRecord[]): unknown {
  const transcriptEvents = records.filter(
    record => record.type === 'transcript.appended',
  )
  const sessionEvents = records.filter(record =>
    record.type.startsWith('trace.session_'),
  )

  return {
    transcriptAppendCount: transcriptEvents.length,
    sessionEvents: sessionEvents.map(record => ({
      type: record.type,
      payload: record.payload,
    })),
  }
}

function summarizeErrors(records: TraceDisplayRecord[]): unknown {
  const errors = records
    .filter(
      record =>
        record.type.endsWith('.error') ||
        record.type === 'api.retry' ||
        record.type === 'trace.read_error',
    )
    .map(record => ({
      type: record.type,
      payload: record.payload,
    }))

  return errors.length === 0 ? undefined : errors
}
