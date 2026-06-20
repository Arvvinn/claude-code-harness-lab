/**
 * sleep.test.ts
 *
 * Thin subprocess wrapper for sleep.runner.ts. Several legacy tests in the
 * full suite mutate process-global timer/mock state, so the timing assertions
 * here run in a fresh bun:test process.
 */

import { describe, test } from 'bun:test'
import { relative, resolve } from 'path'

const PROJECT_ROOT = resolve(__dirname, '..', '..', '..')
const RUNNER_ABS = resolve(__dirname, 'sleep.runner.ts')
const RUNNER_REL = './' + relative(PROJECT_ROOT, RUNNER_ABS).replace(/\\/g, '/')

describe('sleep utilities', () => {
  test('runs sleep tests in isolated subprocess', async () => {
    const proc = Bun.spawn(['bun', 'test', RUNNER_REL], {
      cwd: PROJECT_ROOT,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const code = await proc.exited
    if (code !== 0) {
      const stderr = await new Response(proc.stderr).text()
      const stdout = await new Response(proc.stdout).text()
      const output = (stderr + '\n' + stdout).slice(-3000)
      throw new Error(`sleep test subprocess failed (exit ${code}):\n${output}`)
    }
  }, 60_000)
})
