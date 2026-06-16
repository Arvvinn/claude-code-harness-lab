import { isAbsolute, join } from 'node:path'
import { getClaudeConfigHomeDir } from 'src/utils/envUtils.js'

export function getTraceRootDir(): string {
  return process.env.CLAUDE_CODE_TRACE_DIR
    ? process.env.CLAUDE_CODE_TRACE_DIR
    : join(getClaudeConfigHomeDir(), 'harness-traces')
}

export function getTraceConfigPath(): string {
  return join(getTraceRootDir(), 'config.json')
}

export function getActiveTracePath(): string {
  return join(getTraceRootDir(), 'active-session.json')
}

export function getTraceEventsPath(sessionId: string): string {
  assertValidTraceSessionId(sessionId)

  return join(getTraceRootDir(), sessionId, 'events.jsonl')
}

function assertValidTraceSessionId(sessionId: string): void {
  if (
    sessionId.length === 0 ||
    sessionId === '.' ||
    sessionId === '..' ||
    sessionId.includes('/') ||
    sessionId.includes('\\') ||
    isAbsolute(sessionId)
  ) {
    throw new Error(`Invalid trace session id: ${sessionId}`)
  }
}
