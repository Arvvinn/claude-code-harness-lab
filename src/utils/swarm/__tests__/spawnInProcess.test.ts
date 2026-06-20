/**
 * spawnInProcess.test.ts
 *
 * Thin subprocess wrapper for spawnInProcess.runner.ts. The runner exercises
 * in-process teammate state and CLAUDE_CONFIG_DIR-backed files, so keep it out
 * of the shared full-suite bun:test process.
 */

import { describe, test } from 'bun:test'
import { relative, resolve } from 'path'

const PROJECT_ROOT = resolve(__dirname, '..', '..', '..', '..')
const RUNNER_ABS = resolve(__dirname, 'spawnInProcess.runner.ts')
const RUNNER_REL = './' + relative(PROJECT_ROOT, RUNNER_ABS).replace(/\\/g, '/')

describe('spawnInProcess', () => {
  test('runs in-process teammate tests in isolated subprocess', async () => {
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
      throw new Error(
        `spawnInProcess subprocess failed (exit ${code}):\n${output}`,
      )
    }
  }, 60_000)
})
