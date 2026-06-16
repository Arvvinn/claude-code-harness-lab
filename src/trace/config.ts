import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'
import { getTraceConfigPath } from './paths.js'
import type { TraceConfig, TraceMode } from './types.js'

export const DEFAULT_TRACE_CONFIG = {
  mode: 'off',
  autoTailWindow: true,
} as const

const TRACE_MODES = new Set<TraceMode>(['off', 'learn', 'full'])

export function loadTraceConfig(): TraceConfig {
  const configPath = getTraceConfigPath()

  if (!existsSync(configPath)) {
    return DEFAULT_TRACE_CONFIG
  }

  try {
    const parsed: unknown = JSON.parse(readFileSync(configPath, 'utf8'))

    if (isTraceConfig(parsed)) {
      return parsed
    }
  } catch {}

  return DEFAULT_TRACE_CONFIG
}

export function saveTraceConfig(config: TraceConfig): void {
  const configPath = getTraceConfigPath()

  mkdirSync(dirname(configPath), { recursive: true })
  writeJsonAtomically(configPath, config)
}

function isTraceConfig(value: unknown): value is TraceConfig {
  if (value === null || typeof value !== 'object') {
    return false
  }

  const config = value as Record<string, unknown>

  return (
    typeof config.mode === 'string' &&
    TRACE_MODES.has(config.mode as TraceMode) &&
    typeof config.autoTailWindow === 'boolean'
  )
}

function writeJsonAtomically(path: string, value: unknown): void {
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`)
  renameSync(tempPath, path)
}
