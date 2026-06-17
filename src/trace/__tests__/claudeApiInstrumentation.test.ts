import { readFileSync } from 'node:fs'
import { describe, expect, mock, test } from 'bun:test'
import type {
  BetaMessage,
  BetaMessageStreamParams,
  BetaRawMessageStreamEvent,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import { APIError } from '@anthropic-ai/sdk/error'
import type { SystemAPIErrorMessage } from '../../types/message'
import { redactTracePayload } from '../redaction.js'
import { debugMock } from '../../../tests/mocks/debug.js'
import { logMock } from '../../../tests/mocks/log.js'

mock.module('src/utils/debug.ts', debugMock)
mock.module('src/utils/log.ts', logMock)
mock.module('src/utils/sleep.ts', () => ({
  sleep: async () => {},
}))
mock.module('bun:bundle', () => ({
  feature: () => false,
}))

const {
  claudeApiTraceInternals,
  runNonStreamingRequestAttempt,
  yieldNonStreamingRetryMessages,
} = await import('../../services/api/claude')
const { FallbackTriggeredError, withRetry } = await import(
  '../../services/api/withRetry'
)

describe('claude API trace instrumentation source boundaries', () => {
  const source = readFileSync(
    new URL('../../services/api/claude.ts', import.meta.url),
    'utf8',
  )
  const traceTypesSource = readFileSync(
    new URL('../types.ts', import.meta.url),
    'utf8',
  )

  test('declares the Task 9 API lifecycle tracepoints', () => {
    expect(source).toContain("type: 'api.request_built'")
    expect(source).toContain("type: 'api.stream_event'")
    expect(source).toContain("type: 'api.assistant_message'")
    expect(source).toContain("type: 'api.retry'")
    expect(source).toContain("type: 'api.error'")
    expect(source).not.toContain("type: 'api.response_completed'")
    expect(traceTypesSource).not.toContain("| 'api.response_completed'")
  })

  test('keeps API tracepoints behind direct HARNESS_TRACE guards', () => {
    const traceCalls = [...source.matchAll(/emitTrace\(\{/g)]

    expect(traceCalls.length).toBeGreaterThanOrEqual(5)
    expect(source).not.toContain("feature('HARNESS_TRACE') &&")
    expect(source).not.toContain('const isHarnessTrace')

    for (const match of traceCalls) {
      const index = match.index ?? 0
      const precedingSource = source.slice(Math.max(0, index - 500), index)

      expect(precedingSource).toContain("if (feature('HARNESS_TRACE')) {")
    }
  })

  test('emits request_built after params are assembled and before the stream request starts', () => {
    const paramsIndex = source.indexOf(
      'const params = paramsFromContext(context)',
    )
    const requestBuiltIndex = source.indexOf(
      "type: 'api.request_built'",
      paramsIndex,
    )
    const sdkStreamIndex = source.indexOf(
      'anthropic.beta.messages',
      paramsIndex,
    )

    expect(paramsIndex).toBeGreaterThanOrEqual(0)
    expect(requestBuiltIndex).toBeGreaterThan(paramsIndex)
    expect(requestBuiltIndex).toBeLessThan(sdkStreamIndex)
  })

  test('generates clientRequestId before request_built includes it', () => {
    const paramsIndex = source.indexOf(
      'const params = paramsFromContext(context)',
    )
    const requestBuiltIndex = source.indexOf(
      "type: 'api.request_built'",
      paramsIndex,
    )
    const sdkStreamIndex = source.indexOf(
      'anthropic.beta.messages',
      paramsIndex,
    )
    const clientRequestIdAssignmentIndex = source.indexOf(
      'clientRequestId =',
      paramsIndex,
    )

    expect(paramsIndex).toBeGreaterThanOrEqual(0)
    expect(clientRequestIdAssignmentIndex).toBeGreaterThan(paramsIndex)
    expect(clientRequestIdAssignmentIndex).toBeLessThan(requestBuiltIndex)
    expect(clientRequestIdAssignmentIndex).toBeLessThan(sdkStreamIndex)
    expect(source).toContain('clientRequestId: input.clientRequestId')
    expect(source).toContain(
      'headers: { [CLIENT_REQUEST_ID_HEADER]: clientRequestId }',
    )
  })

  test('keeps response summaries on allowed Task 9 events instead of response_completed', () => {
    expect(source).toContain(
      'usage: summarizeUsageForTrace(message.message.usage)',
    )
    expect(source).toContain('stopReason: message.message.stop_reason')
    expect(source).toContain('buildAPIStreamEventTracePayload(')
    expect(source).toContain("case 'message_delta'")
    expect(source).not.toContain('responseText')
    expect(source).not.toContain('messageContent')
  })
})

describe('claude API trace instrumentation behavior boundaries', () => {
  test('emits fallback request_built before dispatching the non-streaming request', async () => {
    const order: string[] = []
    const traceEvents: Array<{
      type: string
      payload: Record<string, unknown>
    }> = []
    const requestParams = {
      model: 'claude-test',
      max_tokens: 128,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'raw prompt must stay out of trace' },
          ],
        },
      ],
      tools: [{ name: 'search' }],
      betas: ['beta-a'],
      headers: {
        authorization: 'Bearer secret-token',
      },
    } as unknown as BetaMessageStreamParams

    const result = await runNonStreamingRequestAttempt(
      {
        attempt: 2,
        clientRequestId: 'client-1',
        previousRequestId: 'prev-1',
        provider: 'firstParty',
        querySource: 'sdk',
      },
      {} as never,
      () => requestParams,
      (attempt, _startTime, maxTokens) => {
        order.push(`attempt:${attempt}:${maxTokens}`)
      },
      params => {
        order.push('capture')
        expect(params).toBe(requestParams)
      },
      async adjustedParams => {
        order.push('request')
        expect(traceEvents.map(event => event.type)).toEqual([
          'api.request_built',
        ])
        expect(adjustedParams.max_tokens).toBe(128)

        return {
          id: 'msg_nonstreaming',
          model: 'claude-test',
          role: 'assistant',
          type: 'message',
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: {
            input_tokens: 1,
            output_tokens: 1,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
          content: [],
        } as unknown as BetaMessage
      },
      event => {
        order.push('trace')
        traceEvents.push(event)
      },
    )

    expect(result.id).toBe('msg_nonstreaming')
    expect(order).toEqual(['capture', 'attempt:2:128', 'trace', 'request'])
    expect(traceEvents[0]).toMatchObject({
      type: 'api.request_built',
      payload: {
        attempt: 2,
        betaCount: 1,
        betaFlags: ['beta-a'],
        clientRequestId: 'client-1',
        maxTokens: 128,
        messageCount: 1,
        model: 'claude-test',
        previousRequestId: 'prev-1',
        provider: 'firstParty',
        querySource: 'sdk',
        toolCount: 1,
      },
    })
    expect(JSON.stringify(traceEvents[0].payload)).not.toContain(
      'raw prompt must stay out of trace',
    )
    expect(JSON.stringify(traceEvents[0].payload)).not.toContain('secret-token')
  })

  test('emits api.retry when fallback retry messages are yielded', async () => {
    const traceEvents: Array<{
      type: string
      payload: Record<string, unknown>
    }> = []
    const retryMessage = {
      type: 'system',
      subtype: 'api_error',
      isMeta: true,
      message: {
        id: 'retry-message',
        content: 'Retrying after backend overload',
      },
      error: {
        name: 'APIError',
        status: 529,
        requestID: 'req_retry',
      },
      retryAttempt: 2,
      retryInMs: 250,
      maxRetries: 5,
      timestamp: new Date().toISOString(),
      uuid: 'system-retry-message',
    } as unknown as SystemAPIErrorMessage
    const finalResult = {
      id: 'msg_after_retry',
      model: 'claude-test',
      role: 'assistant',
      type: 'message',
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: 2,
        output_tokens: 3,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      content: [],
    } as unknown as BetaMessage

    async function* fakeRetryGenerator(): AsyncGenerator<
      SystemAPIErrorMessage,
      BetaMessage
    > {
      yield retryMessage
      return finalResult
    }

    const generator = yieldNonStreamingRetryMessages(
      fakeRetryGenerator(),
      {
        clientRequestId: 'client-1',
        model: 'claude-test',
        provider: 'firstParty',
        requestId: 'req_retry',
      },
      event => {
        traceEvents.push(event)
      },
    )

    const first = await generator.next()
    expect(first).toEqual({
      done: false,
      value: retryMessage,
    })
    expect(traceEvents).toHaveLength(1)
    expect(traceEvents[0]).toMatchObject({
      type: 'api.retry',
      payload: {
        attempt: 2,
        clientRequestId: 'client-1',
        errorName: 'APIError',
        maxRetries: 5,
        model: 'claude-test',
        provider: 'firstParty',
        requestId: 'req_retry',
        retryInMs: 250,
        status: 529,
      },
    })

    const done = await generator.next()
    expect(done).toEqual({
      done: true,
      value: finalResult,
    })
  })

  test('learn-mode stream payloads keep only tracing metadata and drop raw content details', () => {
    const requestPayload = claudeApiTraceInternals.buildAPIRequestTracePayload(
      {
        model: 'claude-test',
        max_tokens: 256,
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: 'top secret prompt text' }],
          },
        ],
        betas: ['beta-a', 'beta-b'],
        headers: {
          authorization: 'Bearer super-secret',
        },
      },
      {
        attempt: 1,
        clientRequestId: 'client-1',
        previousRequestId: 'prev-1',
        provider: 'firstParty',
        querySource: 'sdk',
      },
      'learn',
    )

    const messageStartPayload =
      claudeApiTraceInternals.buildAPIStreamEventTracePayload(
        {
          type: 'message_start',
          message: {
            id: 'msg_123',
            model: 'claude-leaky-model',
            role: 'assistant',
            type: 'message',
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: {
              input_tokens: 999,
              output_tokens: 0,
            },
          },
        } as unknown as BetaRawMessageStreamEvent,
        {
          attempt: 1,
          clientRequestId: 'client-1',
          elapsedMs: 41,
          provider: 'firstParty',
          requestId: 'req_stream',
        },
        'learn',
      )
    const contentBlockStartPayload =
      claudeApiTraceInternals.buildAPIStreamEventTracePayload(
        {
          type: 'content_block_start',
          index: 0,
          content_block: {
            type: 'tool_use',
            id: 'toolu_123',
            name: 'dangerous_tool_name',
            input: {
              prompt: 'raw tool input should not be recorded',
            },
          },
        } as unknown as BetaRawMessageStreamEvent,
        {
          attempt: 1,
          clientRequestId: 'client-1',
          elapsedMs: 42,
          provider: 'firstParty',
          requestId: 'req_stream',
        },
        'learn',
      )
    const contentBlockDeltaPayload =
      claudeApiTraceInternals.buildAPIStreamEventTracePayload(
        {
          type: 'content_block_delta',
          index: 0,
          delta: {
            type: 'text_delta',
            text: 'raw delta text should not be recorded',
          },
        } as unknown as BetaRawMessageStreamEvent,
        {
          attempt: 1,
          clientRequestId: 'client-1',
          elapsedMs: 43,
          provider: 'firstParty',
          requestId: 'req_stream',
          timeSincePreviousEventMs: 1,
        },
        'learn',
      )
    const messageDeltaPayload =
      claudeApiTraceInternals.buildAPIStreamEventTracePayload(
        {
          type: 'message_delta',
          delta: {
            stop_reason: 'end_turn',
            stop_sequence: null,
          },
          usage: {
            input_tokens: 999,
            output_tokens: 123,
          },
        } as unknown as BetaRawMessageStreamEvent,
        {
          attempt: 1,
          clientRequestId: 'client-1',
          elapsedMs: 44,
          provider: 'firstParty',
          requestId: 'req_stream',
          timeSincePreviousEventMs: 1,
        },
        'learn',
      )

    expect(requestPayload).toMatchObject({
      attempt: 1,
      betaCount: 2,
      betaFlags: ['beta-a', 'beta-b'],
      clientRequestId: 'client-1',
      maxTokens: 256,
      messageCount: 1,
      model: 'claude-test',
      previousRequestId: 'prev-1',
      provider: 'firstParty',
      querySource: 'sdk',
    })
    expect(messageStartPayload).toEqual({
      attempt: 1,
      clientRequestId: 'client-1',
      elapsedMs: 41,
      eventType: 'message_start',
      messageId: 'msg_123',
      provider: 'firstParty',
      requestId: 'req_stream',
    })
    expect(contentBlockStartPayload).toMatchObject({
      attempt: 1,
      clientRequestId: 'client-1',
      contentBlockIndex: 0,
      contentBlockId: 'toolu_123',
      elapsedMs: 42,
      eventType: 'content_block_start',
      provider: 'firstParty',
      requestId: 'req_stream',
    })
    expect(contentBlockDeltaPayload).toEqual({
      attempt: 1,
      clientRequestId: 'client-1',
      contentBlockIndex: 0,
      elapsedMs: 43,
      eventType: 'content_block_delta',
      provider: 'firstParty',
      requestId: 'req_stream',
      timeSincePreviousEventMs: 1,
    })
    expect(messageDeltaPayload).toEqual({
      attempt: 1,
      clientRequestId: 'client-1',
      elapsedMs: 44,
      eventType: 'message_delta',
      provider: 'firstParty',
      requestId: 'req_stream',
      timeSincePreviousEventMs: 1,
    })

    const serializedRequestPayload = JSON.stringify(requestPayload)
    const serializedStreamPayload = JSON.stringify([
      messageStartPayload,
      contentBlockStartPayload,
      contentBlockDeltaPayload,
      messageDeltaPayload,
    ])

    expect(serializedRequestPayload).not.toContain('top secret prompt text')
    expect(serializedRequestPayload).not.toContain('super-secret')
    expect(serializedRequestPayload).not.toContain('authorization')
    expect(serializedStreamPayload).not.toContain(
      'raw tool input should not be recorded',
    )
    expect(serializedStreamPayload).not.toContain(
      'raw delta text should not be recorded',
    )
    expect(serializedStreamPayload).not.toContain('claude-leaky-model')
    expect(serializedStreamPayload).not.toContain('dangerous_tool_name')
    expect(serializedStreamPayload).not.toContain('contentBlockType')
    expect(serializedStreamPayload).not.toContain('deltaType')
    expect(serializedStreamPayload).not.toContain('usage')
    expect(serializedStreamPayload).not.toContain('stopReason')
    expect(serializedStreamPayload).not.toContain('rawEvent')
  })

  test('full-mode request_built payloads include raw request params that redact secret values', () => {
    const requestParams = {
      model: 'claude-test',
      max_tokens: 256,
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'full trace prompt content' }],
        },
      ],
      tools: [{ name: 'search' }],
      betas: ['beta-a'],
      headers: {
        authorization: 'Bearer request-secret',
      },
      metadata: {
        api_key: 'sk-request-secret',
      },
    }

    const payload = claudeApiTraceInternals.buildAPIRequestTracePayload(
      requestParams,
      {
        attempt: 1,
        clientRequestId: 'client-1',
        previousRequestId: 'prev-1',
        provider: 'firstParty',
        querySource: 'sdk',
      },
      'full',
    )

    expect(payload).toMatchObject({
      attempt: 1,
      betaCount: 1,
      betaFlags: ['beta-a'],
      model: 'claude-test',
      rawRequestParams: requestParams,
    })
    expect(requestParams).not.toHaveProperty('rawRequestParams')

    const redactedPayload = redactTracePayload(payload, 'full')
    const serializedRedactedPayload = JSON.stringify(redactedPayload)

    expect(serializedRedactedPayload).toContain('"rawRequestParams"')
    expect(serializedRedactedPayload).toContain('full trace prompt content')
    expect(serializedRedactedPayload).not.toContain('request-secret')
    expect(serializedRedactedPayload).not.toContain('sk-request-secret')
    expect(serializedRedactedPayload).toContain('[REDACTED]')
  })

  test('full-mode stream payloads include a redacted raw event copy', () => {
    const fullPayload = claudeApiTraceInternals.buildAPIStreamEventTracePayload(
      {
        type: 'content_block_delta',
        index: 0,
        delta: {
          type: 'text_delta',
          text: 'Bearer secret-token',
        },
      } as unknown as BetaRawMessageStreamEvent,
      {
        attempt: 3,
        clientRequestId: 'client-1',
        elapsedMs: 64,
        provider: 'firstParty',
        requestId: 'req_stream',
        timeSincePreviousEventMs: 7,
      },
      'full',
    )

    expect(fullPayload).toMatchObject({
      attempt: 3,
      clientRequestId: 'client-1',
      contentBlockIndex: 0,
      deltaType: 'text_delta',
      elapsedMs: 64,
      eventType: 'content_block_delta',
      provider: 'firstParty',
      rawEvent: {
        delta: {
          text: 'Bearer secret-token',
          type: 'text_delta',
        },
        index: 0,
        type: 'content_block_delta',
      },
      requestId: 'req_stream',
      timeSincePreviousEventMs: 7,
    })

    const redactedPayload = redactTracePayload(fullPayload, 'full')
    const serializedRedactedPayload = JSON.stringify(redactedPayload)

    expect(serializedRedactedPayload).toContain('"rawEvent"')
    expect(serializedRedactedPayload).not.toContain('secret-token')
    expect(serializedRedactedPayload).toContain('[REDACTED]')
  })

  test('withRetry exposes fallback-model trace metadata when the retry loop switches models', async () => {
    const traceEvents: unknown[] = []
    const overloadedError = new APIError(
      529,
      { error: { type: 'overloaded_error' }, message: 'overloaded' },
      undefined,
      new Headers([['request-id', 'req-fallback']]),
      'overloaded_error',
    )

    const originalFallbackEnv = process.env.FALLBACK_FOR_ALL_PRIMARY_MODELS
    process.env.FALLBACK_FOR_ALL_PRIMARY_MODELS = '1'

    try {
      const generator = withRetry(
        async () => ({}) as never,
        async () => {
          throw overloadedError
        },
        {
          fallbackModel: 'claude-sonnet-fallback',
          model: 'claude-opus-primary',
          onRetryTrace: event => {
            traceEvents.push(event)
          },
          provider: 'firstParty',
          thinkingConfig: { type: 'disabled' },
        },
      )

      await expect(generator.next()).resolves.toMatchObject({ done: false })
      await expect(generator.next()).resolves.toMatchObject({ done: false })
      await expect(generator.next()).rejects.toBeInstanceOf(
        FallbackTriggeredError,
      )
    } finally {
      if (originalFallbackEnv === undefined) {
        delete process.env.FALLBACK_FOR_ALL_PRIMARY_MODELS
      } else {
        process.env.FALLBACK_FOR_ALL_PRIMARY_MODELS = originalFallbackEnv
      }
    }

    expect(traceEvents).toEqual([
      {
        attempt: 3,
        fallbackModel: 'claude-sonnet-fallback',
        maxRetries: 10,
        model: 'claude-opus-primary',
        provider: 'firstParty',
        retryType: 'fallback_model_selected',
        status: 529,
      },
    ])
  })

  test('withRetry exposes max-token retry metadata when it shrinks the next attempt budget', async () => {
    const traceEvents: unknown[] = []
    const overflowError = new APIError(
      400,
      {
        error: { type: 'invalid_request_error' },
        message:
          'input length and `max_tokens` exceed context limit: 188059 + 20000 > 200000',
      },
      undefined,
      new Headers([['request-id', 'req-overflow']]),
      'invalid_request_error',
    )
    const contexts: Array<{ maxTokensOverride?: number }> = []

    const generator = withRetry(
      async () => ({}) as never,
      async (_client, attempt, context) => {
        contexts.push({ maxTokensOverride: context.maxTokensOverride })
        if (attempt === 1) {
          throw overflowError
        }
        return 'ok'
      },
      {
        model: 'claude-test',
        onRetryTrace: event => {
          traceEvents.push(event)
        },
        provider: 'firstParty',
        thinkingConfig: { type: 'disabled' },
      },
    )

    await expect(generator.next()).resolves.toEqual({
      done: true,
      value: 'ok',
    })

    expect(contexts).toEqual([
      { maxTokensOverride: undefined },
      { maxTokensOverride: 10941 },
    ])
    expect(traceEvents).toEqual([
      {
        adjustedMaxTokens: 10941,
        attempt: 1,
        contextLimit: 200000,
        inputTokens: 188059,
        maxRetries: 10,
        model: 'claude-test',
        provider: 'firstParty',
        retryType: 'max_tokens_retry_triggered',
        status: 400,
      },
    ])
  })
})
