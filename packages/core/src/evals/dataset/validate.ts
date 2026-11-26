import type { RepoProfile } from '../../profile/profile.js'
import { ensureDeps } from '../../sandbox/deps.js'
import type { Sandbox } from '../../sandbox/sandbox.js'
import { runTests, type TestRun } from '../../verify/tests.js'
import type { GitWorkspaces } from '../../workspace/git.js'
import type { Task } from './task.js'

export interface ValidationResult {
  task: string
  valid: boolean
  reasons: string[]
  base: { failing: string[] }[]
  fix: { failing: string[] }[]
}

const failing = (r: TestRun) => (r.cases ?? []).filter((c) => !c.passed).map((c) => c.id)

/**
 * Task valid iff
 *  1. base + hidden tests → every fail_to_pass fails, pass_to_pass passes
 *  2. fix_commit → every test in hidden files passes
 *  3. same result over `repeats`
 */
export async function validateTask(
  task: Task,
  profile: RepoProfile,
  deps: { sandbox: Sandbox; workspaces: GitWorkspaces },
  repeats = 2,
  log: (m: string) => void = () => {},
): Promise<ValidationResult> {
  const { sandbox, workspaces } = deps
  const reasons: string[] = []
  const f2p = new Set(task.fail_to_pass)
  const p2pAll = task.pass_to_pass === 'suite'
  const p2p = new Set(p2pAll ? [] : (task.pass_to_pass as string[]))

  await workspaces.ensureRepo(task.repo, [task.base_commit, task.fix_commit])
  const ws = await workspaces.create(task.repo, task.base_commit, `validate-${task.id}`)
  let nm = await ensureDeps(sandbox, profile, ws, task.repo, log)
  const run = () => runTests(sandbox, profile, ws, task.hidden_tests, { deps: nm })

  try {
    await workspaces.checkoutFiles(ws, task.fix_commit, task.hidden_tests)
    const base: TestRun[] = []
    for (let i = 0; i < repeats; i++) {
      log(`  base + hidden tests, repeat ${i + 1}/${repeats}`)
      base.push(await run())
    }
    await workspaces.switchTo(ws, task.fix_commit)
    nm = await ensureDeps(sandbox, profile, ws, task.repo, log)
    const fix: TestRun[] = []
    for (let i = 0; i < repeats; i++) {
      log(`  fix commit, repeat ${i + 1}/${repeats}`)
      fix.push(await run())
    }

    for (const [label, runs] of [
      ['base', base],
      ['fix', fix],
    ] as const) {
      for (const r of runs) {
        if (!r.cases)
          reasons.push(
            `${label}: no test report (exit ${r.exec.exitCode}): ${r.exec.stderr.slice(-500)}`,
          )
      }
    }
    if (reasons.length === 0) {
      const ids = new Set(base[0]?.cases?.map((c) => c.id))
      for (const id of f2p) if (!ids.has(id)) reasons.push(`fail_to_pass not found: ${id}`)
      for (const r of base) {
        for (const c of r.cases ?? []) {
          if (f2p.has(c.id) && c.passed) reasons.push(`base: fail_to_pass passes: ${c.id}`)
          if (!f2p.has(c.id) && (p2pAll || p2p.has(c.id)) && !c.passed)
            reasons.push(`base: pass_to_pass fails: ${c.id}`)
        }
      }
      for (const r of fix) for (const id of failing(r)) reasons.push(`fix: fails: ${id}`)
      const sig = (rs: TestRun[]) => rs.map((r) => failing(r).sort().join('|'))
      if (new Set(sig(base)).size > 1) reasons.push('base: flaky across repeats')
      if (new Set(sig(fix)).size > 1) reasons.push('fix: flaky across repeats')
    }

    return {
      task: task.id,
      valid: reasons.length === 0,
      reasons: [...new Set(reasons)],
      base: base.map((r) => ({ failing: failing(r) })),
      fix: fix.map((r) => ({ failing: failing(r) })),
    }
  } finally {
    await workspaces.dispose(ws)
  }
}
