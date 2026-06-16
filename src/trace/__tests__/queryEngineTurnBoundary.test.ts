import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { feature } from 'bun:bundle'
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

  const { resetStateForTests, setCwdState, setOriginalCwd, setProjectRoot } =
    await import('../../bootstrap/state')
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
  ): InstanceType<typeof QueryEngine> {
    return new QueryEngine({
      cwd: traceDir,
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
  })
} else {
  describe('QueryEngine trace turn boundaries', () => {
    test('is gated behind HARNESS_TRACE', () => {
      expect(true).toBe(true)
    })
  })
}
