import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolUseBlock } from '@anthropic-ai/sdk/resources/index.mjs'
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { z } from 'zod/v4'
import type { ToolUseContext } from '../../../Tool.js'
import type { AssistantMessage } from '../../../types/message.js'
import type { TraceConfig, TraceEvent } from '../../../trace/types.js'

const originalTraceDir = process.env.CLAUDE_CODE_TRACE_DIR
let traceDir = ''
let sessionId = ''

mock.module('src/services/tools/toolHooks.js', () => ({
  runPreToolUseHooks: async function* () {},
  runPostToolUseHooks: async function* () {},
  runPostToolUseFailureHooks: async function* () {},
  resolveHookPermissionDecision: async (
    _hookPermissionResult: unknown,
    _tool: unknown,
    input: Record<string, unknown>,
  ) => ({
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

const { StreamingToolExecutor, streamingToolTraceInternals } = await import(
  '../StreamingToolExecutor.js'
)
const { flushTraceForTesting, resetTraceForTesting, startTraceSession } =
  await import('../../../trace/bus.js')
const { getTraceConfigPath, getTraceRootDir } = await import(
  '../../../trace/paths.js'
)
const { readTraceEvents } = await import('../../../trace/store.js')

describe('StreamingToolExecutor trace instrumentation', () => {
  beforeEach(async () => {
    traceDir = await mkdtemp(join(tmpdir(), 'stream-trace-test-'))
    sessionId = `session-${crypto.randomUUID()}`
    process.env.CLAUDE_CODE_TRACE_DIR = traceDir
    resetTraceForTesting()
    await writeTraceConfig({ mode: 'learn', autoTailWindow: false })
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

  test('does not emit tool lifecycle events without an active trace session', async () => {
    const ctx = makeToolUseContext([makeToolDefinition()])
    const assistantMessage = makeAssistantMessage('assistant-parent-stream-off')
    const executor = new StreamingToolExecutor(
      [makeToolDefinition()],
      async (_tool, input) => ({ behavior: 'allow', updatedInput: input }),
      ctx,
    )

    executor.addTool(makeToolUseBlock('toolu_stream_off_1'), assistantMessage)
    await Promise.resolve()
    executor.discard()
    await flushTraceForTesting()

    expect(await readdir(getTraceRootDir())).toEqual(['config.json'])
  })

  test('emits detected, started, and result once for streaming success with internal turnId', async () => {
    const seenContexts: ToolUseContext[] = []
    const tool = makeToolDefinition({
      call: async (_input, context) => {
        seenContexts.push(context)
        return { data: { ok: true } }
      },
    })
    const ctx = makeToolUseContext([tool])
    const assistantMessage = makeAssistantMessage(
      'assistant-parent-stream-success',
    )
    const executor = new StreamingToolExecutor(
      [tool],
      async (_tool, input) => ({ behavior: 'allow', updatedInput: input }),
      ctx,
      { turnId: 'turn-stream-success' },
    )

    startTraceSession({
      sessionId,
      cwd: traceDir,
      argv: ['claude', '-p'],
    })
    executor.addTool(
      makeToolUseBlock('toolu_stream_success_1'),
      assistantMessage,
    )
    for await (const _update of executor.getRemainingResults()) {
      // Drain executor
    }
    await flushTraceForTesting()

    const events = getNonSessionEvents()
    expect(events.map(event => event.type)).toEqual([
      'tool.detected',
      'hook.started',
      'hook.result',
      'tool.permission_result',
      'tool.started',
      'hook.started',
      'hook.result',
      'tool.result',
    ])
    expect(events.filter(event => event.type === 'tool.started')).toHaveLength(
      1,
    )
    expect(events.every(event => event.turnId === 'turn-stream-success')).toBe(
      true,
    )
    expect(
      events.every(event => event.parentId === assistantMessage.message.id),
    ).toBe(true)
    expect(seenContexts).toHaveLength(1)
    expect(seenContexts[0]).not.toHaveProperty('traceTurnId')
  })

  test('emits queued when a streaming tool waits behind a sibling', async () => {
    let releaseFirstTool!: () => void
    const firstTool = makeToolDefinition({
      call: async () => {
        await new Promise<void>(resolve => {
          releaseFirstTool = resolve
        })
        return { data: { ok: true } }
      },
    })
    const secondTool = makeToolDefinition({ name: 'TraceSecondTool' })
    const ctx = makeToolUseContext([firstTool, secondTool])
    const assistantMessage = makeAssistantMessage(
      'assistant-parent-stream-queue',
    )
    const executor = new StreamingToolExecutor(
      [firstTool, secondTool],
      async (_tool, input) => ({ behavior: 'allow', updatedInput: input }),
      ctx,
      { turnId: 'turn-stream-queue' },
    )

    startTraceSession({
      sessionId,
      cwd: traceDir,
      argv: ['claude', '-p'],
    })
    executor.addTool(makeToolUseBlock('toolu_stream_queue_1'), assistantMessage)
    executor.addTool(
      makeToolUseBlock('toolu_stream_queue_2', 'TraceSecondTool'),
      assistantMessage,
    )
    await Promise.resolve()
    await flushTraceForTesting()

    const queuedEvent = getNonSessionEvents().find(
      event => event.type === 'tool.queued',
    )
    expect(queuedEvent?.turnId).toBe('turn-stream-queue')
    expect(queuedEvent?.payload).toMatchObject({
      toolName: 'TraceSecondTool',
      toolUseId: 'toolu_stream_queue_2',
      queueReason: 'execution_slot_unavailable',
    })

    releaseFirstTool()
    for await (const _update of executor.getRemainingResults()) {
      // Drain executor
    }
  })

  test('emits streaming_fallback cancellation with internal turnId on discard', async () => {
    const tool = makeToolDefinition({
      call: async (_input, context) => {
        await new Promise((_resolve, reject) => {
          context.abortController.signal.addEventListener(
            'abort',
            () => reject(new Error('aborted by test')),
            { once: true },
          )
        })
        return { data: { ok: true } }
      },
    })
    const ctx = makeToolUseContext([tool])
    const assistantMessage = makeAssistantMessage(
      'assistant-parent-stream-cancel',
    )
    const executor = new StreamingToolExecutor(
      [tool],
      async (_tool, input) => ({ behavior: 'allow', updatedInput: input }),
      ctx,
      { turnId: 'turn-stream-cancel' },
    )

    startTraceSession({
      sessionId,
      cwd: traceDir,
      argv: ['claude', '-p'],
    })
    executor.addTool(
      makeToolUseBlock('toolu_stream_cancel_1'),
      assistantMessage,
    )
    await Promise.resolve()
    executor.discard()
    await flushTraceForTesting()

    const cancelledEvent = getNonSessionEvents().find(
      event => event.type === 'tool.cancelled',
    )
    expect(cancelledEvent?.turnId).toBe('turn-stream-cancel')
    expect(cancelledEvent?.payload).toMatchObject({
      toolName: 'TraceTestTool',
      toolUseId: 'toolu_stream_cancel_1',
      reason: 'streaming_fallback',
      classification: 'streaming_fallback',
    })
  })

  test('builds streaming tool payloads with required correlation fields', () => {
    expect(
      streamingToolTraceInternals.buildStreamingToolTracePayload(
        'toolu_stream_1',
        'TraceTestTool',
        {
          status: 'queued',
          queueReason: 'execution_slot_unavailable',
          durationMs: 0,
        },
      ),
    ).toEqual({
      toolUseId: 'toolu_stream_1',
      toolName: 'TraceTestTool',
      status: 'queued',
      queueReason: 'execution_slot_unavailable',
      durationMs: 0,
    })
  })
})

function getNonSessionEvents(): TraceEvent[] {
  return readTraceEvents(sessionId).filter(
    event => event.type !== 'trace.session_start',
  )
}

function makeToolUseContext(tools: ReturnType<typeof makeToolDefinition>[]) {
  const abortController = new AbortController()
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
    abortController,
    readFileState: {
      get: () => undefined,
      set: () => {},
      delete: () => false,
      has: () => false,
      clear: () => {},
    } as any,
    getAppState: () =>
      ({
        toolPermissionContext: { mode: 'default' },
        fastMode: false,
        mcp: { tools: [], clients: [] },
        effortValue: undefined,
        advisorModel: undefined,
        sessionHooks: new Map(),
      }) as any,
    setAppState: () => {},
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
    messages: [],
  } as unknown as ToolUseContext
}

function makeToolDefinition(input?: {
  name?: string
  call?: (
    input: { payload: string },
    context: ToolUseContext,
  ) => Promise<{ data: Record<string, unknown> }>
}) {
  const name = input?.name ?? 'TraceTestTool'
  return {
    name,
    inputSchema: z.object({
      payload: z.string(),
    }),
    isConcurrencySafe: () => false,
    isEnabled: () => true,
    isReadOnly: () => true,
    prompt: async () => '',
    description: async () => 'Trace test tool',
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
    checkPermissions: async (input: Record<string, unknown>) => ({
      behavior: 'allow',
      updatedInput: input,
    }),
    call:
      input?.call ??
      (async () => ({
        data: { ok: true },
      })),
  } as any
}

function makeToolUseBlock(
  toolUseId: string,
  toolName = 'TraceTestTool',
): ToolUseBlock {
  return {
    id: toolUseId,
    type: 'tool_use',
    name: toolName,
    input: {
      payload: `${toolUseId}-payload`,
    },
  } as ToolUseBlock
}

function makeAssistantMessage(messageId: string): AssistantMessage {
  return {
    type: 'assistant',
    uuid: `${messageId}-uuid`,
    timestamp: new Date().toISOString(),
    requestId: 'req-trace-stream',
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
      content: [],
    },
  } as unknown as AssistantMessage
}

async function writeTraceConfig(config: TraceConfig): Promise<void> {
  await mkdir(getTraceRootDir(), { recursive: true })
  await writeFile(getTraceConfigPath(), `${JSON.stringify(config, null, 2)}\n`)
}
