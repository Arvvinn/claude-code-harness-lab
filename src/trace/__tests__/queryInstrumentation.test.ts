import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { feature } from 'bun:bundle'
import type { AssistantMessage } from '../../types/message'
import type { Terminal } from '../../query/transitions'
import type { TraceConfig } from '../types'

const { resetStateForTests, setCwdState, setOriginalCwd, setProjectRoot } =
  await import('../../bootstrap/state')
const { query } = await import('../../query')
const { getEmptyToolPermissionContext } = await import('../../Tool')
const { createUserMessage } = await import('../../utils/messages')
const { asSystemPrompt } = await import('../../utils/systemPromptType')
const { flushTraceForTesting, resetTraceForTesting, startTraceSession } =
  await import('../bus')
const { getTraceConfigPath, getTraceEventsPath, getTraceRootDir } =
  await import('../paths')
const { readTraceEvents } = await import('../store')

const originalTraceDir = process.env.CLAUDE_CODE_TRACE_DIR
let traceDir = ''
let originalProcessCwd = ''

describe('query trace delegation invariants', () => {
  test('uses manual trace counting delegation only for direct trace-owned turns', () => {
    const querySource = readFileSync(
      new URL('../../query.ts', import.meta.url),
      'utf8',
    )

    const guardedBranchStart = querySource.indexOf(
      'if (harnessTraceLoopMetadata !== undefined) {',
    )
    const manualDelegationStart = querySource.indexOf(
      'const loop = queryLoop(',
      guardedBranchStart,
    )
    const nativeDelegationStart = querySource.indexOf(
      '} else {\n      terminal = yield* queryLoop(',
      manualDelegationStart,
    )

    expect(guardedBranchStart).toBeGreaterThanOrEqual(0)
    expect(manualDelegationStart).toBeGreaterThan(guardedBranchStart)
    expect(nativeDelegationStart).toBeGreaterThan(manualDelegationStart)
    expect(
      querySource.slice(guardedBranchStart, manualDelegationStart),
    ).toContain('function isTraceCountableMessage')
    expect(
      querySource.slice(manualDelegationStart, nativeDelegationStart),
    ).toContain('const traceCountingLoop')
    expect(
      querySource.slice(manualDelegationStart, nativeDelegationStart),
    ).toContain('return(value: Terminal | PromiseLike<Terminal>)')
    expect(
      querySource.slice(manualDelegationStart, nativeDelegationStart),
    ).toContain('loop.return(value)')
    expect(
      querySource.slice(manualDelegationStart, nativeDelegationStart),
    ).toContain('terminal = yield* traceCountingLoop')
  })
})

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

    test('emits loop boundaries with provided turn metadata and no prompt text', async () => {
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

      await drainQuery(generator)
      await flushTraceForTesting()

      const events = readTraceEvents('session-query-loop')
      const queryEvents = events.filter(
        event => event.type !== 'trace.session_start',
      )
      const loopEvents = events.filter(event =>
        event.type.startsWith('query.loop_'),
      )

      expect(queryEvents.map(event => event.type)).toEqual([
        'query.loop_start',
        'query.loop_end',
      ])
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

    test('emits direct query turn boundaries with a trace-only turn id and no prompt text', async () => {
      startTraceSession({
        sessionId: 'session-query-direct',
        cwd: traceDir,
        argv: ['claude'],
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

      const rawPrompt = 'direct query raw prompt must not appear in trace'
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
        querySource: 'repl_main_thread',
        deps: deps as never,
      })

      await drainQuery(generator)
      await flushTraceForTesting()

      const events = readTraceEvents('session-query-direct')
      const queryEvents = events.filter(
        event => event.type !== 'trace.session_start',
      )

      expect(queryEvents.map(event => event.type)).toEqual([
        'turn.start',
        'user.input_received',
        'query.loop_start',
        'query.loop_end',
        'turn.end',
      ])

      const turnIds = queryEvents.map(event => event.turnId)
      expect(turnIds.every(turnId => typeof turnId === 'string')).toBe(true)
      expect(new Set(turnIds).size).toBe(1)
      expect(queryEvents[0].payload).toMatchObject({
        inputMode: 'messages',
        messageCount: 1,
        querySource: 'repl_main_thread',
      })
      expect(queryEvents[1].payload).toMatchObject({
        inputMode: 'messages',
        inputChars: rawPrompt.length,
        messageCount: 1,
        querySource: 'repl_main_thread',
      })
      expect(queryEvents[4].payload).toMatchObject({
        success: true,
        error: false,
        aborted: false,
        stopReason: 'completed',
        finalMessageCount: 2,
      })
      expect(JSON.stringify(events)).not.toContain(rawPrompt)
    })

    test('forwards early consumer return values to the traced query loop', async () => {
      startTraceSession({
        sessionId: 'session-query-direct-return',
        cwd: traceDir,
        argv: ['claude'],
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
      const asyncGeneratorPrototype = Object.getPrototypeOf(
        Object.getPrototypeOf((async function* () {})()),
      ) as {
        return: (value?: unknown) => Promise<IteratorResult<unknown, unknown>>
      }
      const originalReturn = asyncGeneratorPrototype.return
      const returnCalls: Array<{ self: unknown; value: unknown }> = []

      asyncGeneratorPrototype.return = function (
        this: unknown,
        value?: unknown,
      ) {
        returnCalls.push({ self: this, value })
        return originalReturn.call(this, value)
      }

      const generator = query({
        messages: [createUserMessage({ content: 'early return prompt' })],
        systemPrompt: asSystemPrompt([]),
        userContext: {},
        systemContext: {},
        canUseTool: async (_tool, input) => ({
          behavior: 'allow',
          updatedInput: input,
        }),
        toolUseContext: createToolUseContext(),
        querySource: 'repl_main_thread',
        deps: deps as never,
      })
      const returnValue: Terminal = { reason: 'aborted_streaming' }

      try {
        const first = await generator.next()
        expect(first).toMatchObject({
          done: false,
          value: { type: 'stream_request_start' },
        })

        await generator.return(returnValue)
      } finally {
        asyncGeneratorPrototype.return = originalReturn
      }

      expect(
        returnCalls.some(
          call => call.self !== generator && call.value === returnValue,
        ),
      ).toBe(true)
    })

    test('counts synthetic assistant error messages in direct query turn end metadata', async () => {
      startTraceSession({
        sessionId: 'session-query-direct-model-error',
        cwd: traceDir,
        argv: ['claude'],
      })

      const deps = {
        uuid: () => 'query-chain-id',
        microcompact: async (messages: unknown[]) => ({ messages }),
        autocompact: async () => ({
          compactionResult: undefined,
          consecutiveFailures: 0,
        }),
        callModel: async function* () {
          yield* [] as AssistantMessage[]
          throw new Error('synthetic model failure')
        },
      }

      const generator = query({
        messages: [createUserMessage({ content: 'direct model error prompt' })],
        systemPrompt: asSystemPrompt([]),
        userContext: {},
        systemContext: {},
        canUseTool: async (_tool, input) => ({
          behavior: 'allow',
          updatedInput: input,
        }),
        toolUseContext: createToolUseContext(),
        querySource: 'repl_main_thread',
        deps: deps as never,
      })

      const terminal = await drainQuery(generator)
      await flushTraceForTesting()

      const events = readTraceEvents('session-query-direct-model-error')
      const turnEndEvent = events.find(event => event.type === 'turn.end')

      expect(terminal.reason).toBe('model_error')
      expect(turnEndEvent?.payload).toMatchObject({
        success: false,
        error: true,
        aborted: false,
        stopReason: 'model_error',
        finalMessageCount: 2,
      })
    })
  })
} else {
  describe('query trace instrumentation', () => {
    test('is gated behind HARNESS_TRACE', () => {
      expect(true).toBe(true)
    })
  })
}

async function drainQuery(
  generator: ReturnType<typeof query>,
): Promise<Terminal> {
  let next = await generator.next()
  while (!next.done) {
    next = await generator.next()
  }
  return next.value
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
