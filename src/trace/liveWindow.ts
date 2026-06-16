import { spawn } from 'node:child_process'
import { loadTraceConfig } from './config.js'
import type { TraceConfig } from './types.js'

export const TRACE_TAIL_COMMAND = 'claude trace tail'

export type TraceTailWindowLaunchReason =
  | 'disabled'
  | 'off'
  | 'already_launched'
  | 'unsupported_platform'
  | 'launch_failed'

export interface TraceTailWindowLaunchResult {
  ok: boolean
  command: string
  reason?: TraceTailWindowLaunchReason
  launcher?: string
  error?: string
}

export interface TraceTailWindowSpawnResult {
  ok: boolean
  error?: unknown
}

export type TraceTailWindowSpawn = (
  executable: string,
  args: string[],
) => Promise<TraceTailWindowSpawnResult>

export interface LaunchTraceTailWindowOptions {
  config?: TraceConfig
  platform?: typeof process.platform
}

interface LauncherCandidate {
  executable: string
  args: string[]
}

let launchSucceeded = false
let spawnForTesting: TraceTailWindowSpawn | null = null

export async function launchTraceTailWindow(
  options: LaunchTraceTailWindowOptions = {},
): Promise<TraceTailWindowLaunchResult> {
  const config = options.config ?? loadTraceConfig()

  if (!config.autoTailWindow) {
    return {
      ok: false,
      command: TRACE_TAIL_COMMAND,
      reason: 'disabled',
    }
  }

  if (config.mode === 'off') {
    return {
      ok: false,
      command: TRACE_TAIL_COMMAND,
      reason: 'off',
    }
  }

  if (launchSucceeded) {
    return {
      ok: true,
      command: TRACE_TAIL_COMMAND,
      reason: 'already_launched',
    }
  }

  const candidates = getLauncherCandidates(options.platform ?? process.platform)

  if (candidates.length === 0) {
    return {
      ok: false,
      command: TRACE_TAIL_COMMAND,
      reason: 'unsupported_platform',
    }
  }

  const spawnDetached = spawnForTesting ?? spawnDetachedProcess
  let lastError: unknown

  for (const candidate of candidates) {
    const result = await spawnDetached(candidate.executable, candidate.args)

    if (result.ok) {
      launchSucceeded = true
      return {
        ok: true,
        command: TRACE_TAIL_COMMAND,
        launcher: candidate.executable,
      }
    }

    lastError = result.error
  }

  return {
    ok: false,
    command: TRACE_TAIL_COMMAND,
    reason: 'launch_failed',
    error: formatError(lastError),
  }
}

export function setTraceTailWindowSpawnForTesting(
  spawnDetached: TraceTailWindowSpawn,
): void {
  spawnForTesting = spawnDetached
}

export function resetTraceTailWindowForTesting(): void {
  launchSucceeded = false
  spawnForTesting = null
}

function getLauncherCandidates(
  platform: typeof process.platform,
): LauncherCandidate[] {
  switch (platform) {
    case 'win32':
      return [
        {
          executable: 'pwsh',
          args: [
            '-NoProfile',
            '-Command',
            "Start-Process pwsh -ArgumentList '-NoExit','-Command','claude trace tail'",
          ],
        },
        {
          executable: 'powershell',
          args: [
            '-NoProfile',
            '-Command',
            "Start-Process powershell -ArgumentList '-NoExit','-Command','claude trace tail'",
          ],
        },
      ]
    case 'darwin':
      return [
        {
          executable: 'osascript',
          args: [
            '-e',
            'tell application "Terminal" to do script "claude trace tail"',
          ],
        },
      ]
    case 'linux':
      return [
        {
          executable: 'wt',
          args: ['claude', 'trace', 'tail'],
        },
        {
          executable: 'gnome-terminal',
          args: ['--', 'claude', 'trace', 'tail'],
        },
        {
          executable: 'xterm',
          args: ['-e', 'claude', 'trace', 'tail'],
        },
      ]
    default:
      return []
  }
}

async function spawnDetachedProcess(
  executable: string,
  args: string[],
): Promise<TraceTailWindowSpawnResult> {
  return new Promise(resolve => {
    let settled = false
    let settleTimeout: ReturnType<typeof setTimeout> | undefined
    const settle = (result: TraceTailWindowSpawnResult) => {
      if (settled) {
        return
      }

      settled = true

      if (settleTimeout !== undefined) {
        clearTimeout(settleTimeout)
      }

      resolve(result)
    }

    try {
      const child = spawn(executable, args, {
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
      })

      settleTimeout = setTimeout(() => {
        child.unref()
        settle({ ok: true })
      }, 500)

      child.once('error', error => {
        settle({ ok: false, error })
      })
      child.once('spawn', () => {
        child.unref()
        settle({ ok: true })
      })
    } catch (error) {
      settle({ ok: false, error })
    }
  })
}

function formatError(error: unknown): string | undefined {
  if (error === undefined) {
    return undefined
  }

  return error instanceof Error ? error.message : String(error)
}
