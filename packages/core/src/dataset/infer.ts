import { ensureDeps } from '../sandbox/deps.js'
import type { Sandbox } from '../sandbox/sandbox.js'
import { runTests, type TestRun } from '../verify/tests.js'
import type { GitWorkspaces } from '../workspace/git.js'
import type { Draft } from './mine.js'
import type { RepoProfile } from './task.js'

export interface InferResult {
  id: string
  ok: boolean
  reason?: string
  fail_to_pass: string[]
}

const failingIds = (r: TestRun) =>
  new Set((r.cases ?? []).filter((c) => !c.passed).map((c) => c.id))

/**
 * Run hidden tests at base (with tests from fix) and at fix, `repeats` times each.
 * fail_to_pass = fails at base in every repeat ∧ passes at fix in every repeat.
 * Rejected if anything fails at fix, a run has no report, or results differ across repeats.
 */
export async function inferFailToPass(
  draft: Draft,
  profile: RepoProfile,
  deps: { sandbox: Sandbox; workspaces: GitWorkspaces },
  repeats = 2,
  log: (m: string) => void = () => {},
): Promise<InferResult> {
  const { sandbox, workspaces } = deps
  const res = (ok: boolean, f2p: string[], reason?: string): InferResult => ({
    id: draft.id,
    ok,
    reason,
    fail_to_pass: f2p,
  })
  await workspaces.ensureRepo(draft.repo, [draft.base_commit, draft.fix_commit])
  const ws = await workspaces.create(draft.repo, draft.base_commit, `infer-${draft.id}`)
  try {
    const runAll = async (label: string) => {
      const nm = await ensureDeps(sandbox, profile, ws, draft.repo, log)
      const runs: TestRun[] = []
      for (let i = 0; i < repeats; i++) {
        log(`  ${label} ${i + 1}/${repeats}`)
        runs.push(await runTests(sandbox, profile, ws, draft.hidden_tests, { deps: nm }))
      }
      return runs
    }
    await workspaces.checkoutFiles(ws, draft.fix_commit, draft.hidden_tests)
    const base = await runAll('base')
    await workspaces.switchTo(ws, draft.fix_commit)
    const fix = await runAll('fix')

    const broken = [...base, ...fix].find((r) => !r.cases)
    if (broken) {
      const tail = `${broken.exec.stderr}\n${broken.exec.stdout}`
        .trim()
        .split('\n')
        .slice(-3)
        .join(' | ')
      return res(false, [], `no test report (exit ${broken.exec.exitCode}): ${tail.slice(0, 300)}`)
    }
    const fixFails = fix.flatMap((r) => [...failingIds(r)])
    if (fixFails.length) return res(false, [], `fails at fix: ${fixFails[0]}`)
    const sig = (s: Set<string>) => [...s].sort().join('|')
    if (new Set(base.map((r) => sig(failingIds(r)))).size > 1)
      return res(false, [], 'flaky at base')
    const first = base[0]
    if (!first) return res(false, [], 'no runs')
    const f2p = [...failingIds(first)].sort()
    if (f2p.length === 0)
      return res(false, [], 'no test fails at base (type-only or untestable fix)')
    return res(true, f2p)
  } finally {
    await workspaces.dispose(ws)
  }
}
