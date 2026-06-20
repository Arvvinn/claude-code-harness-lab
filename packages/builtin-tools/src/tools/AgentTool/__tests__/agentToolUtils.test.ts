/**
 * agentToolUtils.test.ts
 *
 * Thin subprocess wrapper for agentToolUtils.runner.ts. The runner uses many
 * process-wide mock.module() registrations, so keeping it in a separate
 * bun:test process prevents module-cache pollution in the full test suite.
 */

import { describe, test } from 'bun:test'
import { relative, resolve } from 'path'

const PROJECT_ROOT = resolve(__dirname, '..', '..', '..', '..', '..', '..')
const RUNNER_ABS = resolve(__dirname, 'agentToolUtils.runner.ts')
const RUNNER_REL = './' + relative(PROJECT_ROOT, RUNNER_ABS).replace(/\\/g, '/')

describe('agentToolUtils', () => {
  test('runs all agentToolUtils tests in isolated subprocess', async () => {
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
        `agentToolUtils test subprocess failed (exit ${code}):\n${output}`,
      )
    }
  }, 60_000)
})
