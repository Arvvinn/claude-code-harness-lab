import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolUseBlock } from '@anthropic-ai/sdk/resources/index.mjs'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { z } from 'zod/v4'
import type { ToolUseContext } from '../../../Tool.js'
import type { AssistantMessage } from '../../../types/message.js'
import type { TraceConfig } from '../../../trace/types.js'

const originalTraceDir = process.env.CLAUDE_CODE_TRACE_DIR
let traceDir = ''

const { StreamingToolExecutor, streamingToolTraceInternals } = await import(
  '../StreamingToolExecutor.js'
)
const { flushTraceForTesting, resetTraceForTesting } = await import(
  '../../../trace/bus.js'
)
const { getTraceConfigPath, getTraceRootDir } = await import(
  '../../../trace/paths.js'
)

describe('StreamingToolExecutor trace instrumentation', () => {
  beforeEach(async () => {
    traceDir = await mkdtemp(join(tmpdir(), 'stream-trace-test-'))
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
    const ctx = makeToolUseContext('turn-stream-off')
    const assistantMessage = makeAssistantMessage('assistant-parent-stream-off')
    const executor = new StreamingToolExecutor(
      [makeBlockingToolDefinition()],
      async (_tool, input) => ({ behavior: 'allow', updatedInput: input }),
      ctx,
    )

    executor.addTool(makeToolUseBlock('toolu_stream_off_1'), assistantMessage)
    await Promise.resolve()
    executor.discard()
    await flushTraceForTesting()

    expect(await readdir(getTraceRootDir())).toEqual(['config.json'])
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

  test('declares streaming tracepoints behind direct HARNESS_TRACE guards', () => {
    const source = readFileSync(
      new URL('../StreamingToolExecutor.ts', import.meta.url),
      'utf8',
    )

    expect(source).toContain("'tool.detected'")
    expect(source).toContain("'tool.queued'")
    expect(source).toContain("'tool.started'")
    expect(source).toContain("'tool.cancelled'")
    expect(source).not.toContain("feature('HARNESS_TRACE') &&")
    expect(source).not.toContain('const isHarnessTrace')
  })
})

function makeToolUseContext(traceTurnId: string): ToolUseContext {
  const abortController = new AbortController()
  return {
    options: {
      commands: [],
      debug: false,
      mainLoopModel: 'test-model',
      tools: [makeBlockingToolDefinition()],
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
    traceTurnId,
  } as unknown as ToolUseContext
}

function makeBlockingToolDefinition() {
  return {
    name: 'TraceTestTool',
    inputSchema: z.object({
      payload: z.string(),
    }),
    isConcurrencySafe: () => false,
    isEnabled: () => true,
    isReadOnly: () => true,
    prompt: async () => '',
    description: async () => 'Trace test tool',
    userFacingName: () => 'TraceTestTool',
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
    call: async () => {
      await new Promise(() => {})
      return { data: { ok: true } }
    },
  } as any
}

function makeToolUseBlock(toolUseId: string): ToolUseBlock {
  return {
    id: toolUseId,
    type: 'tool_use',
    name: 'TraceTestTool',
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
