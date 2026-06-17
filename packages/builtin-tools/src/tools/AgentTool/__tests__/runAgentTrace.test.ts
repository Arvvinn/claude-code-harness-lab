import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import {
  createAssistantMessage,
  createUserMessage,
} from 'src/utils/messages.js'
import {
  buildSubagentEndedTracePayload,
  buildSubagentStartedTracePayload,
  countToolUsesInMessage,
} from '../runAgent.js'

describe('runAgent trace helpers', () => {
  test('guards subagent trace-only counting behind active collection', () => {
    const source = readFileSync(join(import.meta.dir, '../runAgent.ts'), 'utf8')

    expect(source).toContain('let collectSubagentTraceStats = false')
    expect(source).toContain('if (isTraceSessionActive())')
    expect(source).toContain('if (collectSubagentTraceStats) {')
    expect(source).toContain('traceToolUseCount += countToolUsesInMessage')

    const countCallIndex = source.indexOf(
      'traceToolUseCount += countToolUsesInMessage',
    )
    const precedingGuardIndex = source.lastIndexOf(
      'if (collectSubagentTraceStats) {',
      countCallIndex,
    )
    const precedingRecordableIndex = source.lastIndexOf(
      'if (isRecordableMessage(message)) {',
      countCallIndex,
    )

    expect(precedingGuardIndex).toBeGreaterThan(precedingRecordableIndex)
  })

  test('builds a learn-mode start payload with prompt metadata only', () => {
    const distinctivePrompt = 'DISTINCTIVE_LEARN_PROMPT_SHOULD_NOT_BE_PERSISTED'
    const longPrompt = `Investigate this prompt: ${distinctivePrompt} ${'secret details '.repeat(80)}`
    const payload = buildSubagentStartedTracePayload({
      agentType: 'Explore',
      agentName: 'Explore',
      agentId: 'agent-1',
      parentToolUseId: 'toolu_parent',
      mode: 'learn',
      promptMessages: [createUserMessage({ content: longPrompt })],
    })

    expect(payload).toMatchObject({
      agentType: 'Explore',
      agentName: 'Explore',
      agentId: 'agent-1',
      parentToolUseId: 'toolu_parent',
      promptSummary: {
        messageCount: 1,
        textCharCount: longPrompt.length,
      },
    })
    expect(payload).not.toHaveProperty('promptMessages')
    expect(JSON.stringify(payload)).not.toContain(distinctivePrompt)
    expect(payload.promptSummary).not.toHaveProperty('textPreview')
  })

  test('builds a full-mode start payload with prompt messages for redacted trace output', () => {
    const distinctivePrompt = 'DISTINCTIVE_FULL_PROMPT_FOR_REDACTION_PATH'
    const promptMessage = createUserMessage({ content: distinctivePrompt })
    const payload = buildSubagentStartedTracePayload({
      agentType: 'Plan',
      agentName: 'planner.md',
      agentId: 'agent-2',
      mode: 'full',
      promptMessages: [promptMessage],
    })

    expect(payload).toMatchObject({
      agentType: 'Plan',
      agentName: 'planner.md',
      agentId: 'agent-2',
      promptMessages: [promptMessage],
      promptSummary: {
        messageCount: 1,
        textCharCount: distinctivePrompt.length,
      },
    })
    expect(JSON.stringify(payload)).toContain(distinctivePrompt)
  })

  test('counts assistant tool_use blocks for end payloads', () => {
    const assistantMessage = createAssistantMessage({
      content: [
        { type: 'text', text: 'Need a file.', citations: [] },
        {
          type: 'tool_use',
          id: 'toolu_1',
          name: 'Read',
          input: { file_path: 'src/index.ts' },
        },
      ],
    })

    expect(countToolUsesInMessage(assistantMessage)).toBe(1)
    expect(
      buildSubagentEndedTracePayload({
        agentType: 'Explore',
        agentName: 'Explore',
        agentId: 'agent-1',
        parentToolUseId: 'toolu_parent',
        status: 'completed',
        durationMs: 42,
        finalMessageCount: 2,
        availableToolCount: 7,
        toolUseCount: 1,
      }),
    ).toEqual({
      agentType: 'Explore',
      agentName: 'Explore',
      agentId: 'agent-1',
      parentToolUseId: 'toolu_parent',
      status: 'completed',
      durationMs: 42,
      finalMessageCount: 2,
      availableToolCount: 7,
      toolUseCount: 1,
    })
  })
})
