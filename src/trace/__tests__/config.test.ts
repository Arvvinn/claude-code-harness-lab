import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { getTraceRootDir } from '../paths.js'
import { loadTraceConfig, saveTraceConfig } from '../config.js'

const originalTraceDir = process.env.CLAUDE_CODE_TRACE_DIR
let traceDir: string

describe('trace config', () => {
  beforeEach(async () => {
    traceDir = await mkdtemp(join(tmpdir(), 'claude-trace-config-'))
    process.env.CLAUDE_CODE_TRACE_DIR = traceDir
  })

  afterEach(async () => {
    if (originalTraceDir === undefined) {
      delete process.env.CLAUDE_CODE_TRACE_DIR
    } else {
      process.env.CLAUDE_CODE_TRACE_DIR = originalTraceDir
    }

    await rm(traceDir, { recursive: true, force: true })
  })

  test('saves and loads trace config from the trace directory', async () => {
    await mkdir(getTraceRootDir(), { recursive: true })

    saveTraceConfig({ mode: 'learn', autoTailWindow: false })

    expect(loadTraceConfig()).toEqual({
      mode: 'learn',
      autoTailWindow: false,
    })
  })
})
