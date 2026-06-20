/**
 * agentTeamsLifecycle.test.ts
 *
 * Thin subprocess wrapper for agentTeamsLifecycle.runner.ts. The runner mocks
 * swarm backends and mutates CLAUDE_CONFIG_DIR, so isolate it from the full
 * bun:test process.
 */

import { describe, test } from 'bun:test'
import { relative, resolve } from 'path'

const PROJECT_ROOT = resolve(__dirname, '..', '..', '..', '..')
const RUNNER_ABS = resolve(__dirname, 'agentTeamsLifecycle.runner.ts')
const RUNNER_REL = './' + relative(PROJECT_ROOT, RUNNER_ABS).replace(/\\/g, '/')

describe('Agent Teams lifecycle', () => {
  test('runs lifecycle tests in isolated subprocess', async () => {
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
        `Agent Teams lifecycle subprocess failed (exit ${code}):\n${output}`,
      )
    }
  }, 60_000)
})
