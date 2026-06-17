import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'bun:test'

describe('claude API trace instrumentation source boundaries', () => {
  const source = readFileSync(
    new URL('../../services/api/claude.ts', import.meta.url),
    'utf8',
  )

  test('declares the Task 9 API lifecycle tracepoints', () => {
    expect(source).toContain("type: 'api.request_built'")
    expect(source).toContain("type: 'api.stream_event'")
    expect(source).toContain("type: 'api.assistant_message'")
    expect(source).toContain("type: 'api.retry'")
    expect(source).toContain("type: 'api.error'")
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
})
