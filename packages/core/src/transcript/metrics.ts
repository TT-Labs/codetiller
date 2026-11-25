import type { TranscriptEvent } from './transcript.js'

// a test runner started directly or through a package-manager script
const TEST_RUN =
  /\b(?:vitest|jest|mocha|pytest|go test|cargo test|(?:pnpm|npm|yarn|bun)(?: run)? test)\b/

export interface ProcessMetrics {
  tool_calls: number
  /** tool results flagged as errors (failed commands, rejected edits) */
  tool_errors: number
  /** shell commands that start a test runner */
  test_runs: number
}

/**
 * What the agent did, as opposed to whether the hidden tests passed: context that changes behaviour
 * shows up here even when the success rate cannot resolve it.
 */
export function processMetrics(events: TranscriptEvent[]): ProcessMetrics {
  const m: ProcessMetrics = { tool_calls: 0, tool_errors: 0, test_runs: 0 }
  for (const e of events) {
    if (e.kind === 'tool_result' && e.is_error) m.tool_errors++
    if (e.kind !== 'tool_call') continue
    m.tool_calls++
    const command = (e.input as { command?: unknown } | null)?.command
    if (typeof command === 'string' && TEST_RUN.test(command)) m.test_runs++
  }
  return m
}
