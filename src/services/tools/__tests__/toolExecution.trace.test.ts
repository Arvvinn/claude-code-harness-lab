import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolUseBlock } from '@anthropic-ai/sdk/resources/index.mjs'
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { z } from 'zod/v4'
import type { ToolUseContext } from '../../../Tool.js'
import type { AssistantMessage } from '../../../types/message.js'
import type { TraceConfig } from '../../../trace/types.js'

const originalTraceDir = process.env.CLAUDE_CODE_TRACE_DIR
let traceDir = ''

const hookState = {
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
  pre: async function* () {},
  post: async function* () {},
  failure: async function* () {},
}

mock.module('src/services/tools/toolHooks.js', () => ({
  runPreToolUseHooks: (...args: any[]) => (hookState.pre as any)(...args),
  runPostToolUseHooks: (...args: any[]) => (hookState.post as any)(...args),
  runPostToolUseFailureHooks: (...args: any[]) =>
    (hookState.failure as any)(...args),
  resolveHookPermissionDecision: (...args: any[]) =>
    (hookState.resolvePermission as any)(...args),
}))

mock.module('src/services/skillLearning/featureCheck.js', () => ({
  isSkillLearningEnabled: () => false,
}))

mock.module('src/tools.js', () => ({
  getAllBaseTools: () => [],
}))

const { runToolUse, toolExecutionTraceInternals } = await import(
  '../toolExecution.js'
)
const { flushTraceForTesting, resetTraceForTesting } = await import(
  '../../../trace/bus.js'
)
const { getTraceConfigPath, getTraceRootDir } = await import(
  '../../../trace/paths.js'
)

describe('runToolUse trace instrumentation', () => {
  beforeEach(async () => {
    traceDir = await mkdtemp(join(tmpdir(), 'tool-exec-trace-test-'))
    process.env.CLAUDE_CODE_TRACE_DIR = traceDir
    resetTraceForTesting()
    await writeTraceConfig({ mode: 'learn', autoTailWindow: false })
  })

  afterEach(() => {
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
    hookState.pre = async function* () {}
    hookState.post = async function* () {}
    hookState.failure = async function* () {}
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
    const tool = makeTraceTestTool(async () => ({
      data: { ok: true },
    }))
    const toolUseContext = makeToolUseContext(tool, 'turn-tool-off')
    const assistantMessage = makeAssistantMessage('assistant-parent-tool-off')

    for await (const _update of runToolUse(
      makeToolUseBlock('toolu_trace_off_1'),
      assistantMessage,
      async (_tool, input) => ({ behavior: 'allow', updatedInput: input }),
      toolUseContext,
    )) {
      // Drain generator
    }

    await flushTraceForTesting()
    expect(await readdir(getTraceRootDir())).toEqual(['config.json'])
  })

  test('builds permission trace payloads without raw input fields', () => {
    const payload = toolExecutionTraceInternals.buildToolPermissionTracePayload(
      {
        decision: 'deny',
        permissionMode: 'default',
        reason: {
          type: 'hook',
          hookName: 'PermissionRequest',
        } as any,
        durationMs: 12,
      },
    )

    expect(payload).toEqual({
      decision: 'deny',
      source: 'hook:PermissionRequest',
      permissionMode: 'default',
      durationMs: 12,
    })
    expect(JSON.stringify(payload)).not.toContain('secret')
  })

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

  test('builds error trace payloads with classification metadata', () => {
    expect(
      toolExecutionTraceInternals.buildToolErrorTracePayload({
        error: new Error('synthetic tool failure'),
        durationMs: 44,
      }),
    ).toEqual({
      errorName: 'Error',
      message: 'synthetic tool failure',
      classification: 'non_retryable',
      durationMs: 44,
    })
  })

  test('declares tool execution tracepoints behind direct HARNESS_TRACE guards', () => {
    const source = readFileSync(
      new URL('../toolExecution.ts', import.meta.url),
      'utf8',
    )

    expect(source).toContain("'tool.permission_result'")
    expect(source).toContain("'hook.started'")
    expect(source).toContain("'hook.result'")
    expect(source).toContain("'tool.started'")
    expect(source).toContain("'tool.result'")
    expect(source).toContain("'tool.error'")
    expect(source).not.toContain("feature('HARNESS_TRACE') &&")
    expect(source).not.toContain('const isHarnessTrace')
  })
})

function makeTraceTestTool(
  call: (input: {
    secret: string
  }) => Promise<{ data: Record<string, unknown> }>,
) {
  return {
    name: 'TraceExecTool',
    inputSchema: z.object({
      secret: z.string(),
    }),
    isConcurrencySafe: () => false,
    isEnabled: () => true,
    isReadOnly: () => true,
    prompt: async () => '',
    description: async () => 'Trace execution test tool',
    userFacingName: () => 'TraceExecTool',
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
    call: async (input: { secret: string }) => call(input),
  } as any
}

function makeToolUseContext(
  tool: ReturnType<typeof makeTraceTestTool>,
  traceTurnId: string,
): ToolUseContext {
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
      tools: [tool],
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
    traceTurnId,
  } as unknown as ToolUseContext
}

function makeToolUseBlock(toolUseId: string): ToolUseBlock {
  return {
    id: toolUseId,
    type: 'tool_use',
    name: 'TraceExecTool',
    input: {
      secret: 'model input secret',
    },
  } as ToolUseBlock
}

function makeAssistantMessage(messageId: string): AssistantMessage {
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
      content: [],
    },
  } as unknown as AssistantMessage
}

async function writeTraceConfig(config: TraceConfig): Promise<void> {
  await mkdir(getTraceRootDir(), { recursive: true })
  await writeFile(getTraceConfigPath(), `${JSON.stringify(config, null, 2)}\n`)
}
