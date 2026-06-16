import { spawn, type SpawnOptions } from 'node:child_process'
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

type TraceTailWindowChildProcess = {
  once(event: string, listener: (...args: unknown[]) => void): unknown
  unref(): void
}

type TraceTailWindowChildProcessSpawn = (
  executable: string,
  args: string[],
  options: SpawnOptions,
) => TraceTailWindowChildProcess

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
let childProcessSpawnForTesting: TraceTailWindowChildProcessSpawn | null = null

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

export function setTraceTailWindowChildProcessSpawnForTesting(
  childProcessSpawn: TraceTailWindowChildProcessSpawn,
): void {
  childProcessSpawnForTesting = childProcessSpawn
}

export function resetTraceTailWindowForTesting(): void {
  launchSucceeded = false
  spawnForTesting = null
  childProcessSpawnForTesting = null
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
    const clearSettleTimeout = () => {
      if (settleTimeout === undefined) {
        return
      }

      clearTimeout(settleTimeout)
      settleTimeout = undefined
    }
    const settle = (result: TraceTailWindowSpawnResult) => {
      if (settled) {
        return
      }

      settled = true
      clearSettleTimeout()

      resolve(result)
    }
    const settleExit = (
      eventName: 'exit' | 'close',
      code: unknown,
      signal: unknown,
    ) => {
      const action = eventName === 'exit' ? 'exited' : 'closed'

      if (typeof signal === 'string') {
        settle({
          ok: false,
          error: new Error(`${executable} ${action} with signal ${signal}`),
        })
        return
      }

      if (code === 0) {
        settle({ ok: true })
        return
      }

      const exitCode = typeof code === 'number' ? code : 'unknown'
      settle({
        ok: false,
        error: new Error(`${executable} ${action} with code ${exitCode}`),
      })
    }

    try {
      const spawnChildProcess = childProcessSpawnForTesting ?? spawn
      const child = spawnChildProcess(executable, args, {
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
      })
      const scheduleSettleTimeout = () => {
        clearSettleTimeout()
        settleTimeout = setTimeout(() => {
          child.unref()
          settle({ ok: true })
        }, 500)
      }

      scheduleSettleTimeout()

      child.once('error', error => {
        settle({ ok: false, error })
      })
      child.once('spawn', () => {
        if (settled) {
          return
        }

        scheduleSettleTimeout()
      })
      child.once('exit', (code, signal) => {
        settleExit('exit', code, signal)
      })
      child.once('close', (code, signal) => {
        settleExit('close', code, signal)
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
