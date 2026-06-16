import { existsSync, readFileSync } from 'node:fs'
import { getTraceConfigPath } from './paths.js'
import type { TraceConfig, TraceMode } from './types.js'

export const DEFAULT_TRACE_CONFIG = {
  mode: 'off',
  autoTailWindow: true,
} as const

export function loadTraceConfig(): TraceConfig {
  const configPath = getTraceConfigPath()

  if (!existsSync(configPath)) {
    return { ...DEFAULT_TRACE_CONFIG }
  }

  try {
    const parsed: unknown = JSON.parse(readFileSync(configPath, 'utf8'))

    if (!isTraceConfig(parsed)) {
      return { ...DEFAULT_TRACE_CONFIG }
    }

    return parsed
  } catch {
    return { ...DEFAULT_TRACE_CONFIG }
  }
}

function isTraceConfig(value: unknown): value is TraceConfig {
  if (value === null || typeof value !== 'object') {
    return false
  }

  const config = value as Record<string, unknown>

  return isTraceMode(config.mode) && typeof config.autoTailWindow === 'boolean'
}

function isTraceMode(value: unknown): value is TraceMode {
  return value === 'off' || value === 'learn' || value === 'full'
}
