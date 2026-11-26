import { randomUUID } from 'node:crypto'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { adapterFor } from '../agents/index.js'
import { type Config, configHash } from '../config/config.js'
import { renderContext, type Skill } from '../context/context.js'
import { overlayContext } from '../context/overlay.js'
import { contextFileFor } from '../context/skills.js'
import { TaskRepo } from '../factory/repo.js'
import type { RepoProfile } from '../profile/profile.js'
import { ensureDeps } from '../sandbox/deps.js'
import { type ModelGateway, modelAccess, runAccounted } from '../sandbox/gateway.js'
import type { Prices } from '../sandbox/prices.js'
import type { Sandbox } from '../sandbox/sandbox.js'
import { type CheckResult, type Outcome, scoreRun } from '../score/score.js'
import type { Store } from '../store/store.js'
import { runTests } from '../verify/tests.js'
import { applyPatch, diffStats, type GitWorkspaces } from '../workspace/git.js'
import type { Task } from './dataset/task.js'

export interface RunDeps {
  sandbox: Sandbox
  workspaces: GitWorkspaces
  store: Store
  env: Record<string, string>
  /** Agents reach the model through this and nothing else */
  gateway?: ModelGateway
  /** model prices the gateway budgets with; default: the built-in list */
  prices?: Prices
  log?: (m: string) => void
}

export interface RunSpec {
  task: Task
  dataset: string
  profile: RepoProfile
  config: Config
  promptTemplate: string
  /** resolved config.skills, in config order */
  skills?: Skill[]
  benchmarkId?: string
  repeat?: number
  keepWorkspace?: boolean
}

export function renderPrompt(template: string, task: Task): string {
  // replacer function: `$&`, `$'` or `$$` in an issue must stay literal
  return template.replace('{{issue}}', () => `# ${task.issue.title}\n\n${task.issue.body.trim()}`)
}

/** One run = workspace → agent in sandbox → diff → verify in fresh container → store. */
export async function runTask(spec: RunSpec, deps: RunDeps) {
  const { task, profile, config } = spec
  const { sandbox, workspaces, store, log = () => {} } = deps
  const runId = `${task.id}-${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}-${randomUUID().slice(0, 6)}`
  const dir = await store.runDir(runId)
  const skills = spec.skills ?? []
  if (skills.length !== config.skills.length)
    throw new Error('config.skills not resolved (pass spec.skills)')
  const context = skills.length ? renderContext(undefined, skills) : ''
  const configId = configHash(config, spec.promptTemplate, context)
  const startedAt = new Date().toISOString()

  store.upsertTask(task, spec.dataset)
  store.upsertConfig(configId, config, spec.promptTemplate)

  await workspaces.ensureRepo(task.repo, [task.base_commit, task.fix_commit])

  // 1. agent
  const prompt = renderPrompt(spec.promptTemplate, task)
  const promptFile = join(dir, 'prompt.md')
  await writeFile(promptFile, prompt)
  // the agent gets the tree at base with a history-less scratch repo (no `git show <fix>`); the
  // host diffs it from a git dir outside the workspace and never runs git inside it
  const ws = join(workspaces.cacheDir, 'work', `run-${runId}`)
  const repo = new TaskRepo(`${ws}.repo`, ws)
  await rm(ws, { recursive: true, force: true })
  await repo.init(workspaces.repoCache(task.repo), task.base_commit, 'run')
  const nm = await ensureDeps(sandbox, profile, ws, task.repo, log)
  // context pack: untracked file written after the base commit, removed before diffing
  const contextFile = contextFileFor(config.harness)
  // render order: repo's own context file first, then skills
  const overlay = await overlayContext(ws, contextFile, skills)
  if (overlay.rendered) {
    await writeFile(join(dir, 'context.md'), overlay.rendered)
  }
  log(`agent: ${config.harness} ${config.model} (workspace ${ws})`)
  const access = await modelAccess(deps.env, deps.gateway, {
    label: `benchmark ${runId}`,
    config,
    prices: deps.prices,
  })
  // cost and a budget stop come from the gateway's count, not from the agent's own report
  const { agent } = await runAccounted(access, () =>
    adapterFor(config.harness).run({
      sandbox,
      image: profile.image,
      workspace: ws,
      promptFile,
      volumes: nm.volumes,
      tmpfs: nm.scratch,
      config,
      env: access.env,
      network: access.network,
      offline: access.offline,
    }),
  )
  await writeFile(join(dir, 'transcript.jsonl'), agent.transcript)
  if (agent.stderr) await writeFile(join(dir, 'agent.stderr.log'), agent.stderr)
  log(
    `agent: ${agent.exit}, $${agent.cost_usd?.toFixed(2) ?? '?'}, ${agent.turns ?? '?'} turns, ${agent.duration_s.toFixed(0)}s`,
  )

  // 2. diff (agent changes only; hidden test files never come from the agent)
  await overlay.restore()
  const patch = await repo.changes(task.hidden_tests)
  const patchFile = join(dir, 'diff.patch')
  await writeFile(patchFile, patch)
  const stats = diffStats(patch)
  if (spec.keepWorkspace) await rm(repo.holder, { recursive: true, force: true })
  else await repo.dispose()

  // 3. verify in fresh workspace + fresh container: base + agent patch + hidden tests
  let checks: CheckResult[] = []
  let outcome: Outcome
  let score = 0
  if (agent.exit === 'timeout') outcome = 'timeout'
  else if (!patch.trim()) outcome = 'fail'
  else {
    log(`verify: ${stats.files} files, ${stats.lines} lines changed`)
    const vws = await workspaces.create(task.repo, task.base_commit, `verify-${runId}`)
    try {
      await applyPatch(vws, patchFile)
      await workspaces.checkoutFiles(vws, task.fix_commit, task.hidden_tests)
      const t = await runTests(sandbox, profile, vws, task.hidden_tests, { deps: nm })
      await writeFile(join(dir, 'checks', 'tests.log'), `${t.exec.stdout}\n${t.exec.stderr}`)
      if (!t.cases) {
        outcome = 'error'
      } else {
        checks = checksFrom(task, t.cases)
        ;({ outcome, score } = scoreRun(checks))
      }
    } catch (e) {
      await writeFile(join(dir, 'checks', 'apply.log'), String(e))
      outcome = 'fail'
    } finally {
      await workspaces.dispose(vws)
    }
  }

  const run = {
    id: runId,
    task_id: task.id,
    config_id: configId,
    benchmark_id: spec.benchmarkId ?? null,
    repeat: spec.repeat ?? 0,
    started_at: startedAt,
    duration_s: agent.duration_s,
    cost_usd: agent.cost_usd,
    cost_source: agent.cost_source,
    input_tokens: agent.input_tokens ?? null,
    output_tokens: agent.output_tokens ?? null,
    turns: agent.turns ?? null,
    agent_exit: agent.exit,
    diff_files: stats.files,
    diff_lines: stats.lines,
    outcome,
    score,
  }
  store.insertRun(run, checks)
  return { run, checks, dir }
}

function checksFrom(task: Task, cases: { id: string; passed: boolean }[]): CheckResult[] {
  const f2p = new Set(task.fail_to_pass)
  const p2pAll = task.pass_to_pass === 'suite'
  const p2p = new Set(p2pAll ? [] : (task.pass_to_pass as string[]))
  const f = cases.filter((c) => f2p.has(c.id))
  const p = cases.filter((c) => !f2p.has(c.id) && (p2pAll || p2p.has(c.id)))
  const mk = (name: 'fail_to_pass' | 'pass_to_pass', cs: typeof cases, expected: number) => {
    const failed = cs.filter((c) => !c.passed).length + Math.max(0, expected - cs.length)
    return { name, passed: failed === 0, total: Math.max(expected, cs.length), failed }
  }
  return [mk('fail_to_pass', f, f2p.size), mk('pass_to_pass', p, p.length)]
}

export const readPrompt = (path: string) => readFile(path, 'utf8')
