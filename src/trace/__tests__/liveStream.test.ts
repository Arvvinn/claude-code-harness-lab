import { describe, expect, test } from 'bun:test'
import {
  createTraceLiveStream,
  renderTraceLiveHeader,
  type TraceDisplayLanguage,
  type TraceLiveDepth,
} from '../liveStream.js'
import type { TraceEvent } from '../types.js'

interface RenderOptions {
  color?: boolean
  language?: TraceDisplayLanguage
}

function event(overrides: Partial<TraceEvent>): TraceEvent {
  return {
    eventId: overrides.eventId ?? `${overrides.type ?? 'event'}-1`,
    sessionId: overrides.sessionId ?? 'live-session',
    turnId: overrides.turnId,
    sequence: overrides.sequence ?? 1,
    timestamp: overrides.timestamp ?? '2026-06-17T16:03:47.556Z',
    mode: overrides.mode ?? 'learn',
    source: overrides.source ?? 'query',
    type: overrides.type ?? 'turn.start',
    payload: overrides.payload ?? {},
  }
}

function render(
  records: TraceEvent[],
  depth: TraceLiveDepth,
  options: RenderOptions = {},
): string {
  const stream = createTraceLiveStream({ depth, ...options })

  return records.flatMap(record => stream.renderRecord(record)).join('')
}

function coloredStageRecords(): TraceEvent[] {
  return [
    event({
      type: 'turn.start',
      source: 'query',
      payload: {
        querySource: 'repl_main_thread',
        messages: [{ type: 'user', message: { content: 'inspect traces' } }],
      },
    }),
    event({
      type: 'api.request_built',
      source: 'api',
      payload: {
        querySource: 'repl_main_thread',
        model: 'deepseek-v4-pro',
        messageCount: 1,
        toolCount: 1,
      },
    }),
    event({
      type: 'tool.started',
      source: 'tool',
      payload: {
        toolName: 'Read',
        toolInput: { file_path: 'README.md' },
      },
    }),
  ]
}

describe('trace live stream', () => {
  test('renders bilingual stage labels by default', () => {
    const output = render(coloredStageRecords(), 'learn')

    expect(output).toContain('[TURN 轮次 / Turn]')
    expect(output).toContain('[USER 用户输入 / User Input]')
    expect(output).toContain('[PREP 构造上下文 / Context Prep]')
    expect(output).toContain('[LLM 模型请求 / Model Request]')
    expect(output).toContain('[TOOL 工具 / Tool] Read started')
  })

  test('renders English-only labels when language is en', () => {
    const output = render(coloredStageRecords(), 'learn', { language: 'en' })

    expect(output).toContain('[TURN / Turn]')
    expect(output).toContain('[USER / User Input]')
    expect(output).toContain('[TOOL / Tool] Read started')
    expect(output).not.toContain('用户输入')
    expect(output).not.toContain('工具]')
  })

  test('renders Chinese-only labels when language is zh', () => {
    const output = render(coloredStageRecords(), 'learn', { language: 'zh' })

    expect(output).toContain('[TURN 轮次]')
    expect(output).toContain('[USER 用户输入]')
    expect(output).not.toContain('User Input')
  })

  test('starts each visible turn as a separated block', () => {
    const output = render(
      [
        event({
          type: 'turn.start',
          payload: {
            messages: [{ type: 'user', message: { content: 'first' } }],
          },
        }),
        event({
          type: 'turn.end',
          payload: { resultReason: 'completed' },
        }),
        event({
          type: 'turn.start',
          payload: {
            messages: [{ type: 'user', message: { content: 'second' } }],
          },
        }),
      ],
      'learn',
    )

    expect(output).toContain('\n\n  [TURN 轮次 / Turn] 2 - second')
  })

  test('preserves English tool identifiers in localized labels', () => {
    const output = render(coloredStageRecords(), 'learn', { language: 'zh' })

    expect(output).toContain('[TOOL 工具] Read started')
    expect(output).not.toContain('读取 started')
  })

  test('renders colored stage labels and dim event metadata', () => {
    const stream = createTraceLiveStream({ depth: 'learn', color: true })
    const output = coloredStageRecords()
      .flatMap(record => stream.renderRecord(record))
      .join('')

    expect(output).toContain('\x1b[36m[USER 用户输入 / User Input]\x1b[0m')
    expect(output).toContain('\x1b[33m[LLM 模型请求 / Model Request]\x1b[0m')
    expect(output).toContain('\x1b[32m[TOOL 工具 / Tool]\x1b[0m')
    expect(output).toContain('    \x1b[90mevent=turn.start\x1b[0m')
    expect(output).toContain('    \x1b[90mevent=api.request_built\x1b[0m')
  })

  test('renders uncolored stage labels without event metadata when color is disabled', () => {
    const output = render(coloredStageRecords(), 'learn', { color: false })

    expect(output).toContain('[USER 用户输入 / User Input]')
    expect(output).not.toContain('event=')
    expect(output).not.toContain('\x1b[')
  })

  test('renders one colored event metadata line for a turn start record', () => {
    const output = render(
      [
        event({
          type: 'turn.start',
          source: 'query',
          payload: {
            querySource: 'repl_main_thread',
            messages: [
              { type: 'user', message: { content: 'inspect traces' } },
            ],
          },
        }),
      ],
      'learn',
      { color: true },
    )

    expect(output).toContain('\x1b[1;36m[TURN 轮次 / Turn]\x1b[0m')
    expect(output).toContain('\x1b[36m[USER 用户输入 / User Input]\x1b[0m')
    expect(output.match(/event=turn\.start/g)).toHaveLength(1)
    expect(output).toContain('    \x1b[90mevent=turn.start\x1b[0m')
    expect(output).not.toContain('\x1b[90m    event=turn.start\x1b[0m')
  })

  test('renders Learn as concise agent-loop narration', () => {
    const output = render(
      [
        event({
          type: 'turn.start',
          source: 'query',
          payload: {
            querySource: 'repl_main_thread',
            messages: [
              { type: 'system', content: 'SYSTEM BODY SHOULD NOT PRINT' },
              {
                type: 'attachment',
                attachment: {
                  type: 'hook_success',
                  command: 'HOOK COMMAND SHOULD NOT PRINT',
                },
              },
              { type: 'user', message: { content: 'read README.md' } },
            ],
            systemPrompt: [
              { type: 'text', text: 'PROMPT BODY SHOULD NOT PRINT' },
            ],
            userContext: { claudeMd: 'CLAUDE MD SHOULD NOT PRINT' },
            systemContext: { gitStatus: 'GIT STATUS SHOULD NOT PRINT' },
          },
        }),
        event({
          type: 'api.request_built',
          source: 'api',
          payload: {
            querySource: 'repl_main_thread',
            provider: 'firstParty',
            model: 'deepseek-v4-pro',
            messageCount: 12,
            toolCount: 25,
            maxTokens: 32000,
            effort: 'medium',
            rawRequestParams: {
              system: 'RAW REQUEST SHOULD NOT PRINT',
            },
          },
        }),
        event({
          type: 'api.stream_event',
          source: 'api',
          payload: { eventType: 'message_start' },
        }),
        event({
          type: 'api.stream_event',
          source: 'api',
          payload: {
            eventType: 'content_block_start',
            contentBlockType: 'tool_use',
            toolName: 'Read',
            contentBlockId: 'toolu_1',
          },
        }),
        event({
          type: 'tool.detected',
          source: 'tool',
          payload: {
            toolName: 'Read',
            toolUseId: 'toolu_1',
            toolInput: { file_path: 'D:\\develop\\ClaudeCode\\README.md' },
          },
        }),
        event({
          type: 'tool.started',
          source: 'tool',
          payload: {
            toolName: 'Read',
            toolUseId: 'toolu_1',
            status: 'started',
            toolInput: { file_path: 'D:\\develop\\ClaudeCode\\README.md' },
          },
        }),
        event({
          type: 'tool.result',
          source: 'tool',
          payload: {
            toolName: 'Read',
            toolUseId: 'toolu_1',
            status: 'ok',
            ok: true,
            durationMs: 2,
            toolResultSizeBytes: 5031,
          },
        }),
        event({
          type: 'transcript.appended',
          source: 'transcript',
          payload: { entryType: 'tool_result', byteCount: 628 },
        }),
        event({
          type: 'query.loop_end',
          source: 'query',
          payload: {
            loopIndex: 1,
            stopReason: 'next_turn',
            toolUseCount: 1,
            toolResultCount: 1,
            durationMs: 141715,
          },
        }),
        event({
          type: 'turn.end',
          source: 'query',
          payload: {
            resultReason: 'completed',
            durationMs: 309900,
            finalMessageCount: 31,
          },
        }),
      ],
      'learn',
    )

    expect(output).toContain('[TURN 轮次 / Turn] 1 - read README.md')
    expect(output).toContain('[USER 用户输入 / User Input] read README.md')
    expect(output).toContain(
      '[PREP 构造上下文 / Context Prep] messages[] prepared user=1 assistant=0 internal=1 attachments=1 tools=25',
    )
    expect(output).toContain(
      '[LLM 模型请求 / Model Request] request sent deepseek-v4-pro',
    )
    expect(output).toContain('[STREAM 模型流 / Model Stream] stream started')
    expect(output).toContain(
      '[STREAM 模型流 / Model Stream] tool_use requested Read',
    )
    expect(output).toContain(
      '[TOOL 工具 / Tool] Read started path=D:\\develop\\ClaudeCode\\README.md',
    )
    expect(output).toContain(
      '[TOOL 工具 / Tool] Read ok duration=2ms size=5031B',
    )
    expect(output).toContain(
      '[DECISION 决策 / Decision] tool_result appended, loop back to LLM',
    )
    expect(output).toContain('[DONE 完成 / Done] completed duration=309.9s')

    expect(output).not.toContain('SYSTEM BODY SHOULD NOT PRINT')
    expect(output).not.toContain('HOOK COMMAND SHOULD NOT PRINT')
    expect(output).not.toContain('PROMPT BODY SHOULD NOT PRINT')
    expect(output).not.toContain('CLAUDE MD SHOULD NOT PRINT')
    expect(output).not.toContain('GIT STATUS SHOULD NOT PRINT')
    expect(output).not.toContain('RAW REQUEST SHOULD NOT PRINT')
    expect(output.match(/tool_use requested Read/g)).toHaveLength(1)
    expect(
      output.match(/tool_result appended, loop back to LLM/g),
    ).toHaveLength(1)
  })

  test('renders Deep with harness and protocol structure', () => {
    const output = render(
      [
        event({
          type: 'turn.start',
          source: 'query',
          payload: {
            querySource: 'repl_main_thread',
            messages: [
              { type: 'user', message: { content: 'read README.md' } },
            ],
            systemPrompt: [
              { type: 'text', text: 'PROMPT BODY SHOULD NOT PRINT' },
            ],
            userContext: { claudeMd: 'CLAUDE MD SHOULD NOT PRINT' },
            systemContext: { gitStatus: 'GIT STATUS SHOULD NOT PRINT' },
          },
        }),
        event({
          type: 'api.request_built',
          source: 'api',
          payload: {
            querySource: 'repl_main_thread',
            provider: 'firstParty',
            model: 'deepseek-v4-pro',
            messageCount: 12,
            toolCount: 25,
            maxTokens: 32000,
            effort: 'medium',
          },
        }),
        event({
          type: 'hook.result',
          source: 'hook',
          payload: {
            hookEvent: 'PreToolUse',
            toolName: 'Read',
            status: 'completed',
            durationMs: 60415,
            command: 'HOOK COMMAND SHOULD NOT PRINT',
          },
        }),
        event({
          type: 'tool.permission_result',
          source: 'tool',
          payload: {
            toolName: 'Read',
            decision: 'allow',
            source: 'mode',
            durationMs: 0,
          },
        }),
        event({
          type: 'query.loop_end',
          source: 'query',
          payload: {
            loopIndex: 1,
            stopReason: 'next_turn',
            toolUseCount: 1,
            toolResultCount: 1,
            durationMs: 141715,
          },
        }),
      ],
      'deep',
    )

    expect(output).toContain(
      'HARNESS context systemPrompt=1 block userContext=collapsed systemContext=collapsed',
    )
    expect(output).toContain(
      'REQUEST #1 provider=firstParty model=deepseek-v4-pro querySource=repl_main_thread messages=12 tools=25 maxTokens=32000 effort=medium',
    )
    expect(output).toContain(
      '[HOOK 钩子 / Hook] PreToolUse done duration=60415ms',
    )
    expect(output).toContain(
      '[TOOL 工具 / Tool] Read permission allow source=mode duration=0ms',
    )
    expect(output).toContain(
      '[DECISION 决策 / Decision] LOOP #1 next_turn toolUse=1 toolResult=1 duration=141715ms',
    )
    expect(output).not.toContain('PROMPT BODY SHOULD NOT PRINT')
    expect(output).not.toContain('CLAUDE MD SHOULD NOT PRINT')
    expect(output).not.toContain('GIT STATUS SHOULD NOT PRINT')
    expect(output).not.toContain('HOOK COMMAND SHOULD NOT PRINT')
  })

  test('does not duplicate Deep harness context when turn start already has it', () => {
    const output = render(
      [
        event({
          type: 'turn.start',
          source: 'query',
          payload: {
            querySource: 'repl_main_thread',
            messages: [
              { type: 'user', message: { content: 'inspect harness once' } },
            ],
            systemPrompt: [
              { type: 'text', text: 'PROMPT BODY SHOULD NOT PRINT' },
            ],
            userContext: { claudeMd: 'CLAUDE MD SHOULD NOT PRINT' },
            systemContext: { gitStatus: 'GIT STATUS SHOULD NOT PRINT' },
          },
        }),
        event({
          type: 'query.loop_start',
          source: 'query',
          payload: {
            querySource: 'repl_main_thread',
            loopIndex: 1,
            messages: [
              { type: 'user', message: { content: 'inspect harness once' } },
            ],
            systemPrompt: [
              { type: 'text', text: 'PROMPT BODY SHOULD NOT PRINT' },
            ],
            userContext: { claudeMd: 'CLAUDE MD SHOULD NOT PRINT' },
            systemContext: { gitStatus: 'GIT STATUS SHOULD NOT PRINT' },
            tools: [{ name: 'Read' }],
          },
        }),
      ],
      'deep',
    )

    expect(output.match(/HARNESS context/g)).toHaveLength(1)
    expect(output).toContain(
      'LOOP #1 messages=1 tools=1 querySource=repl_main_thread',
    )
    expect(output).not.toContain('PROMPT BODY SHOULD NOT PRINT')
    expect(output).not.toContain('CLAUDE MD SHOULD NOT PRINT')
    expect(output).not.toContain('GIT STATUS SHOULD NOT PRINT')
  })

  test('fills sparse turn start details from query loop start without leaking raw bodies', () => {
    const records = [
      event({
        type: 'turn.start',
        source: 'query',
        payload: {
          querySource: 'repl_main_thread',
          inputChars: 0,
        },
      }),
      event({
        type: 'query.loop_start',
        source: 'query',
        payload: {
          querySource: 'repl_main_thread',
          loopIndex: 1,
          messages: [
            { type: 'system', content: 'SYSTEM BODY SHOULD NOT PRINT' },
            {
              type: 'user',
              message: {
                content: [
                  {
                    type: 'text',
                    text: 'explain trace harness loop rendering',
                  },
                ],
              },
            },
          ],
          systemPrompt: [
            { type: 'text', text: 'PROMPT BODY SHOULD NOT PRINT' },
          ],
          userContext: { claudeMd: 'CLAUDE MD SHOULD NOT PRINT' },
          systemContext: { gitStatus: 'GIT STATUS SHOULD NOT PRINT' },
          tools: [{ name: 'Read' }, { name: 'Grep' }],
        },
      }),
    ]

    const learn = render(records, 'learn')
    const deep = render(records, 'deep')

    expect(learn).toContain('[TURN')
    expect(learn).toContain('1 - input collapsed')
    expect(learn).toContain('explain trace harness loop rendering')
    expect(learn).toContain(
      'messages[] prepared user=1 assistant=0 internal=1 attachments=0 tools=2',
    )
    expect(learn).not.toContain('messages[] prepared user=0')

    expect(deep).toContain(
      'LOOP #1 messages=2 tools=2 querySource=repl_main_thread',
    )
    expect(deep).toContain(
      'HARNESS context systemPrompt=1 block userContext=collapsed systemContext=collapsed',
    )
    expect(deep.match(/HARNESS context/g)).toHaveLength(1)
    expect(deep).not.toContain('SYSTEM BODY SHOULD NOT PRINT')
    expect(deep).not.toContain('PROMPT BODY SHOULD NOT PRINT')
    expect(deep).not.toContain('CLAUDE MD SHOULD NOT PRINT')
    expect(deep).not.toContain('GIT STATUS SHOULD NOT PRINT')
  })

  test('does not duplicate user narration when turn start already has messages', () => {
    const output = render(
      [
        event({
          type: 'turn.start',
          source: 'query',
          payload: {
            querySource: 'repl_main_thread',
            messages: [
              { type: 'user', message: { content: 'already visible user' } },
            ],
          },
        }),
        event({
          type: 'query.loop_start',
          source: 'query',
          payload: {
            querySource: 'repl_main_thread',
            loopIndex: 1,
            messages: [
              { type: 'user', message: { content: 'already visible user' } },
            ],
            tools: [{ name: 'Read' }],
          },
        }),
      ],
      'learn',
    )

    expect(output.match(/\[USER .*already visible user/g)).toHaveLength(1)
  })

  test('summarizes known side requests without raw bodies', () => {
    const cases = [
      {
        source: 'generate_session_title',
        model: 'DeepSeek-V4-Flash',
        messages: 1,
        tools: 0,
        body: 'SIDE TITLE BODY SHOULD NOT PRINT',
      },
      {
        source: 'extract_memories',
        model: 'deepseek-v4-pro',
        messages: 3,
        tools: 0,
        body: 'SIDE EXTRACT BODY SHOULD NOT PRINT',
      },
      {
        source: 'session_memory',
        model: 'deepseek-v4-pro',
        messages: 2,
        tools: 25,
        body: 'SIDE MEMORY BODY SHOULD NOT PRINT',
      },
    ]

    for (const sideCase of cases) {
      const sideEvent = event({
        type: 'api.request_built',
        source: 'api',
        payload: {
          querySource: sideCase.source,
          model: sideCase.model,
          messageCount: sideCase.messages,
          toolCount: sideCase.tools,
          rawRequestParams: {
            messages: sideCase.body,
          },
        },
      })

      expect(render([sideEvent], 'learn')).toContain(
        `[SIDE 旁路任务 / Side Task] ${sideCase.source} collapsed`,
      )
      expect(render([sideEvent], 'learn')).not.toContain(sideCase.body)
      expect(render([sideEvent], 'deep')).toContain(
        `[SIDE 旁路任务 / Side Task] ${sideCase.source} model=${sideCase.model} messages=${sideCase.messages} tools=${sideCase.tools}`,
      )
      expect(render([sideEvent], 'deep')).not.toContain(sideCase.body)
    }
  })

  test('collapses side turn starts in Learn without printing prompt bodies', () => {
    const output = render(
      [
        event({
          type: 'turn.start',
          source: 'query',
          payload: {
            querySource: 'session_memory',
            messages: [
              {
                type: 'user',
                message: { content: 'SIDE MEMORY BODY SHOULD NOT PRINT' },
              },
            ],
            prompt: 'SIDE PROMPT BODY SHOULD NOT PRINT',
          },
        }),
      ],
      'learn',
    )

    expect(output).toContain(
      '[SIDE 旁路任务 / Side Task] session_memory collapsed',
    )
    expect(output).not.toContain('event=')
    expect(output).not.toContain('TURN')
    expect(output).not.toContain('USER')
    expect(output).not.toContain('SIDE MEMORY BODY SHOULD NOT PRINT')
    expect(output).not.toContain('SIDE PROMPT BODY SHOULD NOT PRINT')
  })

  test('renders side turn starts in Deep as shape only without message bodies', () => {
    const output = render(
      [
        event({
          type: 'turn.start',
          source: 'query',
          payload: {
            querySource: 'session_memory',
            messages: [
              {
                type: 'user',
                message: { content: 'SIDE MEMORY BODY SHOULD NOT PRINT' },
              },
              { type: 'assistant', message: { content: 'side summary' } },
            ],
            tools: [{ name: 'Read' }, { name: 'Grep' }],
            prompt: 'SIDE PROMPT BODY SHOULD NOT PRINT',
          },
        }),
      ],
      'deep',
    )

    expect(output).toContain(
      '[SIDE 旁路任务 / Side Task] session_memory messages=2 tools=2',
    )
    expect(output).not.toContain('event=')
    expect(output).not.toContain('TURN')
    expect(output).not.toContain('USER')
    expect(output).not.toContain('SIDE MEMORY BODY SHOULD NOT PRINT')
    expect(output).not.toContain('SIDE PROMPT BODY SHOULD NOT PRINT')
  })

  test('renders store summaries for transcript persistence without bodies', () => {
    const records = [
      event({
        type: 'transcript.appended',
        source: 'transcript',
        payload: {
          entryType: 'user',
          byteCount: 512,
          entry: {
            message: 'NOISY FULL TRANSCRIPT BODY SHOULD NOT PRINT',
          },
        },
      }),
      event({
        type: 'transcript.appended',
        source: 'transcript',
        payload: {
          entryType: 'assistant',
          byteCount: 915,
          line: 'NOISY FULL TRANSCRIPT BODY SHOULD NOT PRINT',
        },
      }),
      event({
        type: 'transcript.appended',
        source: 'transcript',
        payload: {
          entryType: 'tool_result',
          byteCount: 628,
          content: 'NOISY FULL TRANSCRIPT BODY SHOULD NOT PRINT',
        },
      }),
      event({
        type: 'transcript.appended',
        source: 'transcript',
        payload: {
          entryType: 'system',
          byteCount: 117,
          text: 'NOISY FULL TRANSCRIPT BODY SHOULD NOT PRINT',
        },
      }),
    ]

    for (const depth of ['learn', 'deep'] as const) {
      const output = render(records, depth)

      expect(output).toContain(
        '[STORE 记录写入 / Storage] transcript appended entry=user bytes=512',
      )
      expect(output).toContain(
        '[STORE 记录写入 / Storage] transcript appended entry=assistant bytes=915',
      )
      expect(output).toContain(
        '[STORE 记录写入 / Storage] transcript appended entry=tool_result bytes=628',
      )
      expect(output).toContain(
        '[STORE 记录写入 / Storage] transcript appended entry=system bytes=117',
      )
      expect(output).not.toContain(
        'NOISY FULL TRANSCRIPT BODY SHOULD NOT PRINT',
      )
    }
  })

  test('coalesces repeated Learn transcript appends for the same entry type within a turn', () => {
    const output = render(
      [
        event({
          type: 'turn.start',
          source: 'query',
          payload: {
            querySource: 'repl_main_thread',
            messages: [
              { type: 'user', message: { content: 'start noisy turn' } },
            ],
          },
        }),
        event({
          type: 'transcript.appended',
          source: 'transcript',
          payload: {
            entryType: 'user',
            byteCount: 111,
            body: 'FIRST USER BODY SHOULD NOT PRINT',
          },
        }),
        event({
          type: 'transcript.appended',
          source: 'transcript',
          payload: {
            entryType: 'user',
            byteCount: 222,
            body: 'SECOND USER BODY SHOULD NOT PRINT',
          },
        }),
      ],
      'learn',
    )

    expect(output.match(/transcript appended entry=user/g)).toHaveLength(1)
    expect(output).toContain('transcript appended entry=user bytes=111')
    expect(output).not.toContain('bytes=222')
    expect(output).not.toContain('FIRST USER BODY SHOULD NOT PRINT')
    expect(output).not.toContain('SECOND USER BODY SHOULD NOT PRINT')
  })

  test('isolates Learn transcript append coalescing across nested side turns', () => {
    const output = render(
      [
        event({
          type: 'turn.start',
          source: 'query',
          payload: {
            querySource: 'repl_main_thread',
            messages: [{ type: 'user', message: { content: 'parent turn' } }],
          },
        }),
        event({
          type: 'transcript.appended',
          source: 'transcript',
          payload: {
            entryType: 'user',
            byteCount: 111,
            body: 'PARENT USER BODY SHOULD NOT PRINT',
          },
        }),
        event({
          type: 'turn.start',
          source: 'query',
          payload: {
            querySource: 'agent:reviewer',
            messages: [
              {
                type: 'user',
                message: { content: 'SIDE USER BODY SHOULD NOT PRINT' },
              },
            ],
          },
        }),
        event({
          type: 'transcript.appended',
          source: 'transcript',
          payload: {
            entryType: 'user',
            byteCount: 222,
            body: 'SIDE TRANSCRIPT BODY SHOULD NOT PRINT',
          },
        }),
        event({
          type: 'turn.end',
          source: 'query',
          payload: {
            querySource: 'agent:reviewer',
            resultReason: 'completed',
          },
        }),
        event({
          type: 'transcript.appended',
          source: 'transcript',
          payload: {
            entryType: 'user',
            byteCount: 333,
            body: 'PARENT POST SIDE USER BODY SHOULD NOT PRINT',
          },
        }),
        event({
          type: 'turn.end',
          source: 'query',
          payload: {
            querySource: 'repl_main_thread',
            resultReason: 'completed',
          },
        }),
      ],
      'learn',
    )

    expect(output.match(/transcript appended entry=user/g)).toHaveLength(2)
    expect(output).toContain('transcript appended entry=user bytes=111')
    expect(output).toContain('transcript appended entry=user bytes=222')
    expect(output).not.toContain('bytes=333')
    expect(output).toContain('agent:reviewer collapsed')
    expect(output).not.toContain('PARENT USER BODY SHOULD NOT PRINT')
    expect(output).not.toContain('SIDE USER BODY SHOULD NOT PRINT')
    expect(output).not.toContain('SIDE TRANSCRIPT BODY SHOULD NOT PRINT')
    expect(output).not.toContain('PARENT POST SIDE USER BODY SHOULD NOT PRINT')
  })

  test('does not coalesce next user transcript append before the next turn start', () => {
    const output = render(
      [
        event({
          type: 'turn.start',
          source: 'query',
          payload: {
            querySource: 'repl_main_thread',
            messages: [{ type: 'user', message: { content: 'first turn' } }],
          },
        }),
        event({
          type: 'transcript.appended',
          source: 'transcript',
          payload: { entryType: 'user', byteCount: 111 },
        }),
        event({
          type: 'turn.end',
          source: 'query',
          payload: {
            resultReason: 'completed',
            durationMs: 10,
            finalMessageCount: 2,
          },
        }),
        event({
          type: 'transcript.appended',
          source: 'transcript',
          payload: { entryType: 'user', byteCount: 222 },
        }),
        event({
          type: 'turn.start',
          source: 'query',
          payload: {
            querySource: 'repl_main_thread',
            messages: [{ type: 'user', message: { content: 'second turn' } }],
          },
        }),
      ],
      'learn',
    )

    expect(output.match(/transcript appended entry=user/g)).toHaveLength(2)
    expect(output).toContain('transcript appended entry=user bytes=111')
    expect(output).toContain('transcript appended entry=user bytes=222')
  })

  test('resets Learn transcript append coalescing on the next main turn', () => {
    const output = render(
      [
        event({
          type: 'turn.start',
          source: 'query',
          payload: {
            querySource: 'repl_main_thread',
            messages: [{ type: 'user', message: { content: 'first turn' } }],
          },
        }),
        event({
          type: 'transcript.appended',
          source: 'transcript',
          payload: { entryType: 'assistant', byteCount: 333 },
        }),
        event({
          type: 'turn.start',
          source: 'query',
          payload: {
            querySource: 'repl_main_thread',
            messages: [{ type: 'user', message: { content: 'second turn' } }],
          },
        }),
        event({
          type: 'transcript.appended',
          source: 'transcript',
          payload: { entryType: 'assistant', byteCount: 444 },
        }),
      ],
      'learn',
    )

    expect(output.match(/transcript appended entry=assistant/g)).toHaveLength(2)
    expect(output).toContain('transcript appended entry=assistant bytes=333')
    expect(output).toContain('transcript appended entry=assistant bytes=444')
  })

  test('renders repeated meaningful transcript appends in Deep', () => {
    const output = render(
      [
        event({
          type: 'transcript.appended',
          source: 'transcript',
          payload: {
            entryType: 'system',
            byteCount: 555,
            body: 'FIRST SYSTEM BODY SHOULD NOT PRINT',
          },
        }),
        event({
          type: 'transcript.appended',
          source: 'transcript',
          payload: {
            entryType: 'system',
            byteCount: 666,
            body: 'SECOND SYSTEM BODY SHOULD NOT PRINT',
          },
        }),
      ],
      'deep',
    )

    expect(output.match(/transcript appended entry=system/g)).toHaveLength(2)
    expect(output).toContain('transcript appended entry=system bytes=555')
    expect(output).toContain('transcript appended entry=system bytes=666')
    expect(output).not.toContain('FIRST SYSTEM BODY SHOULD NOT PRINT')
    expect(output).not.toContain('SECOND SYSTEM BODY SHOULD NOT PRINT')
  })

  test('summarizes attachment transcript appends without leaking body or path', () => {
    const output = render(
      [
        event({
          type: 'transcript.appended',
          source: 'transcript',
          payload: {
            entryType: 'attachment',
            byteCount: 777,
            path: 'C:\\Users\\asuka\\secret\\notes.md',
            body: 'ATTACHMENT BODY SHOULD NOT PRINT',
          },
        }),
      ],
      'learn',
    )

    expect(output).toContain('transcript appended entry=attachment bytes=777')
    expect(output).not.toContain('ATTACHMENT BODY SHOULD NOT PRINT')
    expect(output).not.toContain('C:\\Users\\asuka\\secret\\notes.md')
  })

  test('drops metadata-like transcript appends without leaking body or path', () => {
    const records = [
      event({
        type: 'transcript.appended',
        source: 'transcript',
        payload: {
          entryType: 'title',
          byteCount: 888,
          path: 'C:\\Users\\asuka\\secret\\title.jsonl',
          body: 'TITLE BODY SHOULD NOT PRINT',
        },
      }),
      event({
        type: 'transcript.appended',
        source: 'transcript',
        payload: {
          entryType: 'tag',
          byteCount: 999,
          path: 'C:\\Users\\asuka\\secret\\tag.jsonl',
          body: 'TAG BODY SHOULD NOT PRINT',
        },
      }),
    ]

    for (const depth of ['learn', 'deep'] as const) {
      const output = render(records, depth)

      expect(output).not.toContain('transcript appended entry=title')
      expect(output).not.toContain('transcript appended entry=tag')
      expect(output).not.toContain('TITLE BODY SHOULD NOT PRINT')
      expect(output).not.toContain('TAG BODY SHOULD NOT PRINT')
      expect(output).not.toContain('C:\\Users\\asuka\\secret')
    }
  })

  test('summarizes unknown side query sources without leaking raw body or path', () => {
    const records = [
      event({
        type: 'api.request_built',
        source: 'api',
        payload: {
          querySource:
            'custom side BODY SHOULD NOT PRINT C:\\Users\\asuka\\secret\\payload.jsonl',
          model: 'deepseek-v4-pro',
          messageCount: 1,
          toolCount: 0,
          rawRequestParams: {
            messages: 'UNKNOWN SIDE BODY SHOULD NOT PRINT',
          },
        },
      }),
    ]

    for (const depth of ['learn', 'deep'] as const) {
      const output = render(records, depth)

      expect(output).toContain('unknown_side')
      expect(output).not.toContain('custom side BODY SHOULD NOT PRINT')
      expect(output).not.toContain('UNKNOWN SIDE BODY SHOULD NOT PRINT')
      expect(output).not.toContain('C:\\Users\\asuka\\secret')
    }
  })

  test('renders store summaries for trace session boundaries', () => {
    const records = [
      event({
        type: 'trace.session_start',
        source: 'query',
        payload: {
          eventsPath: 'C:\\Users\\asuka\\.claude\\projects\\full\\path.jsonl',
        },
      }),
      event({
        type: 'trace.session_end',
        source: 'query',
        payload: {
          eventsPath: 'C:\\Users\\asuka\\.claude\\projects\\full\\path.jsonl',
          transcript: 'NOISY FULL TRANSCRIPT BODY SHOULD NOT PRINT',
        },
      }),
    ]

    for (const depth of ['learn', 'deep'] as const) {
      const output = render(records, depth)

      expect(output).toContain('[STORE 记录写入 / Storage] trace session_start')
      expect(output).toContain('[STORE 记录写入 / Storage] trace session_end')
      expect(output).not.toContain(
        'C:\\Users\\asuka\\.claude\\projects\\full\\path.jsonl',
      )
      expect(output).not.toContain(
        'NOISY FULL TRANSCRIPT BODY SHOULD NOT PRINT',
      )
    }
  })

  test('renders failed turn end stop reasons instead of defaulting to completed', () => {
    const output = render(
      [
        event({
          type: 'turn.end',
          source: 'query',
          payload: {
            success: false,
            error: true,
            stopReason: 'model_error',
            durationMs: 42,
          },
        }),
      ],
      'learn',
    )

    expect(output).toContain('[DONE 完成 / Done] model_error')
    expect(output).not.toContain('DONE completed')
  })

  test('ignores Learn stream deltas and compacts Deep stream deltas', () => {
    const records = [
      event({
        type: 'api.request_built',
        source: 'api',
        payload: {
          querySource: 'repl_main_thread',
          model: 'deepseek-v4-pro',
          messageCount: 2,
          toolCount: 25,
        },
      }),
      event({
        type: 'api.stream_event',
        source: 'api',
        payload: {
          eventType: 'content_block_delta',
          deltaType: 'text_delta',
          text: 'RAW DELTA SHOULD NOT PRINT',
        },
      }),
    ]

    expect(render(records, 'learn')).not.toContain('content_block_delta')
    expect(render(records, 'learn')).not.toContain('RAW DELTA SHOULD NOT PRINT')
    expect(render(records, 'deep')).toContain(
      '[STREAM 模型流 / Model Stream] #1 content_block_delta text_delta',
    )
    expect(render(records, 'deep')).not.toContain('RAW DELTA SHOULD NOT PRINT')
  })

  test('renders hook and tool durations without raw bodies', () => {
    const output = render(
      [
        event({
          type: 'hook.result',
          source: 'hook',
          payload: {
            hookEvent: 'PostToolUse',
            status: 'completed',
            durationMs: 120419,
            command: 'HOOK COMMAND SHOULD NOT PRINT',
          },
        }),
        event({
          type: 'tool.started',
          source: 'tool',
          payload: {
            toolName: 'Write',
            toolInput: {
              file_path: 'D:\\develop\\ClaudeCode\\notes.txt',
              content: 'TOOL BODY SHOULD NOT PRINT',
            },
          },
        }),
        event({
          type: 'tool.result',
          source: 'tool',
          payload: {
            toolName: 'Write',
            status: 'ok',
            durationMs: 12,
            toolResultSizeBytes: 42,
            content: 'TOOL RESULT BODY SHOULD NOT PRINT',
          },
        }),
      ],
      'learn',
    )

    expect(output).toContain(
      '[HOOK 钩子 / Hook] PostToolUse done duration=120419ms',
    )
    expect(output).toContain(
      '[TOOL 工具 / Tool] Write started path=D:\\develop\\ClaudeCode\\notes.txt',
    )
    expect(output).toContain(
      '[TOOL 工具 / Tool] Write ok duration=12ms size=42B',
    )
    expect(output).not.toContain('HOOK COMMAND SHOULD NOT PRINT')
    expect(output).not.toContain('TOOL BODY SHOULD NOT PRINT')
    expect(output).not.toContain('TOOL RESULT BODY SHOULD NOT PRINT')
  })

  test('renders api retry metadata without treating it as a generic error', () => {
    const output = render(
      [
        event({
          type: 'api.retry',
          source: 'api',
          payload: {
            retryType: 'scheduled',
            attempt: 2,
            maxRetries: 5,
            model: 'claude-test',
            provider: 'firstParty',
            status: 529,
            errorName: 'APIError',
            retryInMs: 250,
            requestId: 'req_current_retry',
            rawRequestParams: {
              messages: 'RETRY BODY SHOULD NOT PRINT',
            },
          },
        }),
      ],
      'learn',
    )

    expect(output).toContain(
      'RETRY scheduled attempt=2 maxRetries=5 model=claude-test provider=firstParty status=529 error=APIError retryInMs=250 requestId=req_current_retry',
    )
    expect(output).not.toContain('ERROR api.retry collapsed')
    expect(output).not.toContain('RETRY BODY SHOULD NOT PRINT')
  })

  test('renders header with local start time', () => {
    const header = renderTraceLiveHeader({
      depth: 'learn',
      sessionId: 'live-session',
      eventsPath: 'C:\\trace\\events.jsonl',
      startedAt: '2026-06-17T16:03:47.556Z',
      timeZone: 'Asia/Shanghai',
    })

    expect(header).toContain('Trace Live - Learn')
    expect(header).toContain('Started: 2026-06-18 00:03:47 local')
    expect(header).toContain('Session: live-session')
    expect(header).toContain('Source: C:\\trace\\events.jsonl')
  })

  test('renders bilingual header legend by default', () => {
    const header = renderTraceLiveHeader({
      depth: 'learn',
      sessionId: 'live-session',
      eventsPath: 'C:\\trace\\events.jsonl',
      startedAt: '2026-06-17T16:03:47.556Z',
      timeZone: 'Asia/Shanghai',
    })

    expect(header).toContain('Language: zh+en')
    expect(header).toContain(
      'Pattern: User -> messages[] -> LLM -> decision -> tools -> results -> loop/return',
    )
  })

  test('renders English header language marker', () => {
    const header = renderTraceLiveHeader({
      depth: 'deep',
      sessionId: 'live-session',
      eventsPath: 'C:\\trace\\events.jsonl',
      language: 'en',
    })

    expect(header).toContain('Language: en')
    expect(header).toContain('Trace Live - Deep')
  })

  test('renders Chinese header language marker', () => {
    const header = renderTraceLiveHeader({
      depth: 'learn',
      sessionId: 'live-session',
      eventsPath: 'C:\\trace\\events.jsonl',
      language: 'zh',
    })

    expect(header).toContain('Language: zh')
  })
})
