import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { feature } from 'bun:bundle'
import { z } from 'zod/v4'
import type { TraceConfig } from '../types'

const originalTraceDir = process.env.CLAUDE_CODE_TRACE_DIR
const originalAnthropicApiKey = process.env.ANTHROPIC_API_KEY
let traceDir = ''
let originalProcessCwd = ''

if (feature('HARNESS_TRACE')) {
  let processUserInputCalls = 0
  let fetchSystemPromptPartsImpl: () => Promise<{
    defaultSystemPrompt: string[]
    userContext: Record<string, string>
    systemContext: Record<string, string>
  }>

  const processUserInputMock = () => ({
    processUserInput: async () => {
      processUserInputCalls += 1
      throw new Error('input processing failed for trace boundary test')
    },
  })
  const queryContextMock = () => ({
    fetchSystemPromptParts: async () => fetchSystemPromptPartsImpl(),
  })

  mock.module(
    'src/utils/processUserInput/processUserInput.js',
    processUserInputMock,
  )
  mock.module(
    'src/utils/processUserInput/processUserInput.ts',
    processUserInputMock,
  )
  mock.module(
    '../../utils/processUserInput/processUserInput.js',
    processUserInputMock,
  )
  mock.module(
    '../../utils/processUserInput/processUserInput.ts',
    processUserInputMock,
  )
  mock.module('src/utils/queryContext.js', queryContextMock)
  mock.module('src/utils/queryContext.ts', queryContextMock)
  mock.module('../../utils/queryContext.js', queryContextMock)
  mock.module('../../utils/queryContext.ts', queryContextMock)

  const {
    getSessionId,
    resetStateForTests,
    setCwdState,
    setOriginalCwd,
    setProjectRoot,
    setSessionPersistenceDisabled,
  } = await import('../../bootstrap/state')
  const { QueryEngine } = await import('../../QueryEngine')
  const { getEmptyToolPermissionContext } = await import('../../Tool')
  const { flushTraceForTesting, resetTraceForTesting, startTraceSession } =
    await import('../bus')
  const { createFileStateCacheWithSizeLimit } = await import(
    '../../utils/fileStateCache'
  )
  const { getTraceConfigPath, getTraceRootDir } = await import('../paths')
  const { readTraceEvents } = await import('../store')

  let appState: any = createAppState()

  function getAppState(): any {
    return appState
  }

  function setAppState(updater: (state: any) => any): void {
    appState = updater(appState)
  }

  function createAppState(): any {
    return {
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
  }

  function createQueryEngine(
    customSystemPrompt: string,
    cwd = traceDir,
    overrides: Partial<ConstructorParameters<typeof QueryEngine>[0]> = {},
  ): InstanceType<typeof QueryEngine> {
    return new QueryEngine({
      cwd,
      tools: [],
      commands: [],
      mcpClients: [],
      agents: [],
      canUseTool: async (_tool, input) => ({
        behavior: 'allow',
        updatedInput: input,
      }),
      getAppState,
      setAppState,
      readFileCache: createFileStateCacheWithSizeLimit(10),
      customSystemPrompt,
      ...overrides,
    })
  }

  async function writeTraceConfig(config: TraceConfig): Promise<void> {
    await mkdir(getTraceRootDir(), { recursive: true })
    await writeFile(
      getTraceConfigPath(),
      `${JSON.stringify(config, null, 2)}\n`,
    )
  }

  describe('QueryEngine trace turn boundaries', () => {
    beforeEach(async () => {
      originalProcessCwd = process.cwd()
      traceDir = await mkdtemp(join(tmpdir(), 'claude-query-engine-trace-'))
      process.env.CLAUDE_CODE_TRACE_DIR = traceDir
      process.env.ANTHROPIC_API_KEY = 'test-api-key'
      resetStateForTests()
      resetTraceForTesting()
      setOriginalCwd(traceDir)
      setCwdState(traceDir)
      setProjectRoot(traceDir)
      appState = createAppState()
      processUserInputCalls = 0
      fetchSystemPromptPartsImpl = async () => ({
        defaultSystemPrompt: [],
        userContext: {},
        systemContext: {},
      })
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
      if (originalAnthropicApiKey === undefined) {
        delete process.env.ANTHROPIC_API_KEY
      } else {
        process.env.ANTHROPIC_API_KEY = originalAnthropicApiKey
      }

      if (originalProcessCwd) {
        process.chdir(originalProcessCwd)
      }

      await rm(traceDir, { recursive: true, force: true })
    })

    test('emits turn boundaries when input processing throws', async () => {
      startTraceSession({
        sessionId: 'session-query-engine-input-error',
        cwd: traceDir,
        argv: ['claude', '-p'],
      })

      const engine = createQueryEngine('test system prompt')

      const rawPrompt = 'raw prompt must not appear in boundary payloads'
      await expect(engine.submitMessage(rawPrompt).next()).rejects.toThrow(
        'input processing failed for trace boundary test',
      )
      await flushTraceForTesting()

      const events = readTraceEvents('session-query-engine-input-error')
      const boundaryEvents = events.filter(
        event => event.type === 'turn.start' || event.type === 'turn.end',
      )

      expect(boundaryEvents.map(event => event.type)).toEqual([
        'turn.start',
        'turn.end',
      ])
      expect(boundaryEvents[0].turnId).toBe(boundaryEvents[1].turnId)
      expect(boundaryEvents[0].payload).toMatchObject({
        inputMode: 'prompt',
        promptKind: 'text',
        messageCountBefore: 0,
      })
      expect(boundaryEvents[1].payload).toMatchObject({
        success: false,
        error: true,
        aborted: false,
        errorName: 'Error',
        finalMessageCount: 0,
      })
      expect(JSON.stringify(boundaryEvents)).not.toContain(rawPrompt)
    })

    test('starts a fresh persisted learn trace session before first turn event', async () => {
      const engine = createQueryEngine('test system prompt')
      const sessionId = getSessionId()

      await expect(engine.submitMessage('hello').next()).rejects.toThrow(
        'input processing failed for trace boundary test',
      )
      await flushTraceForTesting()

      const events = readTraceEvents(sessionId)
      expect(events.map(event => event.type)).toEqual([
        'trace.session_start',
        'turn.start',
        'turn.end',
      ])
      expect(events.every(event => event.sessionId === sessionId)).toBe(true)
      expect(events[1].turnId).toBe(events[2].turnId)
    })

    test('emits turn boundaries when system prompt setup throws before input processing', async () => {
      fetchSystemPromptPartsImpl = async () => {
        throw new Error('system prompt setup failed for trace boundary test')
      }

      startTraceSession({
        sessionId: 'session-query-engine-system-prompt-error',
        cwd: traceDir,
        argv: ['claude', '-p'],
      })

      const systemPromptText = 'test system prompt must not appear in trace'
      const engine = createQueryEngine(systemPromptText)

      const rawPrompt = 'raw prompt must not appear in setup boundary payloads'
      await expect(engine.submitMessage(rawPrompt).next()).rejects.toThrow(
        'system prompt setup failed for trace boundary test',
      )
      expect(processUserInputCalls).toBe(0)
      await flushTraceForTesting()

      const events = readTraceEvents('session-query-engine-system-prompt-error')
      const boundaryEvents = events.filter(
        event => event.type === 'turn.start' || event.type === 'turn.end',
      )

      expect(boundaryEvents.map(event => event.type)).toEqual([
        'turn.start',
        'turn.end',
      ])
      expect(boundaryEvents[0].turnId).toBe(boundaryEvents[1].turnId)
      expect(boundaryEvents[0].payload).toMatchObject({
        inputMode: 'prompt',
        promptKind: 'text',
        messageCountBefore: 0,
      })
      expect(boundaryEvents[1].payload).toMatchObject({
        success: false,
        error: true,
        aborted: false,
        errorName: 'Error',
        finalMessageCount: 0,
      })
      expect(JSON.stringify(boundaryEvents)).not.toContain(rawPrompt)
      expect(JSON.stringify(boundaryEvents)).not.toContain(systemPromptText)
    })

    test('emits turn boundaries when cwd setup throws before normal setup', async () => {
      startTraceSession({
        sessionId: 'session-query-engine-cwd-error',
        cwd: traceDir,
        argv: ['claude', '-p'],
      })

      const missingCwd = join(traceDir, 'missing-cwd')
      const engine = createQueryEngine('test system prompt', missingCwd)

      const rawPrompt = 'raw prompt must not appear in cwd boundary payloads'
      await expect(engine.submitMessage(rawPrompt).next()).rejects.toThrow(
        `Path "${missingCwd}" does not exist`,
      )
      expect(processUserInputCalls).toBe(0)
      await flushTraceForTesting()

      const events = readTraceEvents('session-query-engine-cwd-error')
      const boundaryEvents = events.filter(
        event => event.type === 'turn.start' || event.type === 'turn.end',
      )

      expect(boundaryEvents.map(event => event.type)).toEqual([
        'turn.start',
        'turn.end',
      ])
      expect(boundaryEvents[0].turnId).toBe(boundaryEvents[1].turnId)
      expect(boundaryEvents[0].payload).toMatchObject({
        inputMode: 'prompt',
        promptKind: 'text',
        messageCountBefore: 0,
      })
      expect(boundaryEvents[1].payload).toMatchObject({
        success: false,
        error: true,
        aborted: false,
        errorName: 'Error',
        finalMessageCount: 0,
      })
      expect(JSON.stringify(boundaryEvents)).not.toContain(rawPrompt)
      expect(JSON.stringify(boundaryEvents)).not.toContain(missingCwd)
    })

    test('propagates turnId to orphaned permission tool execution traces', async () => {
      setSessionPersistenceDisabled(true)
      const tool = createOrphanedPermissionTraceTool()
      const assistantMessage = createOrphanedPermissionAssistantMessage()
      startTraceSession({
        sessionId: 'session-query-engine-orphaned-permission',
        cwd: traceDir,
        argv: ['claude', '-p'],
      })

      const engine = createQueryEngine('test system prompt', traceDir, {
        tools: [tool],
        orphanedPermission: {
          assistantMessage,
          permissionResult: {
            behavior: 'allow',
            updatedInput: { payload: 'approved payload' },
            toolUseID: 'toolu_orphaned_permission_1',
          } as any,
        },
      })

      await expect(
        drainSubmitUntilDone(engine.submitMessage('prompt after permission')),
      ).rejects.toThrow('input processing failed for trace boundary test')
      await flushTraceForTesting()

      const events = readTraceEvents('session-query-engine-orphaned-permission')
      const turnId = events.find(event => event.type === 'turn.start')?.turnId
      const toolEvents = events.filter(
        event =>
          event.type.startsWith('tool.') || event.type.startsWith('hook.'),
      )

      expect(typeof turnId).toBe('string')
      expect(toolEvents.map(event => event.type)).toEqual([
        'tool.detected',
        'hook.started',
        'hook.result',
        'tool.permission_result',
        'tool.started',
        'hook.started',
        'hook.result',
        'tool.result',
      ])
      expect(toolEvents.every(event => event.turnId === turnId)).toBe(true)
      expect(toolEvents.every(event => event.turnId !== undefined)).toBe(true)
      expect(
        toolEvents.every(
          event => event.parentId === 'msg_orphaned_permission_trace',
        ),
      ).toBe(true)
      expect(
        toolEvents.find(event => event.type === 'tool.permission_result')
          ?.payload,
      ).toMatchObject({
        toolName: 'TraceOrphanedPermissionTool',
        toolUseId: 'toolu_orphaned_permission_1',
        decision: 'allow',
        durationMs: expect.any(Number),
      })
    })
  })

  async function drainSubmitUntilDone(
    generator: AsyncGenerator<unknown, void, unknown>,
  ): Promise<void> {
    let next = await generator.next()
    while (!next.done) {
      next = await generator.next()
    }
  }

  function createOrphanedPermissionTraceTool(): any {
    return {
      name: 'TraceOrphanedPermissionTool',
      inputSchema: z.object({
        payload: z.string(),
      }),
      isConcurrencySafe: () => false,
      isEnabled: () => true,
      isReadOnly: () => true,
      prompt: async () => '',
      description: async () => 'Trace orphaned permission test tool',
      userFacingName: () => 'TraceOrphanedPermissionTool',
      toAutoClassifierInput: () => '',
      maxResultSizeChars: Infinity,
      renderToolUseMessage: () => null,
      mapToolResultToToolResultBlockParam: (
        content: unknown,
        toolUseId: string,
      ) => ({
        type: 'tool_result',
        content: JSON.stringify(content),
        tool_use_id: toolUseId,
        is_error: false,
      }),
      call: async () => ({ data: { ok: true } }),
    }
  }

  function createOrphanedPermissionAssistantMessage(): any {
    return {
      type: 'assistant',
      uuid: 'assistant-orphaned-permission-uuid',
      timestamp: new Date().toISOString(),
      requestId: 'req-orphaned-permission-trace',
      message: {
        id: 'msg_orphaned_permission_trace',
        type: 'message',
        role: 'assistant',
        model: 'test-model',
        stop_reason: 'tool_use',
        stop_sequence: null,
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        content: [
          {
            id: 'toolu_orphaned_permission_1',
            type: 'tool_use',
            name: 'TraceOrphanedPermissionTool',
            input: {
              payload: 'original payload',
            },
          },
        ],
      },
    }
  }
} else {
  describe('QueryEngine trace turn boundaries', () => {
    test('does not pass traceTurnId to query params when HARNESS_TRACE is disabled', async () => {
      let capturedQueryParams: Record<string, unknown> | undefined

      const queryMock = () => ({
        query: async function* (params: Record<string, unknown>) {
          capturedQueryParams = params
          yield { type: 'stream_request_start' }
          return { reason: 'completed' }
        },
      })
      const processUserInputMock = () => ({
        processUserInput: async () => ({
          messages: [
            {
              type: 'user',
              uuid: 'user-message-disabled-trace',
              timestamp: new Date().toISOString(),
              message: {
                role: 'user',
                content: 'hello',
              },
            },
          ],
          shouldQuery: true,
          allowedTools: [],
        }),
      })
      const queryContextMock = () => ({
        fetchSystemPromptParts: async () => ({
          defaultSystemPrompt: [],
          userContext: {},
          systemContext: {},
        }),
      })
      mock.module('../../query.js', queryMock)
      mock.module('../../query.ts', queryMock)
      mock.module('src/query.js', queryMock)
      mock.module('src/query.ts', queryMock)
      mock.module(
        '../../utils/processUserInput/processUserInput.js',
        processUserInputMock,
      )
      mock.module(
        '../../utils/processUserInput/processUserInput.ts',
        processUserInputMock,
      )
      mock.module(
        'src/utils/processUserInput/processUserInput.js',
        processUserInputMock,
      )
      mock.module(
        'src/utils/processUserInput/processUserInput.ts',
        processUserInputMock,
      )
      mock.module('../../utils/queryContext.js', queryContextMock)
      mock.module('../../utils/queryContext.ts', queryContextMock)
      mock.module('src/utils/queryContext.js', queryContextMock)
      mock.module('src/utils/queryContext.ts', queryContextMock)

      const {
        resetStateForTests,
        setCwdState,
        setOriginalCwd,
        setProjectRoot,
        setSessionPersistenceDisabled,
      } = await import('../../bootstrap/state')
      ;(globalThis as unknown as { MACRO: { VERSION: string } }).MACRO = {
        VERSION: 'test',
      }
      const { QueryEngine } = await import('../../QueryEngine')
      const { getEmptyToolPermissionContext } = await import('../../Tool')
      const { createFileStateCacheWithSizeLimit } = await import(
        '../../utils/fileStateCache'
      )
      const { resetTraceForTesting } = await import('../bus')

      resetStateForTests()
      resetTraceForTesting()
      const cwd = await mkdtemp(join(tmpdir(), 'claude-query-engine-no-trace-'))

      try {
        process.env.ANTHROPIC_API_KEY = 'test-api-key'
        setOriginalCwd(cwd)
        setCwdState(cwd)
        setProjectRoot(cwd)
        setSessionPersistenceDisabled(true)

        let appState: any = {
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

        const engine = new QueryEngine({
          cwd,
          tools: [],
          commands: [],
          mcpClients: [],
          agents: [],
          canUseTool: async (_tool, input) => ({
            behavior: 'allow',
            updatedInput: input,
          }),
          getAppState: () => appState,
          setAppState: updater => {
            appState = updater(appState)
          },
          readFileCache: createFileStateCacheWithSizeLimit(10),
          customSystemPrompt: 'test system prompt',
        })

        for await (const _message of engine.submitMessage('hello')) {
          // Drain the SDK generator so it reaches the mocked query call.
        }

        expect(capturedQueryParams).toBeDefined()
        expect(Object.hasOwn(capturedQueryParams!, 'traceTurnId')).toBe(false)
      } finally {
        if (originalAnthropicApiKey === undefined) {
          delete process.env.ANTHROPIC_API_KEY
        } else {
          process.env.ANTHROPIC_API_KEY = originalAnthropicApiKey
        }
        resetTraceForTesting()
        resetStateForTests()
        await rm(cwd, { recursive: true, force: true })
      }
    })
  })
}
