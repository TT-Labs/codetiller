import { randomUUID } from 'node:crypto'
import type { Config } from './config/config.js'
import { configHash } from './config/config.js'
import { renderContext, type Skill } from './context/context.js'
import type { RepoProfile, Task } from './dataset/task.js'
import { type RunDeps, runTask } from './run.js'

export interface BenchmarkSpec {
  name: string
  dataset: string
  split: string
  tasks: Task[]
  profile: RepoProfile
  config: Config
  promptTemplate: string
  skills?: Skill[]
  repeats: number
  concurrency: number
  budgetUsd?: number
}

export interface BenchmarkSummary {
  id: string
  name: string
  runs: number
  successes: number
  successRate: number
  totalCost: number
  costPerRun: number
  costPerSuccess: number | null
  medianDuration: number
  timeouts: number
  errors: number
  skippedForBudget: number
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length === 0 ? 0 : s.length % 2 ? (s[m] ?? 0) : ((s[m - 1] ?? 0) + (s[m] ?? 0)) / 2
}

/** Dataset × config × repeats, bounded concurrency, hard budget cap (no new runs once hit). */
export async function runBenchmark(spec: BenchmarkSpec, deps: RunDeps): Promise<BenchmarkSummary> {
  const { store, log = () => {} } = deps
  const id = `${spec.name}-${randomUUID().slice(0, 8)}`
  const skills = spec.skills ?? []
  const configId = configHash(
    spec.config,
    spec.promptTemplate,
    skills.length ? renderContext(undefined, skills) : '',
  )
  store.upsertConfig(configId, spec.config, spec.promptTemplate)
  store.createBenchmark({
    id,
    name: spec.name,
    dataset: spec.dataset,
    config_id: configId,
    split: spec.split,
    repeats: spec.repeats,
  })

  const queue = spec.tasks.flatMap((task) =>
    Array.from({ length: spec.repeats }, (_, repeat) => ({ task, repeat })),
  )
  const total = queue.length
  let spent = 0
  let done = 0
  let skipped = 0
  const results: { outcome: string; cost: number; duration: number; exit: string }[] = []

  const worker = async () => {
    for (let item = queue.shift(); item; item = queue.shift()) {
      if (spec.budgetUsd !== undefined && spent >= spec.budgetUsd) {
        skipped++
        continue
      }
      const label = `${item.task.id}#${item.repeat}`
      try {
        const { run } = await runTask(
          {
            task: item.task,
            dataset: spec.dataset,
            profile: spec.profile,
            config: spec.config,
            promptTemplate: spec.promptTemplate,
            skills,
            benchmarkId: id,
            repeat: item.repeat,
          },
          { ...deps, log: () => {} },
        )
        spent += run.cost_usd ?? 0
        results.push({
          outcome: run.outcome,
          cost: run.cost_usd ?? 0,
          duration: run.duration_s,
          exit: run.agent_exit,
        })
        log(
          `[${++done}/${total}] ${run.outcome.padEnd(7)} ${label}  $${(run.cost_usd ?? 0).toFixed(2)} ${run.duration_s.toFixed(0)}s  (spent $${spent.toFixed(2)})`,
        )
      } catch (e) {
        results.push({ outcome: 'error', cost: 0, duration: 0, exit: 'error' })
        log(`[${++done}/${total}] ERROR   ${label}  ${(e as Error).message.split('\n')[0]}`)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, spec.concurrency) }, worker))
  store.finishBenchmark(id)

  const successes = results.filter((r) => r.outcome === 'success').length
  const totalCost = results.reduce((s, r) => s + r.cost, 0)
  return {
    id,
    name: spec.name,
    runs: results.length,
    successes,
    successRate: results.length ? successes / results.length : 0,
    totalCost,
    costPerRun: results.length ? totalCost / results.length : 0,
    costPerSuccess: successes ? totalCost / successes : null,
    medianDuration: median(results.map((r) => r.duration)),
    timeouts: results.filter((r) => r.outcome === 'timeout').length,
    errors: results.filter((r) => r.outcome === 'error').length,
    skippedForBudget: skipped,
  }
}
