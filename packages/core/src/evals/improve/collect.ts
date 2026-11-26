import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { RepoProfile } from '../../profile/profile.js'
import { ensureDeps } from '../../sandbox/deps.js'
import type { Sandbox } from '../../sandbox/sandbox.js'
import { runTests } from '../../verify/tests.js'
import { applyPatch, type GitWorkspaces, git } from '../../workspace/git.js'
import { isTestFile } from '../dataset/mine.js'
import type { Task } from '../dataset/task.js'
import type { FailureEvidence } from './improve.js'

const lastResultText = (transcript: string) => {
  for (const line of transcript.trim().split('\n').reverse()) {
    try {
      const ev = JSON.parse(line) as { type?: string; result?: string }
      if (ev.type === 'result') return ev.result ?? ''
    } catch {}
  }
  return ''
}

/**
 * Evidence for one failed run. Re-verifies the stored patch to get the failing tests' messages
 * (reports aren't persisted), and takes the reference fix from fix_commit — allowed for train only.
 */
export async function collectEvidence(
  run: { id: string; task: Task },
  deps: { sandbox: Sandbox; workspaces: GitWorkspaces; profile: RepoProfile; artifactsDir: string },
): Promise<FailureEvidence> {
  const { task } = run
  const dir = join(deps.artifactsDir, run.id)
  const patchFile = join(dir, 'diff.patch')
  const agentDiff = await readFile(patchFile, 'utf8').catch(() => '')
  const transcript = await readFile(join(dir, 'transcript.jsonl'), 'utf8').catch(() => '')

  const cache = await deps.workspaces.ensureRepo(task.repo, [task.base_commit, task.fix_commit])
  const changed = (await git(cache, 'diff', '--name-only', task.base_commit, task.fix_commit))
    .split('\n')
    .filter((f) => f && !isTestFile(f))
  const referenceDiff = changed.length
    ? await git(cache, 'diff', task.base_commit, task.fix_commit, '--', ...changed)
    : ''

  let failing = '(agent produced no patch)'
  if (agentDiff.trim()) {
    const ws = await deps.workspaces.create(task.repo, task.base_commit, `evidence-${run.id}`)
    try {
      await applyPatch(ws, patchFile)
      await deps.workspaces.checkoutFiles(ws, task.fix_commit, task.hidden_tests)
      const nm = await ensureDeps(deps.sandbox, deps.profile, ws, task.repo)
      const t = await runTests(deps.sandbox, deps.profile, ws, task.hidden_tests, { deps: nm })
      const fails = (t.cases ?? []).filter((c) => !c.passed)
      failing = fails.length
        ? fails.map((c) => `✗ ${c.id}\n${c.message ?? ''}`).join('\n\n')
        : t.cases
          ? '(all hidden tests pass on re-verify — flaky run?)'
          : `(no report) ${t.exec.stderr.slice(-1500)}`
    } catch (e) {
      failing = `(patch does not apply: ${(e as Error).message.split('\n')[0]})`
    } finally {
      await deps.workspaces.dispose(ws)
    }
  }

  return {
    run_id: run.id,
    task_id: task.id,
    issue: `# ${task.issue.title}\n\n${task.issue.body}`,
    agent_diff: agentDiff || '(empty)',
    reference_diff: referenceDiff,
    failing_output: failing,
    agent_summary: lastResultText(transcript),
  }
}
