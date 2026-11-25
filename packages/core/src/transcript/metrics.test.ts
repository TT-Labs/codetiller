import { expect, it } from 'vitest'
import { processMetrics } from './metrics.js'
import type { TranscriptEvent } from './transcript.js'

const bash = (id: string, command: string): TranscriptEvent => ({
  kind: 'tool_call',
  id,
  name: 'Bash',
  input: { command },
})

it('counts tool calls, failed results and test-runner invocations', () => {
  const m = processMetrics([
    bash('1', 'rg -n "latest" src'),
    { kind: 'tool_result', id: '1', output: '', is_error: false },
    bash('2', 'cd packages/zod && pnpm test -- string'),
    { kind: 'tool_result', id: '2', output: 'boom', is_error: true },
    bash('3', 'node_modules/.bin/vitest run src/a.test.ts'),
    { kind: 'tool_call', id: '4', name: 'Read', input: { file_path: 'vitest.config.ts' } },
    { kind: 'text', role: 'assistant', text: 'I ran vitest' },
  ])
  expect(m).toEqual({ tool_calls: 4, tool_errors: 1, test_runs: 2 })
})
