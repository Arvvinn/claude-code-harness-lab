import type { LocalCommandCall } from '../../types/command.js'
import { getSessionId } from '../../bootstrap/state.js'
import {
  endTraceSession,
  getActiveTraceSessionForProcess,
  getTraceMode,
  isTraceSessionActive,
  startTraceSession,
  updateActiveTraceModeFromConfig,
} from '../../trace/bus.js'
import { loadTraceConfig, saveTraceConfig } from '../../trace/config.js'
import {
  launchTraceTailWindow,
  TRACE_TAIL_COMMAND,
  type TraceTailWindowLaunchResult,
} from '../../trace/liveWindow.js'
import {
  clearActiveTraceSession,
  readActiveTraceSession,
} from '../../trace/store.js'

export const call: LocalCommandCall = async args => {
  const action = parseTraceAction(args)

  switch (action) {
    case 'status':
      return { type: 'display', value: formatTraceStatus() }
    case 'tail':
      return {
        type: 'display',
        value: `Trace tail command:\n${TRACE_TAIL_COMMAND}`,
      }
    case 'off':
      endTraceSession({ reason: 'trace command disabled tracing' })
      clearActiveTraceSession()
      saveTraceConfig({ ...loadTraceConfig(), mode: 'off' })
      return { type: 'display', value: formatTraceStatus() }
    case 'learn':
    case 'full':
      saveTraceConfig({ ...loadTraceConfig(), mode: action })
      updateActiveTraceModeFromConfig()
      startCurrentTraceSessionIfNeeded()
      const tailWindow = await launchTraceTailWindow()
      return {
        type: 'display',
        value: `${formatTraceStatus()}\n\n${formatTailWindowResult(tailWindow)}`,
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
    lines.push(`Tail: ${TRACE_TAIL_COMMAND}`)

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

  lines.push(`Tail: ${TRACE_TAIL_COMMAND}`)

  return lines.join('\n')
}

function formatTailWindowResult(result: TraceTailWindowLaunchResult): string {
  if (result.ok && result.reason === 'already_launched') {
    return `Tail window: already launched\nTail: ${result.command}`
  }

  if (result.ok) {
    const launcher = result.launcher ? ` via ${result.launcher}` : ''

    return `Tail window: launched${launcher}\nTail: ${result.command}`
  }

  const reason = result.reason ?? 'unavailable'
  const error = result.error ? ` (${result.error})` : ''

  return `Tail window: auto-launch unavailable: ${reason}${error}\nRun:\n${result.command}`
}
