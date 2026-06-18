import { spawn, type SpawnOptions } from 'node:child_process'
import { loadTraceConfig } from './config.js'
import type { TraceConfig } from './types.js'

export const TRACE_TAIL_COMMAND = 'claude trace tail'
export const TRACE_TAIL_DEEP_COMMAND = 'claude trace tail --deep'

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
let launchedCommand: string | null = null
let spawnForTesting: TraceTailWindowSpawn | null = null
let childProcessSpawnForTesting: TraceTailWindowChildProcessSpawn | null = null

export async function launchTraceTailWindow(
  options: LaunchTraceTailWindowOptions = {},
): Promise<TraceTailWindowLaunchResult> {
  const config = options.config ?? loadTraceConfig()
  const command = getTraceTailCommand(config)

  if (!config.autoTailWindow) {
    return {
      ok: false,
      command,
      reason: 'disabled',
    }
  }

  if (config.mode === 'off') {
    return {
      ok: false,
      command,
      reason: 'off',
    }
  }

  if (launchSucceeded && launchedCommand === command) {
    return {
      ok: true,
      command,
      reason: 'already_launched',
    }
  }

  const candidates = getLauncherCandidates(
    options.platform ?? process.platform,
    command,
  )

  if (candidates.length === 0) {
    return {
      ok: false,
      command,
      reason: 'unsupported_platform',
    }
  }

  const spawnDetached = spawnForTesting ?? spawnDetachedProcess
  let lastError: unknown

  for (const candidate of candidates) {
    const result = await spawnDetached(candidate.executable, candidate.args)

    if (result.ok) {
      launchSucceeded = true
      launchedCommand = command
      return {
        ok: true,
        command,
        launcher: candidate.executable,
      }
    }

    lastError = result.error
  }

  return {
    ok: false,
    command,
    reason: 'launch_failed',
    error: formatError(lastError),
  }
}

export function getTraceTailCommand(config: Pick<TraceConfig, 'mode'>): string {
  return config.mode === 'full' ? TRACE_TAIL_DEEP_COMMAND : TRACE_TAIL_COMMAND
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
  launchedCommand = null
  spawnForTesting = null
  childProcessSpawnForTesting = null
}

function getLauncherCandidates(
  platform: typeof process.platform,
  command: string,
): LauncherCandidate[] {
  switch (platform) {
    case 'win32':
      return [
        {
          executable: 'pwsh',
          args: [
            '-NoProfile',
            '-Command',
            `Start-Process pwsh -ArgumentList '-NoExit','-Command','${command}'`,
          ],
        },
        {
          executable: 'powershell',
          args: [
            '-NoProfile',
            '-Command',
            `Start-Process powershell -ArgumentList '-NoExit','-Command','${command}'`,
          ],
        },
      ]
    case 'darwin':
      return [
        {
          executable: 'osascript',
          args: ['-e', `tell application "Terminal" to do script "${command}"`],
        },
      ]
    case 'linux': {
      const commandArgs =
        command === TRACE_TAIL_DEEP_COMMAND
          ? ['claude', 'trace', 'tail', '--deep']
          : ['claude', 'trace', 'tail']

      return [
        {
          executable: 'gnome-terminal',
          args: ['--', ...commandArgs],
        },
        {
          executable: 'xterm',
          args: ['-e', ...commandArgs],
        },
      ]
    }
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
