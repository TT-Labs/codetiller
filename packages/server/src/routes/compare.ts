import {
  type BenchmarkRecord,
  compareRuns,
  loadLabels,
  loadRunRows,
  type RunRecord,
  renderEvidence,
} from '@codetiller/core'
import { Hono } from 'hono'
import { datasetDir, type ServerContext, splitIds } from '../context.js'

export interface TaskCell {
  successes: number
  runs: number
  cost_usd: number
  run_ids: string[]
}

const byTask = (runs: RunRecord[]) => {
  const m = new Map<string, TaskCell>()
  for (const r of runs) {
    const e = m.get(r.task_id) ?? { successes: 0, runs: 0, cost_usd: 0, run_ids: [] }
    e.runs++
    if (r.outcome === 'success') e.successes++
    e.cost_usd += r.cost_usd ?? 0
    e.run_ids.push(r.id)
    m.set(r.task_id, e)
  }
  return m
}

export const compareRoutes = (ctx: ServerContext) =>
  new Hono().get('/', async (c) => {
    const { a, b, split = 'all' } = c.req.query()
    const A = a ? ctx.store.getBenchmark(a) : undefined
    const B = b ? ctx.store.getBenchmark(b) : undefined
    if (!A || !B) return c.json({ error: 'pass ?a=<benchmark id>&b=<benchmark id>' }, 400)
    if (A.dataset !== B.dataset) return c.json({ error: 'benchmarks use different datasets' }, 400)
    const ids = await splitIds(ctx, A.dataset, split)
    const runs = (id: string) => ctx.store.runsOf(id).filter((r) => !ids || ids.has(r.task_id))
    const ra = runs(A.id)
    const rb = runs(B.id)
    const [rowsA, rowsB] = await Promise.all([
      loadRunRows(ctx.store, ra),
      loadRunRows(ctx.store, rb),
    ])
    const { underspecified } = await loadLabels(datasetDir(ctx, A.dataset))
    const ta = byTask(ra)
    const tb = byTask(rb)
    const tasks = [...ta.keys()]
      .filter((t) => tb.has(t))
      .sort()
      .map((task_id) => ({
        task_id,
        a: ta.get(task_id) as TaskCell,
        b: tb.get(task_id) as TaskCell,
        /** why the hidden tests cannot be met from the issue (datasets/<name>/labels.yaml) */
        underspecified: underspecified[task_id] ?? null,
      }))
    // same comparison without the labelled tasks; null when none of the paired tasks is labelled
    const solvable = (r: { task_id: string }) => !(r.task_id in underspecified)
    const comparison = compareRuns(rowsA, rowsB)
    const rest = tasks.some((t) => t.underspecified)
      ? compareRuns(rowsA.filter(solvable), rowsB.filter(solvable))
      : null
    const side = (bm: BenchmarkRecord) => ({
      id: bm.id,
      config: bm.config_name,
      model: bm.model,
      skills: bm.skills,
    })
    return c.json({
      a: A,
      b: B,
      split,
      comparison,
      solvable: rest,
      /** markdown for the PR of a skill / config change */
      evidence: renderEvidence({
        dataset: A.dataset,
        split,
        a: side(A),
        b: side(B),
        comparison,
        solvable: rest,
      }),
      tasks,
    })
  })
