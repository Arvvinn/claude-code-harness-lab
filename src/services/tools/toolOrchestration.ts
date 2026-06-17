import { feature } from 'bun:bundle'
import type { ToolUseBlock } from '@anthropic-ai/sdk/resources/index.mjs'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import { findToolByName, type ToolUseContext } from '../../Tool.js'
import type { AssistantMessage, Message } from '../../types/message.js'
import { emitTrace } from '../../trace/bus.js'
import { all } from '../../utils/generators.js'
import {
  type MessageUpdateLazy,
  runToolUse,
  type ToolTraceMetadata,
} from './toolExecution.js'
import { createToolBatchSpan, endToolBatchSpan } from '../langfuse/index.js'

function getMaxToolUseConcurrency(): number {
  return (
    parseInt(process.env.CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY || '', 10) || 10
  )
}

export type MessageUpdate = {
  message?: Message
  newContext: ToolUseContext
}

export async function* runTools(
  toolUseMessages: ToolUseBlock[],
  assistantMessages: AssistantMessage[],
  canUseTool: CanUseToolFn,
  toolUseContext: ToolUseContext,
  traceMetadata?: ToolTraceMetadata,
): AsyncGenerator<MessageUpdate, void> {
  // Wrap all tool calls in this turn under a single Langfuse turn span
  const turnSpan =
    toolUseMessages.length > 0
      ? createToolBatchSpan(toolUseContext.langfuseTrace ?? null, {
          toolNames: toolUseMessages.map(b => b.name),
          batchIndex: 0,
        })
      : null
  const contextWithTurn = turnSpan
    ? { ...toolUseContext, langfuseBatchSpan: turnSpan }
    : toolUseContext

  let currentContext = contextWithTurn
  const batches = partitionToolCalls(toolUseMessages, currentContext)
  if (feature('HARNESS_TRACE')) {
    for (const toolUse of toolUseMessages) {
      emitToolOrchestrationTrace(
        traceMetadata,
        assistantMessages,
        'tool.detected',
        toolUse,
        {
          status: 'detected',
          durationMs: 0,
        },
      )
    }
  }

  const queuedTraceEmitted = new Set<string>()
  for (const [batchIndex, { isConcurrencySafe, blocks }] of batches.entries()) {
    if (feature('HARNESS_TRACE')) {
      if (batchIndex > 0) {
        for (const block of blocks) {
          emitQueuedToolTrace(
            traceMetadata,
            assistantMessages,
            queuedTraceEmitted,
            block,
            'sibling_completion',
          )
        }
      }
      if (isConcurrencySafe) {
        for (const block of blocks.slice(getMaxToolUseConcurrency())) {
          emitQueuedToolTrace(
            traceMetadata,
            assistantMessages,
            queuedTraceEmitted,
            block,
            'execution_slot_unavailable',
          )
        }
      }
    }
    if (isConcurrencySafe) {
      const queuedContextModifiers: Record<
        string,
        ((context: ToolUseContext) => ToolUseContext)[]
      > = {}
      // Run read-only batch concurrently
      for await (const update of runToolsConcurrently(
        blocks,
        assistantMessages,
        canUseTool,
        currentContext,
        traceMetadata,
      )) {
        if (update.contextModifier) {
          const { toolUseID, modifyContext } = update.contextModifier
          if (!queuedContextModifiers[toolUseID]) {
            queuedContextModifiers[toolUseID] = []
          }
          queuedContextModifiers[toolUseID].push(modifyContext)
        }
        yield {
          message: update.message,
          newContext: currentContext,
        }
      }
      for (const block of blocks) {
        const modifiers = queuedContextModifiers[block.id]
        if (!modifiers) {
          continue
        }
        for (const modifier of modifiers) {
          currentContext = modifier(currentContext)
        }
      }
      yield { newContext: currentContext }
    } else {
      // Run non-read-only batch serially
      for await (const update of runToolsSerially(
        blocks,
        assistantMessages,
        canUseTool,
        currentContext,
        traceMetadata,
      )) {
        if (update.newContext) {
          currentContext = update.newContext
        }
        yield {
          message: update.message,
          newContext: currentContext,
        }
      }
    }
  }

  endToolBatchSpan(turnSpan)
}

type Batch = { isConcurrencySafe: boolean; blocks: ToolUseBlock[] }

function findAssistantMessageForToolUse(
  assistantMessages: AssistantMessage[],
  toolUse: ToolUseBlock,
): AssistantMessage | undefined {
  return assistantMessages.find(
    message =>
      Array.isArray(message.message.content) &&
      message.message.content.some(
        content => content.type === 'tool_use' && content.id === toolUse.id,
      ),
  )
}

function emitToolOrchestrationTrace(
  traceMetadata: ToolTraceMetadata | undefined,
  assistantMessages: AssistantMessage[],
  type: 'tool.detected' | 'tool.queued',
  toolUse: ToolUseBlock,
  payload: Record<string, unknown>,
): void {
  emitTrace({
    source: 'tool',
    type,
    turnId: traceMetadata?.turnId,
    parentId: findAssistantMessageForToolUse(assistantMessages, toolUse)
      ?.message.id as string | undefined,
    payload: {
      toolUseId: toolUse.id,
      toolName: toolUse.name,
      ...payload,
    },
  })
}

function emitQueuedToolTrace(
  traceMetadata: ToolTraceMetadata | undefined,
  assistantMessages: AssistantMessage[],
  queuedTraceEmitted: Set<string>,
  toolUse: ToolUseBlock,
  queueReason: 'sibling_completion' | 'execution_slot_unavailable',
): void {
  if (queuedTraceEmitted.has(toolUse.id)) {
    return
  }
  queuedTraceEmitted.add(toolUse.id)
  emitToolOrchestrationTrace(
    traceMetadata,
    assistantMessages,
    'tool.queued',
    toolUse,
    {
      status: 'queued',
      queueReason,
      durationMs: 0,
    },
  )
}

/**
 * Partition tool calls into batches where each batch is either:
 * 1. A single non-read-only tool, or
 * 2. Multiple consecutive read-only tools
 */
function partitionToolCalls(
  toolUseMessages: ToolUseBlock[],
  toolUseContext: ToolUseContext,
): Batch[] {
  return toolUseMessages.reduce((acc: Batch[], toolUse) => {
    const tool = findToolByName(toolUseContext.options.tools, toolUse.name)
    const parsedInput = tool?.inputSchema.safeParse(toolUse.input)
    const isConcurrencySafe = parsedInput?.success
      ? (() => {
          try {
            return Boolean(tool?.isConcurrencySafe(parsedInput.data))
          } catch {
            // If isConcurrencySafe throws (e.g., due to shell-quote parse failure),
            // treat as not concurrency-safe to be conservative
            return false
          }
        })()
      : false
    if (isConcurrencySafe && acc[acc.length - 1]?.isConcurrencySafe) {
      acc[acc.length - 1]!.blocks.push(toolUse)
    } else {
      acc.push({ isConcurrencySafe, blocks: [toolUse] })
    }
    return acc
  }, [])
}

async function* runToolsSerially(
  toolUseMessages: ToolUseBlock[],
  assistantMessages: AssistantMessage[],
  canUseTool: CanUseToolFn,
  toolUseContext: ToolUseContext,
  traceMetadata?: ToolTraceMetadata,
): AsyncGenerator<MessageUpdate, void> {
  let currentContext = toolUseContext

  for (const toolUse of toolUseMessages) {
    toolUseContext.setInProgressToolUseIDs(prev =>
      new Set(prev).add(toolUse.id),
    )
    for await (const update of runToolUse(
      toolUse,
      assistantMessages.find(
        _ =>
          Array.isArray(_.message.content) &&
          _.message.content.some(
            _ => _.type === 'tool_use' && _.id === toolUse.id,
          ),
      )!,
      canUseTool,
      currentContext,
      traceMetadata,
    )) {
      if (update.contextModifier) {
        currentContext = update.contextModifier.modifyContext(currentContext)
      }
      yield {
        message: update.message,
        newContext: currentContext,
      }
    }
    markToolUseAsComplete(toolUseContext, toolUse.id)
  }
}

async function* runToolsConcurrently(
  toolUseMessages: ToolUseBlock[],
  assistantMessages: AssistantMessage[],
  canUseTool: CanUseToolFn,
  toolUseContext: ToolUseContext,
  traceMetadata?: ToolTraceMetadata,
): AsyncGenerator<MessageUpdateLazy, void> {
  yield* all(
    toolUseMessages.map(async function* (toolUse) {
      toolUseContext.setInProgressToolUseIDs(prev =>
        new Set(prev).add(toolUse.id),
      )
      yield* runToolUse(
        toolUse,
        assistantMessages.find(
          _ =>
            Array.isArray(_.message.content) &&
            _.message.content.some(
              _ => _.type === 'tool_use' && _.id === toolUse.id,
            ),
        )!,
        canUseTool,
        toolUseContext,
        traceMetadata,
      )
      markToolUseAsComplete(toolUseContext, toolUse.id)
    }),
    getMaxToolUseConcurrency(),
  )
}

function markToolUseAsComplete(
  toolUseContext: ToolUseContext,
  toolUseID: string,
) {
  toolUseContext.setInProgressToolUseIDs(prev => {
    const next = new Set(prev)
    next.delete(toolUseID)
    return next
  })
}
