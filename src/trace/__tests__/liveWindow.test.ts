import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, test } from 'bun:test'
import {
  TRACE_TAIL_COMMAND,
  launchTraceTailWindow,
  setTraceTailWindowChildProcessSpawnForTesting,
  resetTraceTailWindowForTesting,
  setTraceTailWindowSpawnForTesting,
} from '../liveWindow.js'

describe('launchTraceTailWindow', () => {
  afterEach(() => {
    resetTraceTailWindowForTesting()
  })

  test('skips launching when auto tail is disabled or tracing is off', async () => {
    const calls: Array<{ executable: string; args: string[] }> = []
    resetTraceTailWindowForTesting()
    setTraceTailWindowSpawnForTesting(async (executable, args) => {
      calls.push({ executable, args })
      return { ok: true }
    })

    const disabled = await launchTraceTailWindow({
      config: { mode: 'learn', autoTailWindow: false },
      platform: 'win32',
    })
    const off = await launchTraceTailWindow({
      config: { mode: 'off', autoTailWindow: true },
      platform: 'win32',
    })

    expect(disabled).toMatchObject({
      ok: false,
      command: TRACE_TAIL_COMMAND,
      reason: 'disabled',
    })
    expect(off).toMatchObject({
      ok: false,
      command: TRACE_TAIL_COMMAND,
      reason: 'off',
    })
    expect(calls).toEqual([])
  })

  test('uses Start-Process semantics on Windows without concatenating user paths', async () => {
    const calls: Array<{ executable: string; args: string[] }> = []
    resetTraceTailWindowForTesting()
    setTraceTailWindowSpawnForTesting(async (executable, args) => {
      calls.push({ executable, args })
      return { ok: true }
    })

    const result = await launchTraceTailWindow({
      config: { mode: 'learn', autoTailWindow: true },
      platform: 'win32',
    })

    expect(result).toMatchObject({
      ok: true,
      command: TRACE_TAIL_COMMAND,
      launcher: 'pwsh',
    })
    expect(calls).toEqual([
      {
        executable: 'pwsh',
        args: [
          '-NoProfile',
          '-Command',
          "Start-Process pwsh -ArgumentList '-NoExit','-Command','claude trace tail'",
        ],
      },
    ])
  })

  test('launches at most once per process', async () => {
    const calls: Array<{ executable: string; args: string[] }> = []
    resetTraceTailWindowForTesting()
    setTraceTailWindowSpawnForTesting(async (executable, args) => {
      calls.push({ executable, args })
      return { ok: true }
    })

    const first = await launchTraceTailWindow({
      config: { mode: 'full', autoTailWindow: true },
      platform: 'win32',
    })
    const second = await launchTraceTailWindow({
      config: { mode: 'full', autoTailWindow: true },
      platform: 'win32',
    })

    expect(first.ok).toBe(true)
    expect(second).toMatchObject({
      ok: true,
      command: TRACE_TAIL_COMMAND,
      reason: 'already_launched',
    })
    expect(calls).toHaveLength(1)
  })

  test('falls back to the tail command when every launcher fails', async () => {
    resetTraceTailWindowForTesting()
    setTraceTailWindowSpawnForTesting(async () => {
      return { ok: false, error: new Error('missing terminal') }
    })

    const result = await launchTraceTailWindow({
      config: { mode: 'learn', autoTailWindow: true },
      platform: 'linux',
    })

    expect(result).toMatchObject({
      ok: false,
      command: TRACE_TAIL_COMMAND,
      reason: 'launch_failed',
    })
  })

  test('does not mark failed launches as already launched', async () => {
    const calls: Array<{ executable: string; args: string[] }> = []
    resetTraceTailWindowForTesting()
    setTraceTailWindowSpawnForTesting(async (executable, args) => {
      calls.push({ executable, args })
      return { ok: false, error: new Error('missing terminal') }
    })

    const first = await launchTraceTailWindow({
      config: { mode: 'learn', autoTailWindow: true },
      platform: 'linux',
    })
    const second = await launchTraceTailWindow({
      config: { mode: 'learn', autoTailWindow: true },
      platform: 'linux',
    })

    expect(first).toMatchObject({
      ok: false,
      command: TRACE_TAIL_COMMAND,
      reason: 'launch_failed',
    })
    expect(second).toMatchObject({
      ok: false,
      command: TRACE_TAIL_COMMAND,
      reason: 'launch_failed',
    })
    expect(calls).toHaveLength(6)
  })

  test('treats launchers that spawn then exit nonzero as failed launches', async () => {
    const children: FakeChildProcess[] = []
    resetTraceTailWindowForTesting()
    setTraceTailWindowChildProcessSpawnForTesting(() => {
      const child = new FakeChildProcess()
      children.push(child)
      queueMicrotask(() => {
        child.emit('spawn')
        child.emit('exit', 1, null)
      })

      return child
    })

    const first = await launchTraceTailWindow({
      config: { mode: 'learn', autoTailWindow: true },
      platform: 'linux',
    })
    const second = await launchTraceTailWindow({
      config: { mode: 'learn', autoTailWindow: true },
      platform: 'linux',
    })

    expect(first).toMatchObject({
      ok: false,
      command: TRACE_TAIL_COMMAND,
      reason: 'launch_failed',
    })
    expect(second).toMatchObject({
      ok: false,
      command: TRACE_TAIL_COMMAND,
      reason: 'launch_failed',
    })
    expect(children).toHaveLength(6)
  })

  test('clears launch timeouts when spawned launchers exit nonzero quickly', async () => {
    const children: FakeChildProcess[] = []
    resetTraceTailWindowForTesting()
    setTraceTailWindowChildProcessSpawnForTesting(() => {
      const child = new FakeChildProcess()
      children.push(child)
      queueMicrotask(() => {
        child.emit('spawn')
        child.emit('exit', 1, null)
      })

      return child
    })

    const result = await launchTraceTailWindow({
      config: { mode: 'learn', autoTailWindow: true },
      platform: 'linux',
    })
    await new Promise(resolve => setTimeout(resolve, 550))

    expect(result).toMatchObject({
      ok: false,
      command: TRACE_TAIL_COMMAND,
      reason: 'launch_failed',
    })
    expect(children).toHaveLength(3)
    expect(children.map(child => child.unrefCalls)).toEqual([0, 0, 0])
  })
})

class FakeChildProcess extends EventEmitter {
  unrefCalls = 0

  unref(): void {
    this.unrefCalls += 1
  }
}
