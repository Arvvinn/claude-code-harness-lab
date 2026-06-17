import { feature } from 'bun:bundle'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  flushTraceForTesting,
  resetTraceForTesting,
  startTraceSession,
} from '../bus.js'
import { getTraceConfigPath, getTraceRootDir } from '../paths.js'
import { readTraceEvents } from '../store.js'
import type { TraceConfig } from '../types.js'

if (feature('HARNESS_TRACE')) {
  const originalTraceDir = process.env.CLAUDE_CODE_TRACE_DIR
  let traceDir: string

  describe('session storage trace events', () => {
    beforeEach(async () => {
      traceDir = await mkdtemp(join(tmpdir(), 'claude-session-trace-'))
      process.env.CLAUDE_CODE_TRACE_DIR = traceDir
      resetTraceForTesting()
      await writeTraceConfig({ mode: 'learn', autoTailWindow: true })
    })

    afterEach(async () => {
      await flushTraceForTesting()
      resetTraceForTesting()

      if (originalTraceDir === undefined) {
        delete process.env.CLAUDE_CODE_TRACE_DIR
      } else {
        process.env.CLAUDE_CODE_TRACE_DIR = originalTraceDir
      }

      await rm(traceDir, { recursive: true, force: true })
    })

    test('records transcript append metadata without duplicating entry payload', async () => {
      const { appendTranscriptEntryForTesting } = await import(
        '../../utils/sessionStorage.js'
      )
      const transcriptPath = join(traceDir, 'session.jsonl')
      const entry = {
        type: 'user',
        uuid: '11111111-1111-4111-8111-111111111111',
        isSidechain: true,
        message: {
          role: 'user',
          content: 'sensitive prompt text that should not be copied here',
        },
      }

      startTraceSession({
        sessionId: 'session-transcript',
        cwd: 'C:\\workspace',
        argv: ['ccb'],
      })

      appendTranscriptEntryForTesting(transcriptPath, entry)
      await flushTraceForTesting()

      const appendEvent = readTraceEvents('session-transcript').find(
        event => event.type === 'transcript.appended',
      )
      expect(appendEvent).toMatchObject({
        source: 'transcript',
        type: 'transcript.appended',
        payload: {
          path: transcriptPath,
          entryType: 'user',
          messageUuid: entry.uuid,
          isSidechain: true,
        },
      })
      expect(appendEvent?.payload).not.toHaveProperty('entry')
      expect(appendEvent?.payload).not.toHaveProperty('message')
      expect(typeof appendEvent?.payload.byteCount).toBe('number')
      expect(Number(appendEvent?.payload.byteCount)).toBeGreaterThan(0)
    })
  })

  async function writeTraceConfig(config: TraceConfig): Promise<void> {
    await mkdir(getTraceRootDir(), { recursive: true })
    await writeFile(
      getTraceConfigPath(),
      `${JSON.stringify(config, null, 2)}\n`,
    )
  }
}
