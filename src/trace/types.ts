export type TraceMode = 'off' | 'learn' | 'full'

export type ActiveTraceMode = Exclude<TraceMode, 'off'>

export type TraceEventType =
  | 'trace.session_start'
  | 'trace.session_end'
  | 'turn.start'
  | 'turn.end'
  | 'user.input_received'
  | 'user.input_after_hooks'
  | 'query.loop_start'
  | 'query.loop_end'
  | 'api.request_built'
  | 'api.stream_event'
  | 'api.assistant_message'
  | 'api.response_completed'
  | 'api.error'
  | 'api.retry'
  | 'tool.detected'
  | 'tool.queued'
  | 'tool.started'
  | 'tool.permission_result'
  | 'tool.result'
  | 'tool.error'
  | 'tool.cancelled'
  | 'hook.started'
  | 'hook.result'
  | 'subagent.started'
  | 'subagent.ended'
  | 'transcript.appended'

export type TraceSource =
  | 'repl'
  | 'query'
  | 'api'
  | 'tool'
  | 'hook'
  | 'subagent'
  | 'transcript'

export interface TraceEvent {
  eventId: string
  parentId?: string
  sessionId: string
  turnId?: string
  sequence: number
  timestamp: string
  mode: ActiveTraceMode
  source: TraceSource
  type: TraceEventType
  payload: Record<string, unknown>
}

export interface TraceConfig {
  mode: TraceMode
  autoTailWindow: boolean
}
