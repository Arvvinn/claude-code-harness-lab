import { describe, expect, test } from 'bun:test'
import { formatTracePanel } from '../panel.js'
import type { TraceEvent } from '../types.js'

type PanelTraceRecord = TraceEvent

function record(
  overrides: Partial<PanelTraceRecord> & {
    type: PanelTraceRecord['type']
    source?: PanelTraceRecord['source']
    payload?: Record<string, unknown>
  },
): PanelTraceRecord {
  return {
    eventId: overrides.eventId ?? `${overrides.type}-event`,
    sessionId: overrides.sessionId ?? 'panel-session',
    turnId: overrides.turnId,
    sequence: overrides.sequence ?? 1,
    timestamp: overrides.timestamp ?? '2026-06-18T00:00:00.000Z',
    mode: overrides.mode ?? 'learn',
    source: overrides.source ?? 'query',
    type: overrides.type,
    payload: overrides.payload ?? {},
  }
}

describe('formatTracePanel', () => {
  test('formats Last timestamp as local human time instead of raw UTC', () => {
    const panel = formatTracePanel(
      [
        record({
          type: 'turn.start',
          source: 'query',
          timestamp: '2026-06-17T16:03:47.556Z',
          payload: {
            messages: [
              {
                type: 'user',
                message: { content: 'hello' },
              },
            ],
          },
        }),
      ],
      { title: 'Agent Loop Replay' },
    )

    expect(panel).toContain('Last:')
    expect(panel).not.toContain('Last: 2026-06-17T16:03:47.556Z')
  })

  test('collapses internal context and large tool inputs by default', () => {
    const panel = formatTracePanel(
      [
        record({
          type: 'turn.start',
          source: 'query',
          payload: {
            messages: [
              {
                type: 'system',
                content: 'FULL CLAUDE.md BODY SHOULD NOT PRINT',
              },
              {
                type: 'attachment',
                attachment: {
                  type: 'skill_listing',
                  content: 'FULL SKILL LISTING SHOULD NOT PRINT',
                },
              },
              { type: 'user', message: { content: 'hello' } },
              {
                type: 'user',
                message: {
                  content: 'read D:\\develop\\ClaudeCode\\README.md',
                },
              },
            ],
            systemPrompt: [
              {
                type: 'text',
                text: 'FULL SYSTEM PROMPT SHOULD NOT PRINT',
              },
            ],
            userContext: {
              cwd: 'D:\\develop\\ClaudeCode',
              fullClaudeMd: 'FULL USER CONTEXT SHOULD NOT PRINT',
            },
            systemContext: { gitStatus: 'FULL GIT STATUS SHOULD NOT PRINT' },
          },
        }),
        record({
          type: 'api.request_built',
          source: 'api',
          payload: {
            provider: 'firstParty',
            model: 'deepseek-v4-pro',
            querySource: 'repl_main_thread',
            messageCount: 2,
            toolCount: 25,
            rawRequestParams: {
              system: 'RAW REQUEST SYSTEM SHOULD NOT PRINT',
            },
          },
        }),
        record({
          type: 'api.request_built',
          source: 'api',
          payload: {
            model: 'DeepSeek-V4-Flash',
            querySource: 'generate_session_title',
            messageCount: 1,
            toolCount: 0,
          },
        }),
        record({
          type: 'tool.started',
          source: 'tool',
          payload: {
            toolName: 'Edit',
            status: 'started',
            toolInput: {
              file_path:
                'C:\\Users\\asuka\\.claude\\projects\\session-memory\\summary.md',
              old_string: 'FULL OLD STRING SHOULD NOT PRINT',
              new_string: 'FULL NEW STRING SHOULD NOT PRINT',
            },
          },
        }),
        record({
          type: 'hook.started',
          source: 'hook',
          payload: {
            hookEvent: 'PreToolUse',
            command: 'FULL HOOK COMMAND SHOULD NOT PRINT',
          },
        }),
        record({
          type: 'query.loop_end',
          source: 'query',
          payload: {
            loopIndex: 1,
            stopReason: 'completed',
            toolUseCount: 1,
            toolResultCount: 1,
          },
        }),
      ],
      { title: 'Agent Loop Live' },
    )

    expect(panel).toContain('Agent Loop Live')
    expect(panel).toContain('[USER]')
    expect(panel).toContain('hello')
    expect(panel).toContain('read D:\\develop\\ClaudeCode\\README.md')
    expect(panel).toContain('[MESSAGES]')
    expect(panel).toContain('user=2')
    expect(panel).toContain('system/internal=1 collapsed')
    expect(panel).toContain('attachments/hooks=1 collapsed')
    expect(panel).toContain('[SYSTEM]')
    expect(panel).toContain('systemPrompt: collapsed 1 block')
    expect(panel).toContain('userContext: collapsed')
    expect(panel).toContain('systemContext: collapsed')
    expect(panel).toContain('[LLM]')
    expect(panel).toContain('main: deepseek-v4-pro')
    expect(panel).toContain('side: generate_session_title collapsed')
    expect(panel).toContain('[TOOL]')
    expect(panel).toContain('Edit')
    expect(panel).toContain('input=collapsed')
    expect(panel).toContain('[INTERNAL]')
    expect(panel).toContain('hooks=1 collapsed')
    expect(panel).toContain('[RAW]')
    expect(panel).toContain('bun run dev trace tail --raw')

    expect(panel).not.toContain('FULL CLAUDE.md BODY SHOULD NOT PRINT')
    expect(panel).not.toContain('FULL SKILL LISTING SHOULD NOT PRINT')
    expect(panel).not.toContain('FULL SYSTEM PROMPT SHOULD NOT PRINT')
    expect(panel).not.toContain('FULL USER CONTEXT SHOULD NOT PRINT')
    expect(panel).not.toContain('FULL GIT STATUS SHOULD NOT PRINT')
    expect(panel).not.toContain('RAW REQUEST SYSTEM SHOULD NOT PRINT')
    expect(panel).not.toContain('FULL OLD STRING SHOULD NOT PRINT')
    expect(panel).not.toContain('FULL NEW STRING SHOULD NOT PRINT')
    expect(panel).not.toContain('FULL HOOK COMMAND SHOULD NOT PRINT')
  })

  test('collapses agent query sources as internal side requests', () => {
    const panel = formatTracePanel(
      [
        record({
          type: 'api.request_built',
          source: 'api',
          payload: {
            model: 'Claude-Research',
            querySource: 'agent:research',
            messageCount: 5,
            toolCount: 7,
          },
        }),
      ],
      { title: 'Agent Loop Live' },
    )

    expect(panel).not.toContain('main: Claude-Research source=agent:research')
    expect(panel).toContain('side: agent:research collapsed')
    expect(panel).toContain('subagents=1 collapsed')
  })

  test('keeps main user context when later side query records include messages', () => {
    const panel = formatTracePanel(
      [
        record({
          type: 'turn.start',
          source: 'query',
          payload: {
            querySource: 'repl_main_thread',
            messages: [
              {
                type: 'user',
                message: { content: 'MAIN REPL BODY SHOULD PRINT' },
              },
            ],
            systemPrompt: [{ type: 'text', text: 'MAIN SYSTEM PROMPT' }],
            userContext: { cwd: 'C:\\work\\ClaudeCode' },
            systemContext: { platform: 'win32' },
          },
        }),
        record({
          type: 'turn.start',
          source: 'query',
          payload: {
            querySource: 'generate_session_title',
            messages: [
              {
                type: 'user',
                message: {
                  content: 'NOISY SIDE TASK BODY SHOULD NOT PRINT',
                },
              },
            ],
            systemPrompt: [
              {
                type: 'text',
                text: 'NOISY SIDE SYSTEM SHOULD NOT PRINT',
              },
            ],
          },
        }),
        record({
          type: 'query.loop_start',
          source: 'query',
          payload: {
            querySource: 'session_memory',
            messages: [
              {
                type: 'user',
                message: {
                  content: 'NOISY SESSION MEMORY BODY SHOULD NOT PRINT',
                },
              },
            ],
            userContext: { fullMemory: 'NOISY SIDE CONTEXT SHOULD NOT PRINT' },
          },
        }),
      ],
      { title: 'Agent Loop Live' },
    )

    expect(panel).toContain('MAIN REPL BODY SHOULD PRINT')
    expect(panel).toContain('user=1')
    expect(panel).toContain('systemPrompt: collapsed 1 block')
    expect(panel).toContain('userContext: collapsed')
    expect(panel).toContain('systemContext: collapsed')
    expect(panel).toContain('titleGeneration=1 collapsed')
    expect(panel).toContain('memory/session=1 collapsed')

    expect(panel).not.toContain('NOISY SIDE TASK BODY SHOULD NOT PRINT')
    expect(panel).not.toContain('NOISY SIDE SYSTEM SHOULD NOT PRINT')
    expect(panel).not.toContain('NOISY SESSION MEMORY BODY SHOULD NOT PRINT')
    expect(panel).not.toContain('NOISY SIDE CONTEXT SHOULD NOT PRINT')
  })

  test('ignores malformed payload records when finding context', () => {
    const records = [
      record({
        type: 'turn.start',
        source: 'query',
        payload: {
          messages: [
            {
              type: 'user',
              message: { content: 'survives malformed payloads' },
            },
          ],
        },
      }),
      record({
        type: 'turn.start',
        source: 'query',
        payload: null as unknown as Record<string, unknown>,
      }),
      record({
        type: 'api.request_built',
        source: 'api',
        payload: 'not an object' as unknown as Record<string, unknown>,
      }),
    ]

    expect(() =>
      formatTracePanel(records, { title: 'Agent Loop Live' }),
    ).not.toThrow()
    expect(formatTracePanel(records, { title: 'Agent Loop Live' })).toContain(
      'survives malformed payloads',
    )
  })

  test('treats output-style repl query sources as main requests', () => {
    const panel = formatTracePanel(
      [
        record({
          type: 'api.request_built',
          source: 'api',
          payload: {
            model: 'deepseek-v4-pro',
            querySource: 'repl_main_thread:outputStyle:Explanatory',
            messageCount: 2,
            toolCount: 25,
          },
        }),
      ],
      { title: 'Agent Loop Live' },
    )

    expect(panel).toContain(
      'main: deepseek-v4-pro source=repl_main_thread:outputStyle:Explanatory',
    )
    expect(panel).not.toContain(
      'side: repl_main_thread:outputStyle:Explanatory collapsed',
    )
  })

  test('caps displayed user messages while counting all messages', () => {
    const messages = Array.from({ length: 50 }, (_, index) => ({
      type: 'user',
      message: {
        content: `user-message-${String(index + 1).padStart(2, '0')}`,
      },
    }))

    const panel = formatTracePanel(
      [
        record({
          type: 'turn.start',
          source: 'query',
          payload: { messages },
        }),
      ],
      { title: 'Agent Loop Live' },
    )

    expect(panel).toContain('user=50')
    expect(panel).toContain('user-message-01')
    expect(panel).toContain('user-message-05')
    expect(panel).toContain('... 45 more user messages collapsed')
    expect(panel).not.toContain('user-message-06')
    expect(panel).not.toContain('user-message-50')
  })
})
