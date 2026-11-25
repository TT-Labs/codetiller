import type { CheckResult } from '../score/score.js'

/**
 * Verification in a fresh container from clean checkout + agent diff + hidden tests:
 * build → lint → fail_to_pass → pass_to_pass. Parsers per repo profile.
 */
export type TestParser = (output: string) => { name: string; passed: boolean }[]

export interface Verifier {
  verify(runId: string): Promise<CheckResult[]>
}
