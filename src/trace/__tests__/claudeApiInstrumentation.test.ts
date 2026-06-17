import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'bun:test'

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
    const requestBuiltIndex = source.indexOf("type: 'api.request_built'")
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
    const requestBuiltIndex = source.indexOf("type: 'api.request_built'")
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
