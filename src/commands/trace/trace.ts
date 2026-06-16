import type { LocalCommandCall } from '../../types/command.js'
import { getSessionId } from '../../bootstrap/state.js'
import {
  endTraceSession,
  getActiveTraceSessionForProcess,
  getTraceMode,
  isTraceSessionActive,
  startTraceSession,
} from '../../trace/bus.js'
import { loadTraceConfig, saveTraceConfig } from '../../trace/config.js'
import {
  clearActiveTraceSession,
  readActiveTraceSession,
} from '../../trace/store.js'

const TAIL_COMMAND = 'claude trace tail'

export const call: LocalCommandCall = async args => {
  const action = parseTraceAction(args)

  switch (action) {
    case 'status':
      return { type: 'text', value: formatTraceStatus() }
    case 'tail':
      return {
        type: 'text',
        value: `Trace tail command:\n${TAIL_COMMAND}`,
      }
    case 'off':
      endTraceSession({ reason: 'trace command disabled tracing' })
      clearActiveTraceSession()
      saveTraceConfig({ ...loadTraceConfig(), mode: 'off' })
      return { type: 'text', value: formatTraceStatus() }
    case 'learn':
    case 'full':
      saveTraceConfig({ ...loadTraceConfig(), mode: action })
      startCurrentTraceSessionIfNeeded()
      return {
        type: 'text',
        value: `${formatTraceStatus()}\n\nTail window auto-launch is not available yet. Run:\n${TAIL_COMMAND}`,
      }
  }
}

type TraceAction = 'status' | 'off' | 'learn' | 'full' | 'tail'

function parseTraceAction(args: string): TraceAction {
  const action = args.trim().split(/\s+/)[0]

  if (action === '') {
    return 'status'
  }

  if (
    action === 'status' ||
    action === 'off' ||
    action === 'learn' ||
    action === 'full' ||
    action === 'tail'
  ) {
    return action
  }

  return 'status'
}

function startCurrentTraceSessionIfNeeded(): void {
  if (isTraceSessionActive()) {
    return
  }

  startTraceSession({
    sessionId: getSessionId(),
    cwd: process.cwd(),
    argv: process.argv,
  })
}

function formatTraceStatus(): string {
  const mode = getTraceMode()
  const lines = [`Mode: ${mode}`]

  if (mode === 'off') {
    lines.push('Session: none')
    lines.push('Events: none')
    lines.push(`Tail: ${TAIL_COMMAND}`)

    return lines.join('\n')
  }

  const activeSession =
    getActiveTraceSessionForProcess() ?? readActiveTraceSession()

  if (activeSession) {
    lines.push(`Session: ${activeSession.sessionId}`)
    lines.push(`Events: ${activeSession.eventsPath}`)
  } else {
    lines.push('Session: none')
    lines.push('Events: none')
  }

  lines.push(`Tail: ${TAIL_COMMAND}`)

  return lines.join('\n')
}
