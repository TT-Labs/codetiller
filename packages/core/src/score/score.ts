export type CheckName = 'build' | 'lint' | 'fail_to_pass' | 'pass_to_pass'
export type Outcome = 'success' | 'fail' | 'error' | 'timeout'

export interface CheckResult {
  name: CheckName
  passed: boolean
  total?: number
  failed?: number
  duration_s?: number
}

const ratio = (c?: CheckResult) => {
  if (!c) return 0
  if (c.total) return (c.total - (c.failed ?? 0)) / c.total
  return c.passed ? 1 : 0
}

/** Success = all checks pass; score is diagnostic only. Missing build/lint = not configured. */
export function scoreRun(checks: CheckResult[]): { outcome: Outcome; score: number } {
  const by = new Map(checks.map((c) => [c.name, c]))
  const ok = (n: CheckName, optional: boolean) => by.get(n)?.passed ?? optional
  const success =
    ok('build', true) && ok('lint', true) && ok('fail_to_pass', false) && ok('pass_to_pass', false)
  const optRatio = (n: CheckName) => (by.has(n) ? ratio(by.get(n)) : 1)
  const score =
    0.5 * ratio(by.get('fail_to_pass')) +
    0.3 * ratio(by.get('pass_to_pass')) +
    0.1 * optRatio('build') +
    0.1 * optRatio('lint')
  return { outcome: success ? 'success' : 'fail', score }
}
