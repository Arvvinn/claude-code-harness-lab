import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolUseBlock } from '@anthropic-ai/sdk/resources/index.mjs'
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { feature } from 'bun:bundle'
import { z } from 'zod/v4'
import type { ToolUseContext } from '../../../Tool.js'
import type { AssistantMessage } from '../../../types/message.js'
import type { TraceConfig, TraceEvent } from '../../../trace/types.js'

const originalTraceDir = process.env.CLAUDE_CODE_TRACE_DIR
let traceDir = ''
let sessionId = ''

type HookState = {
  seenPreContext: ToolUseContext | undefined
  seenPermissionContext: ToolUseContext | undefined
  resolvePermission: (input: Record<string, unknown>) => Promise<unknown>
  pre: (...args: unknown[]) => AsyncGenerator
  post: (...args: unknown[]) => AsyncGenerator
  failure: (...args: unknown[]) => AsyncGenerator
}

const hookState: HookState = {
  seenPreContext: undefined,
  seenPermissionContext: undefined,
  resolvePermission: async (input: Record<string, unknown>) => ({
    decision: {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'rule',
        rule: { source: 'session' },
      },
    },
    input,
  }),
  pre: (...args: unknown[]) => {
    hookState.seenPreContext = args[0] as ToolUseContext
    return noHookResults()
  },
  post: () => noHookResults(),
  failure: () => noHookResults(),
}

mock.module('src/services/tools/toolHooks.js', () => ({
  runPreToolUseHooks: (...args: unknown[]) =>
    (hookState.pre as (...innerArgs: unknown[]) => AsyncGenerator)(...args),
  runPostToolUseHooks: (...args: unknown[]) =>
    (hookState.post as (...innerArgs: unknown[]) => AsyncGenerator)(...args),
  runPostToolUseFailureHooks: (...args: unknown[]) =>
    (hookState.failure as (...innerArgs: unknown[]) => AsyncGenerator)(...args),
  resolveHookPermissionDecision: (...args: unknown[]) => {
    hookState.seenPermissionContext = args[3] as ToolUseContext
    return (
      hookState.resolvePermission as (
        input: Record<string, unknown>,
      ) => Promise<unknown>
    )(args[2] as Record<string, unknown>)
  },
}))

mock.module('src/services/skillLearning/featureCheck.js', () => ({
  isSkillLearningCompiledIn: () => false,
  isSkillLearningEnabled: () => false,
}))

mock.module('src/tools.js', () => ({
  ALL_AGENT_DISALLOWED_TOOLS: [],
  ASYNC_AGENT_ALLOWED_TOOLS: [],
  COORDINATOR_MODE_ALLOWED_TOOLS: [],
  CUSTOM_AGENT_DISALLOWED_TOOLS: [],
  REPL_ONLY_TOOLS: [],
  TOOL_PRESETS: ['default'],
  assembleToolPool: () => [],
  filterToolsByDenyRules: (tools: unknown) => tools,
  getAllBaseTools: () => [],
  getMergedTools: () => [],
  getTools: () => [],
  getToolsForDefaultPreset: () => [],
  parseToolPreset: () => 'default',
}))

const { runToolUse, toolExecutionTraceInternals } = await import(
  '../toolExecution.js'
)
const { runTools } = await import('../toolOrchestration.js')
const { flushTraceForTesting, resetTraceForTesting, startTraceSession } =
  await import('../../../trace/bus.js')
const { getTraceConfigPath, getTraceRootDir } = await import(
  '../../../trace/paths.js'
)
const { readTraceEvents } = await import('../../../trace/store.js')

async function* noHookResults(): AsyncGenerator<never, void, unknown> {
  if (false) {
    yield undefined as never
  }
}

async function* throwHookError(
  error: Error,
): AsyncGenerator<never, void, unknown> {
  yield* noHookResults()
  throw error
}

describe('runToolUse trace instrumentation', () => {
  beforeEach(async () => {
    traceDir = await mkdtemp(join(tmpdir(), 'tool-exec-trace-test-'))
    sessionId = `session-${crypto.randomUUID()}`
    process.env.CLAUDE_CODE_TRACE_DIR = traceDir
    resetTraceForTesting()
    await writeTraceConfig({ mode: 'learn', autoTailWindow: false })
  })

  afterEach(() => {
    hookState.seenPreContext = undefined
    hookState.seenPermissionContext = undefined
    hookState.resolvePermission = async (input: Record<string, unknown>) => ({
      decision: {
        behavior: 'allow',
        updatedInput: input,
        decisionReason: {
          type: 'rule',
          rule: { source: 'session' },
        },
      },
      input,
    })
    hookState.pre = (...args: unknown[]) => {
      hookState.seenPreContext = args[0] as ToolUseContext
      return noHookResults()
    }
    hookState.post = () => noHookResults()
    hookState.failure = () => noHookResults()
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

  test('does not emit trace events without an active trace session', async () => {
    const tool = makeTraceTestTool({
      call: async () => ({ data: { ok: true } }),
    })
    const toolUseContext = makeToolUseContext(tool)
    const assistantMessage = makeAssistantMessage('assistant-parent-tool-off')

    await drainRunToolUse(
      makeToolUseBlock('toolu_trace_off_1'),
      assistantMessage,
      toolUseContext,
    )

    await flushTraceForTesting()
    expect(await readdir(getTraceRootDir())).toEqual(['config.json'])
  })

  if (feature('HARNESS_TRACE')) {
    test('emits detected and queued events for non-streaming serial tool execution', async () => {
      const firstTool = makeTraceTestTool({
        name: 'TraceExecTool',
        call: async () => ({ data: { ok: true } }),
      })
      const secondTool = makeTraceTestTool({
        name: 'TraceSecondTool',
        call: async () => ({ data: { ok: true } }),
      })
      const firstBlock = makeToolUseBlock(
        'toolu_nonstream_serial_1',
        'TraceExecTool',
      )
      const secondBlock = makeToolUseBlock(
        'toolu_nonstream_serial_2',
        'TraceSecondTool',
      )
      const toolUseContext = makeToolUseContext([firstTool, secondTool])
      const assistantMessage = makeAssistantMessageWithToolUses(
        'assistant-parent-nonstream-serial',
        [firstBlock, secondBlock],
      )

      startTraceSession({
        sessionId,
        cwd: traceDir,
        argv: ['claude', '-p'],
      })
      for await (const _update of runTools(
        [firstBlock, secondBlock],
        [assistantMessage],
        async (_tool, input) => ({ behavior: 'allow', updatedInput: input }),
        toolUseContext,
        { turnId: 'turn-nonstream-serial' },
      )) {
        // Drain generator
      }
      await flushTraceForTesting()

      const events = getNonSessionEvents()
      expect(events.filter(event => event.type === 'tool.detected')).toEqual([
        expect.objectContaining({
          turnId: 'turn-nonstream-serial',
          parentId: assistantMessage.message.id,
          payload: expect.objectContaining({
            toolName: 'TraceExecTool',
            toolUseId: 'toolu_nonstream_serial_1',
            status: 'detected',
            durationMs: 0,
          }),
        }),
        expect.objectContaining({
          turnId: 'turn-nonstream-serial',
          parentId: assistantMessage.message.id,
          payload: expect.objectContaining({
            toolName: 'TraceSecondTool',
            toolUseId: 'toolu_nonstream_serial_2',
            status: 'detected',
            durationMs: 0,
          }),
        }),
      ])
      expect(events.find(event => event.type === 'tool.queued')).toEqual(
        expect.objectContaining({
          turnId: 'turn-nonstream-serial',
          parentId: assistantMessage.message.id,
          payload: expect.objectContaining({
            toolName: 'TraceSecondTool',
            toolUseId: 'toolu_nonstream_serial_2',
            status: 'queued',
            queueReason: 'sibling_completion',
            durationMs: 0,
          }),
        }),
      )
    })

    test('emits tool.error for non-streaming unknown tool failures', async () => {
      const toolUseContext = makeToolUseContext([])
      const assistantMessage = makeAssistantMessage('assistant-parent-unknown')

      startTraceSession({
        sessionId,
        cwd: traceDir,
        argv: ['claude', '-p'],
      })
      await drainRunToolUse(
        makeToolUseBlock('toolu_trace_unknown_1', 'MissingTraceTool'),
        assistantMessage,
        toolUseContext,
        { turnId: 'turn-tool-unknown' },
      )
      await flushTraceForTesting()

      expect(getNonSessionEvents()).toEqual([
        expect.objectContaining({
          type: 'tool.error',
          turnId: 'turn-tool-unknown',
          parentId: assistantMessage.message.id,
          payload: expect.objectContaining({
            toolName: 'MissingTraceTool',
            toolUseId: 'toolu_trace_unknown_1',
            classification: 'unknown_tool',
            errorName: 'UnknownToolError',
            message: 'No such tool available: MissingTraceTool',
            durationMs: 0,
          }),
        }),
      ])
    })

    test('emits success lifecycle without exposing traceTurnId to hooks or tool.call', async () => {
      const seenCallContexts: ToolUseContext[] = []
      const tool = makeTraceTestTool({
        call: async (_input, context) => {
          seenCallContexts.push(context)
          return { data: { ok: true, token: 'Bearer result-secret' } }
        },
      })
      const toolUseContext = makeToolUseContext(tool)
      const assistantMessage = makeAssistantMessage(
        'assistant-parent-tool-success',
      )

      startTraceSession({
        sessionId,
        cwd: traceDir,
        argv: ['claude', '-p'],
      })
      await drainRunToolUse(
        makeToolUseBlock('toolu_trace_success_1'),
        assistantMessage,
        toolUseContext,
        { turnId: 'turn-tool-success' },
      )
      await flushTraceForTesting()

      const events = getNonSessionEvents()
      expect(events.map(event => event.type)).toEqual([
        'hook.started',
        'hook.result',
        'tool.permission_result',
        'tool.started',
        'hook.started',
        'hook.result',
        'tool.result',
      ])
      expect(events.every(event => event.turnId === 'turn-tool-success')).toBe(
        true,
      )
      expect(
        events.every(event => event.parentId === assistantMessage.message.id),
      ).toBe(true)
      for (const event of events) {
        expect(event.payload).toMatchObject({
          toolName: 'TraceExecTool',
          toolUseId: 'toolu_trace_success_1',
        })
        expect(event.payload).toHaveProperty('durationMs')
      }
      expect(
        events.filter(event => event.type === 'tool.started'),
      ).toHaveLength(1)
      expect(hookState.seenPreContext).not.toHaveProperty('traceTurnId')
      expect(hookState.seenPermissionContext).not.toHaveProperty('traceTurnId')
      expect(seenCallContexts).toHaveLength(1)
      expect(seenCallContexts[0]).not.toHaveProperty('traceTurnId')
      expect(JSON.stringify(events)).not.toContain('model input secret')
    })

    test('emits validation tool.error for schema validation failure without raw input', async () => {
      const tool = makeTraceTestTool({
        call: async () => ({ data: { ok: true } }),
      })
      const toolUseContext = makeToolUseContext(tool)
      const assistantMessage = makeAssistantMessage(
        'assistant-parent-schema-error',
      )

      startTraceSession({
        sessionId,
        cwd: traceDir,
        argv: ['claude', '-p'],
      })
      await drainRunToolUse(
        {
          ...makeToolUseBlock('toolu_trace_schema_error_1'),
          input: { secret: 42 },
        } as ToolUseBlock,
        assistantMessage,
        toolUseContext,
        { turnId: 'turn-tool-schema-error' },
      )
      await flushTraceForTesting()

      const errorEvent = getNonSessionEvents().find(
        event => event.type === 'tool.error',
      )
      expect(errorEvent).toBeDefined()
      expect(errorEvent?.turnId).toBe('turn-tool-schema-error')
      expect(errorEvent?.payload).toMatchObject({
        toolName: 'TraceExecTool',
        toolUseId: 'toolu_trace_schema_error_1',
        classification: 'validation',
        errorName: 'InputValidationError',
      })
      expect(JSON.stringify(errorEvent)).not.toContain('model input secret')
    })

    test('emits validation tool.error for validateInput failure', async () => {
      const tool = makeTraceTestTool({
        validateInput: async () => ({
          result: false,
          message: 'synthetic validateInput failure',
          errorCode: 'synthetic_validation',
        }),
        call: async () => ({ data: { ok: true } }),
      })
      const toolUseContext = makeToolUseContext(tool)
      const assistantMessage = makeAssistantMessage(
        'assistant-parent-validate-error',
      )

      startTraceSession({
        sessionId,
        cwd: traceDir,
        argv: ['claude', '-p'],
      })
      await drainRunToolUse(
        makeToolUseBlock('toolu_trace_validate_error_1'),
        assistantMessage,
        toolUseContext,
        { turnId: 'turn-tool-validate-error' },
      )
      await flushTraceForTesting()

      const errorEvent = getNonSessionEvents().find(
        event => event.type === 'tool.error',
      )
      expect(errorEvent?.payload).toMatchObject({
        classification: 'validation',
        errorName: 'InputValidationError',
        message: 'synthetic validateInput failure',
      })
    })

    test('emits permission_result and permission_denied tool.error for deny decisions', async () => {
      hookState.resolvePermission = async (input: Record<string, unknown>) => ({
        decision: {
          behavior: 'deny',
          message: 'Permission denied by test',
          updatedInput: input,
          decisionReason: {
            type: 'rule',
            rule: { source: 'localSettings' },
          },
        },
        input,
      })
      const tool = makeTraceTestTool({
        call: async () => ({ data: { ok: true } }),
      })
      const toolUseContext = makeToolUseContext(tool)
      const assistantMessage = makeAssistantMessage(
        'assistant-parent-permission-deny',
      )

      startTraceSession({
        sessionId,
        cwd: traceDir,
        argv: ['claude', '-p'],
      })
      await drainRunToolUse(
        makeToolUseBlock('toolu_trace_permission_deny_1'),
        assistantMessage,
        toolUseContext,
        { turnId: 'turn-tool-permission-deny' },
      )
      await flushTraceForTesting()

      const events = getNonSessionEvents()
      expect(
        events.find(event => event.type === 'tool.permission_result')?.payload,
      ).toMatchObject({
        decision: 'deny',
        source: 'rule:localSettings',
        permissionMode: 'default',
      })
      expect(
        events.find(event => event.type === 'tool.error')?.payload,
      ).toMatchObject({
        classification: 'permission_denied',
        message: 'Permission denied by test',
      })
    })

    test('emits permission_ask tool.error for ask-return-error decisions', async () => {
      hookState.resolvePermission = async (input: Record<string, unknown>) => ({
        decision: {
          behavior: 'ask',
          message: 'Permission ask returned error',
          updatedInput: input,
          decisionReason: {
            type: 'mode',
            mode: 'default',
          },
        },
        input,
      })
      const tool = makeTraceTestTool({
        call: async () => ({ data: { ok: true } }),
      })
      const toolUseContext = makeToolUseContext(tool)
      const assistantMessage = makeAssistantMessage(
        'assistant-parent-permission-ask',
      )

      startTraceSession({
        sessionId,
        cwd: traceDir,
        argv: ['claude', '-p'],
      })
      await drainRunToolUse(
        makeToolUseBlock('toolu_trace_permission_ask_1'),
        assistantMessage,
        toolUseContext,
        { turnId: 'turn-tool-permission-ask' },
      )
      await flushTraceForTesting()

      const events = getNonSessionEvents()
      expect(
        events.find(event => event.type === 'tool.permission_result')?.payload,
      ).toMatchObject({
        decision: 'ask',
        source: 'mode',
        permissionMode: 'default',
      })
      expect(
        events.find(event => event.type === 'tool.error')?.payload,
      ).toMatchObject({
        classification: 'permission_ask',
        message: 'Permission ask returned error',
      })
    })

    test('emits tool.cancelled for direct pre-run cancellation', async () => {
      const tool = makeTraceTestTool({
        call: async () => ({ data: { ok: true } }),
      })
      const toolUseContext = makeToolUseContext(tool)
      toolUseContext.abortController.abort('interrupt')
      const assistantMessage = makeAssistantMessage(
        'assistant-parent-cancelled',
      )

      startTraceSession({
        sessionId,
        cwd: traceDir,
        argv: ['claude', '-p'],
      })
      await drainRunToolUse(
        makeToolUseBlock('toolu_trace_cancelled_1'),
        assistantMessage,
        toolUseContext,
        { turnId: 'turn-tool-cancelled' },
      )
      await flushTraceForTesting()

      expect(getNonSessionEvents()).toEqual([
        expect.objectContaining({
          type: 'tool.cancelled',
          turnId: 'turn-tool-cancelled',
          payload: expect.objectContaining({
            toolName: 'TraceExecTool',
            toolUseId: 'toolu_trace_cancelled_1',
            reason: 'user_interrupted',
            classification: 'user_interrupted',
          }),
        }),
      ])
    })

    test('pairs PreToolUse hook.result and emits tool.error when PreToolUse throws', async () => {
      hookState.pre = (...args: unknown[]) => {
        hookState.seenPreContext = args[0] as ToolUseContext
        return throwHookError(new Error('synthetic pre hook failure'))
      }
      const tool = makeTraceTestTool({
        call: async () => ({ data: { ok: true } }),
      })
      const toolUseContext = makeToolUseContext(tool)
      const assistantMessage = makeAssistantMessage('assistant-parent-pre-hook')

      startTraceSession({
        sessionId,
        cwd: traceDir,
        argv: ['claude', '-p'],
      })
      await drainRunToolUse(
        makeToolUseBlock('toolu_trace_pre_hook_1'),
        assistantMessage,
        toolUseContext,
        { turnId: 'turn-tool-pre-hook' },
      )
      await flushTraceForTesting()

      const events = getNonSessionEvents()
      expect(events.map(event => event.type)).toEqual([
        'hook.started',
        'hook.result',
        'tool.error',
      ])
      expect(events[1].payload).toMatchObject({
        hookEvent: 'PreToolUse',
        status: 'error',
        errorName: 'Error',
        message: 'synthetic pre hook failure',
      })
      expect(events[2].payload).toMatchObject({
        classification: 'hook_error',
        errorName: 'Error',
        message: 'synthetic pre hook failure',
      })
    })

    test('pairs PostToolUse hook.result and emits tool.error when PostToolUse throws', async () => {
      hookState.post = () =>
        throwHookError(new Error('synthetic post hook failure'))
      const tool = makeTraceTestTool({
        call: async () => ({ data: { ok: true } }),
      })
      const toolUseContext = makeToolUseContext(tool)
      const assistantMessage = makeAssistantMessage(
        'assistant-parent-post-hook',
      )

      startTraceSession({
        sessionId,
        cwd: traceDir,
        argv: ['claude', '-p'],
      })
      await drainRunToolUse(
        makeToolUseBlock('toolu_trace_post_hook_1'),
        assistantMessage,
        toolUseContext,
        { turnId: 'turn-tool-post-hook' },
      )
      await flushTraceForTesting()

      const postResultEvent = getNonSessionEvents().find(
        event =>
          event.type === 'hook.result' &&
          event.payload.hookEvent === 'PostToolUse',
      )
      const toolErrorEvent = getNonSessionEvents().find(
        event => event.type === 'tool.error',
      )
      expect(postResultEvent?.payload).toMatchObject({
        status: 'error',
        errorName: 'Error',
        message: 'synthetic post hook failure',
      })
      expect(toolErrorEvent?.payload).toMatchObject({
        classification: 'hook_error',
        errorName: 'Error',
        message: 'synthetic post hook failure',
      })
    })

    test('pairs PostToolUseFailure hook.result when failure hook throws', async () => {
      hookState.failure = () =>
        throwHookError(new Error('synthetic failure hook failure'))
      const tool = makeTraceTestTool({
        call: async () => {
          throw new Error('synthetic tool failure')
        },
      })
      const toolUseContext = makeToolUseContext(tool)
      const assistantMessage = makeAssistantMessage(
        'assistant-parent-failure-hook',
      )

      startTraceSession({
        sessionId,
        cwd: traceDir,
        argv: ['claude', '-p'],
      })
      await drainRunToolUse(
        makeToolUseBlock('toolu_trace_failure_hook_1'),
        assistantMessage,
        toolUseContext,
        { turnId: 'turn-tool-failure-hook' },
      )
      await flushTraceForTesting()

      const events = getNonSessionEvents()
      const failureResultEvent = events.find(
        event =>
          event.type === 'hook.result' &&
          event.payload.hookEvent === 'PostToolUseFailure',
      )
      expect(failureResultEvent?.payload).toMatchObject({
        status: 'error',
        errorName: 'Error',
        message: 'synthetic failure hook failure',
      })
      expect(
        events.filter(event => event.type === 'tool.error').at(-1)?.payload,
      ).toMatchObject({
        classification: 'hook_error',
        errorName: 'Error',
        message: 'synthetic failure hook failure',
      })
    })
  }

  test('builds summarized learn-mode and payload-carrying full-mode result traces', () => {
    const learnPayload =
      toolExecutionTraceInternals.buildToolResultTracePayload({
        durationMs: 33,
        toolOutput: {
          token: 'Bearer result-secret',
          nested: { apiKey: 'sk-result-secret' },
        },
        toolResultSizeBytes: 128,
        traceMode: 'learn',
      })
    const fullPayload = toolExecutionTraceInternals.buildToolResultTracePayload(
      {
        durationMs: 34,
        toolOutput: {
          token: 'Bearer result-secret',
          nested: { apiKey: 'sk-result-secret' },
        },
        toolResultSizeBytes: 129,
        traceMode: 'full',
      },
    )

    expect(learnPayload).toMatchObject({
      status: 'ok',
      ok: true,
      durationMs: 33,
      resultKind: 'object',
      toolResultSizeBytes: 128,
    })
    expect(learnPayload).not.toHaveProperty('resultPayload')
    expect(fullPayload).toMatchObject({
      status: 'ok',
      ok: true,
      resultPayload: {
        token: 'Bearer result-secret',
        nested: { apiKey: 'sk-result-secret' },
      },
    })
  })
})

async function drainRunToolUse(
  toolUse: ToolUseBlock,
  assistantMessage: AssistantMessage,
  toolUseContext: ToolUseContext,
  traceMetadata?: { turnId?: string },
): Promise<void> {
  for await (const _update of runToolUse(
    toolUse,
    assistantMessage,
    async (_tool, input) => ({ behavior: 'allow', updatedInput: input }),
    toolUseContext,
    traceMetadata,
  )) {
    // Drain generator
  }
}

function getNonSessionEvents(): TraceEvent[] {
  return readTraceEvents(sessionId).filter(
    event => event.type !== 'trace.session_start',
  )
}

function makeTraceTestTool(input: {
  name?: string
  call: (
    input: { secret: string },
    context: ToolUseContext,
  ) => Promise<{ data: Record<string, unknown> }>
  validateInput?: (
    input: { secret: string },
    context: ToolUseContext,
  ) => Promise<{ result: false; message: string; errorCode?: string }>
  inputSchema?: z.ZodTypeAny
}) {
  const name = input.name ?? 'TraceExecTool'
  return {
    name,
    inputSchema:
      input.inputSchema ??
      z.object({
        secret: z.string(),
      }),
    isConcurrencySafe: () => false,
    isEnabled: () => true,
    isReadOnly: () => true,
    prompt: async () => '',
    description: async () => 'Trace execution test tool',
    userFacingName: () => name,
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
    validateInput: input.validateInput,
    call: async (parsedInput: { secret: string }, context: ToolUseContext) =>
      input.call(parsedInput, context),
  } as any
}

function makeToolUseContext(
  tool:
    | ReturnType<typeof makeTraceTestTool>
    | ReturnType<typeof makeTraceTestTool>[],
): ToolUseContext {
  const tools = Array.isArray(tool) ? tool : [tool]
  let appState = {
    toolPermissionContext: { mode: 'default' },
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
      mainLoopModel: 'test-model',
      tools,
      verbose: false,
      thinkingConfig: { type: 'disabled' },
      mcpClients: [],
      mcpResources: {},
      isNonInteractiveSession: true,
      agentDefinitions: { builtinAgents: [], customAgents: [] } as any,
    },
    abortController: new AbortController(),
    readFileState: {
      get: () => undefined,
      set: () => {},
      delete: () => false,
      has: () => false,
      clear: () => {},
    } as any,
    getAppState: () => appState as any,
    setAppState: (updater: (state: typeof appState) => typeof appState) => {
      appState = updater(appState)
    },
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
    messages: [],
  } as unknown as ToolUseContext
}

function makeToolUseBlock(
  toolUseId: string,
  toolName = 'TraceExecTool',
): ToolUseBlock {
  return {
    id: toolUseId,
    type: 'tool_use',
    name: toolName,
    input: {
      secret: 'model input secret',
    },
  } as ToolUseBlock
}

function makeAssistantMessageWithToolUses(
  messageId: string,
  toolUseBlocks: ToolUseBlock[],
): AssistantMessage {
  return {
    type: 'assistant',
    uuid: `${messageId}-uuid`,
    timestamp: new Date().toISOString(),
    requestId: 'req-trace-tool',
    message: {
      id: messageId,
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
      content: toolUseBlocks,
    },
  } as unknown as AssistantMessage
}

function makeAssistantMessage(messageId: string): AssistantMessage {
  return makeAssistantMessageWithToolUses(messageId, [])
}

async function writeTraceConfig(config: TraceConfig): Promise<void> {
  await mkdir(getTraceRootDir(), { recursive: true })
  await writeFile(getTraceConfigPath(), `${JSON.stringify(config, null, 2)}\n`)
}
