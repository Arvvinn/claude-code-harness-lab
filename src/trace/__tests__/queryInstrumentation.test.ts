import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { feature } from 'bun:bundle'
import type { AssistantMessage } from '../../types/message'
import type { TraceConfig } from '../types'

const { resetStateForTests, setCwdState, setOriginalCwd, setProjectRoot } =
  await import('../../bootstrap/state')
const { query } = await import('../../query')
const { getEmptyToolPermissionContext } = await import('../../Tool')
const { createUserMessage } = await import('../../utils/messages')
const { asSystemPrompt } = await import('../../utils/systemPromptType')
const {
  emitTrace,
  flushTraceForTesting,
  resetTraceForTesting,
  startTraceSession,
} = await import('../bus')
const { getTraceConfigPath, getTraceEventsPath, getTraceRootDir } =
  await import('../paths')
const { readTraceEvents } = await import('../store')

const originalTraceDir = process.env.CLAUDE_CODE_TRACE_DIR
let traceDir = ''
let originalProcessCwd = ''

if (feature('HARNESS_TRACE')) {
  describe('query trace instrumentation', () => {
    beforeEach(async () => {
      originalProcessCwd = process.cwd()
      traceDir = await mkdtemp(join(tmpdir(), 'claude-query-trace-'))
      process.env.CLAUDE_CODE_TRACE_DIR = traceDir
      resetStateForTests()
      resetTraceForTesting()
      setOriginalCwd(traceDir)
      setCwdState(traceDir)
      setProjectRoot(traceDir)
      await writeTraceConfig({ mode: 'learn', autoTailWindow: true })
    })

    afterEach(async () => {
      await flushTraceForTesting()
      resetTraceForTesting()
      resetStateForTests()

      if (originalTraceDir === undefined) {
        delete process.env.CLAUDE_CODE_TRACE_DIR
      } else {
        process.env.CLAUDE_CODE_TRACE_DIR = originalTraceDir
      }

      if (originalProcessCwd) {
        process.chdir(originalProcessCwd)
      }

      await rm(traceDir, { recursive: true, force: true })
    })

    test('emits loop boundaries with turn metadata and no prompt text', async () => {
      startTraceSession({
        sessionId: 'session-query-loop',
        cwd: traceDir,
        argv: ['claude', '-p'],
      })

      const deps = {
        uuid: () => 'query-chain-id',
        microcompact: async (messages: unknown[]) => ({ messages }),
        autocompact: async () => ({
          compactionResult: undefined,
          consecutiveFailures: 0,
        }),
        callModel: async function* () {
          yield createAssistantMessage()
        },
      }

      const rawPrompt = 'raw user prompt must not appear in trace payloads'
      const generator = query({
        messages: [createUserMessage({ content: rawPrompt })],
        systemPrompt: asSystemPrompt([]),
        userContext: {},
        systemContext: {},
        canUseTool: async (_tool, input) => ({
          behavior: 'allow',
          updatedInput: input,
        }),
        toolUseContext: createToolUseContext(),
        querySource: 'sdk',
        traceTurnId: 'turn-query-test',
        deps: deps as never,
      })

      let next = await generator.next()
      while (!next.done) {
        next = await generator.next()
      }

      emitTrace({
        source: 'query',
        type: 'turn.end',
        turnId: 'turn-query-test',
        payload: { marker: 'after-query' },
      })
      await flushTraceForTesting()

      const events = readTraceEvents('session-query-loop')
      const loopEvents = events.filter(event =>
        event.type.startsWith('query.loop_'),
      )

      expect(loopEvents.map(event => event.type)).toEqual([
        'query.loop_start',
        'query.loop_end',
      ])
      expect(loopEvents.map(event => event.turnId)).toEqual([
        'turn-query-test',
        'turn-query-test',
      ])
      expect(loopEvents[0].payload).toMatchObject({
        loopIndex: 1,
        messageCount: 1,
        querySource: 'sdk',
      })
      expect(loopEvents[1].payload).toMatchObject({
        stopReason: 'completed',
        assistantMessageCount: 1,
        toolUseCount: 0,
      })
      expect(JSON.stringify(events)).not.toContain(rawPrompt)
      expect(getTraceEventsPath('session-query-loop')).toContain(
        'session-query-loop',
      )
    })
  })
} else {
  describe('query trace instrumentation', () => {
    test('is gated behind HARNESS_TRACE', () => {
      expect(true).toBe(true)
    })
  })
}

function createAssistantMessage(): AssistantMessage {
  return {
    type: 'assistant',
    uuid: 'assistant-message-1',
    timestamp: new Date().toISOString(),
    requestId: undefined,
    message: {
      id: 'msg_query_trace',
      type: 'message',
      role: 'assistant',
      model: 'test-model',
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      content: [
        {
          type: 'text',
          text: 'response summary',
        },
      ],
    },
  } as unknown as AssistantMessage
}

function createToolUseContext(): any {
  let appState = {
    toolPermissionContext: getEmptyToolPermissionContext(),
    fastMode: false,
    mcp: {
      tools: [],
      clients: [],
    },
    effortValue: undefined,
    advisorModel: undefined,
    sessionHooks: new Map(),
  }

  return {
    options: {
      commands: [],
      debug: false,
      mainLoopModel: 'claude-sonnet-4-5-20250929',
      tools: [],
      verbose: false,
      thinkingConfig: { type: 'disabled' },
      mcpClients: [],
      mcpResources: {},
      isNonInteractiveSession: true,
      agentDefinitions: {
        activeAgents: [],
        allowedAgentTypes: [],
      },
    },
    abortController: new AbortController(),
    readFileState: new Map(),
    getAppState: () => appState,
    setAppState: (updater: (state: any) => any) => {
      appState = updater(appState as never)
    },
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
    messages: [],
  } as any
}

async function writeTraceConfig(config: TraceConfig): Promise<void> {
  await mkdir(getTraceRootDir(), { recursive: true })
  await writeFile(getTraceConfigPath(), `${JSON.stringify(config, null, 2)}\n`)
}
