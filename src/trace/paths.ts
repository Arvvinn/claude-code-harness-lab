import { join } from 'node:path'
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
  return join(getTraceRootDir(), sessionId, 'events.jsonl')
}
