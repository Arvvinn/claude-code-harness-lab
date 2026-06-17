import { readFileSync } from 'node:fs'
import { describe, expect, mock, test } from 'bun:test'
import type {
  BetaMessage,
  BetaMessageStreamParams,
  BetaRawMessageStreamEvent,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type { SystemAPIErrorMessage } from '../../types/message'
import { debugMock } from '../../../tests/mocks/debug.js'
import { logMock } from '../../../tests/mocks/log.js'

mock.module('src/utils/debug.ts', debugMock)
mock.module('src/utils/log.ts', logMock)
mock.module('bun:bundle', () => ({
  feature: () => false,
}))

const {
  claudeApiTraceInternals,
  runNonStreamingRequestAttempt,
  yieldNonStreamingRetryMessages,
} = await import('../../services/api/claude')

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
    expect(source).toContain("type: 'api.response_completed'")
    expect(source).toContain("type: 'api.retry'")
    expect(source).toContain("type: 'api.error'")
    expect(traceTypesSource).toContain("| 'api.response_completed'")
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

  test('emits response_completed only after final usage and stop reason are available', () => {
    const messageDeltaIndex = source.indexOf("case 'message_delta'")
    const usageUpdateIndex = source.indexOf(
      'usage = updateUsage(usage, part.usage)',
      messageDeltaIndex,
    )
    const stopReasonIndex = source.indexOf(
      'stopReason = part.delta.stop_reason',
      messageDeltaIndex,
    )
    const responseCompletedIndex = source.indexOf(
      "type: 'api.response_completed'",
    )
    const successLogIndex = source.indexOf('logAPISuccessAndDuration({')

    expect(messageDeltaIndex).toBeGreaterThanOrEqual(0)
    expect(usageUpdateIndex).toBeGreaterThan(messageDeltaIndex)
    expect(stopReasonIndex).toBeGreaterThan(usageUpdateIndex)
    expect(responseCompletedIndex).toBeGreaterThan(stopReasonIndex)
    expect(responseCompletedIndex).toBeLessThan(successLogIndex)
    expect(source).toContain('usage: summarizeUsageForTrace(input.usage)')
    expect(source).toContain('usage,')
    expect(source).toContain('stopReason')
    expect(source).toContain('assistantMessageCount: newMessages.length')
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

  test('payload builders exclude raw prompt text, stream deltas, and auth header values', () => {
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
    )

    const streamPayload =
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
          elapsedMs: 42,
          provider: 'firstParty',
          requestId: 'req_stream',
        },
      )

    expect(requestPayload).toMatchObject({
      attempt: 1,
      clientRequestId: 'client-1',
      maxTokens: 256,
      messageCount: 1,
      model: 'claude-test',
      previousRequestId: 'prev-1',
      provider: 'firstParty',
      querySource: 'sdk',
    })
    expect(streamPayload).toMatchObject({
      attempt: 1,
      clientRequestId: 'client-1',
      contentBlockIndex: 0,
      deltaType: 'text_delta',
      elapsedMs: 42,
      eventType: 'content_block_delta',
      provider: 'firstParty',
      requestId: 'req_stream',
    })

    const serializedRequestPayload = JSON.stringify(requestPayload)
    const serializedStreamPayload = JSON.stringify(streamPayload)

    expect(serializedRequestPayload).not.toContain('top secret prompt text')
    expect(serializedRequestPayload).not.toContain('super-secret')
    expect(serializedRequestPayload).not.toContain('authorization')
    expect(serializedStreamPayload).not.toContain(
      'raw delta text should not be recorded',
    )
    expect(serializedStreamPayload).not.toContain('"text"')
  })
})
