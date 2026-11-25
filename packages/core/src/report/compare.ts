import { seededRandom } from '../dataset/split.js'
import { deltaNoise, outcomeValues, type ValueRow } from './noise.js'
import { pairedBootstrapCI, recommend } from './report.js'

export interface RunRow {
  task_id: string
  outcome: string | null
  cost_usd: number | null
  duration_s: number | null
  /** process metrics (turns, tool errors, …); compared when both sides have them */
  metrics?: Record<string, number | null>
}

export interface Side {
  successRate: number
  costPerSuccess: number | null
  medianDuration: number
  runs: number
}

export interface MetricDelta {
  name: string
  /** mean over tasks of the per-task mean */
  a: number
  b: number
  /** paired per task (b − a), bootstrap CI over tasks */
  delta: { mean: number; lo: number; hi: number }
  /** 95 % half-width of the delta if the configs did not differ (rerun noise) */
  noise: number | null
}

export interface Comparison {
  tasks: number
  a: Side
  b: Side
  delta: { mean: number; lo: number; hi: number }
  /**
   * 95 % half-width of the success delta if the configs did not differ (rerun noise on these
   * tasks). A delta inside it is what running one config twice could give.
   */
  noise: number | null
  costPerSuccessDelta: number | null
  flips: { failToSuccess: number; successToFail: number }
  /** tasks whose success rate rose / fell, for the evidence of a change */
  improved: string[]
  worse: string[]
  metrics: MetricDelta[]
  recommendation: 'PROMOTE' | 'KEEP'
  /** which branch of the promote rule decided, with its numbers */
  reason: string
}

const median = (xs: number[]) => {
  const s = [...xs].sort((x, y) => x - y)
  const m = Math.floor(s.length / 2)
  return s.length === 0 ? 0 : s.length % 2 ? (s[m] ?? 0) : ((s[m - 1] ?? 0) + (s[m] ?? 0)) / 2
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0)

const side = (rows: RunRow[]): Side => {
  const succ = rows.filter((r) => r.outcome === 'success').length
  const cost = rows.reduce((s, r) => s + (r.cost_usd ?? 0), 0)
  return {
    successRate: rows.length ? succ / rows.length : 0,
    costPerSuccess: succ ? cost / succ : null,
    medianDuration: median(rows.map((r) => r.duration_s ?? 0)),
    runs: rows.length,
  }
}

const NOISE_Z = 1.96

/** one metric of the runs that have it */
const metricValues = (rows: RunRow[], name: string): ValueRow[] =>
  rows.flatMap((r) => {
    const value = r.metrics?.[name]
    return value == null ? [] : [{ task_id: r.task_id, value }]
  })

const meanByTask = (rows: ValueRow[]) => {
  const m = new Map<string, number[]>()
  for (const r of rows) m.set(r.task_id, [...(m.get(r.task_id) ?? []), r.value])
  return new Map([...m].map(([k, v]) => [k, mean(v)]))
}

/** one value series paired per task: means, bootstrap CI over tasks and rerun noise of the delta */
function pairedDelta(
  name: string,
  xa: ValueRow[],
  xb: ValueRow[],
  seed: number,
): MetricDelta | undefined {
  const ma = meanByTask(xa)
  const mb = meanByTask(xb)
  const common = [...ma.keys()].filter((t) => mb.has(t)).sort()
  if (common.length === 0) return undefined
  const va = common.map((t) => ma.get(t) ?? 0)
  const vb = common.map((t) => mb.get(t) ?? 0)
  const delta = pairedBootstrapCI(
    common.map((_, j) => (vb[j] ?? 0) - (va[j] ?? 0)),
    10_000,
    0.05,
    seededRandom(seed),
  )
  const se = deltaNoise(xa, xb, common)
  return { name, a: mean(va), b: mean(vb), delta, noise: se === null ? null : NOISE_Z * se }
}

function compareMetrics(aRows: RunRow[], bRows: RunRow[], seed: number): MetricDelta[] {
  const names = new Set(aRows.flatMap((r) => Object.keys(r.metrics ?? {})))
  return [...names].flatMap(
    (name, i) =>
      pairedDelta(name, metricValues(aRows, name), metricValues(bRows, name), seed + i + 1) ?? [],
  )
}

/** cost and duration per run from the rows themselves: the rule does not depend on `metrics` */
const fieldValues = (rows: RunRow[], field: 'cost_usd' | 'duration_s'): ValueRow[] =>
  rows.flatMap((r) => {
    const value = r[field]
    return value === null ? [] : [{ task_id: r.task_id, value }]
  })

/** Paired per task (success rate per task, b − a), bootstrap CI over tasks. */
export function compareRuns(aRows: RunRow[], bRows: RunRow[], seed = 1): Comparison {
  const rate = (rows: RunRow[]) => {
    const m = new Map<string, { s: number; n: number }>()
    for (const r of rows) {
      const e = m.get(r.task_id) ?? { s: 0, n: 0 }
      e.n++
      if (r.outcome === 'success') e.s++
      m.set(r.task_id, e)
    }
    return new Map([...m].map(([k, v]) => [k, v.s / v.n]))
  }
  const ra = rate(aRows)
  const rb = rate(bRows)
  const common = [...ra.keys()].filter((k) => rb.has(k)).sort()
  const keep = new Set(common)
  const deltas = common.map((t) => (rb.get(t) ?? 0) - (ra.get(t) ?? 0))
  const pa = aRows.filter((r) => keep.has(r.task_id))
  const pb = bRows.filter((r) => keep.has(r.task_id))
  const a = side(pa)
  const b = side(pb)
  const delta = pairedBootstrapCI(deltas, 10_000, 0.05, seededRandom(seed))
  const se = deltaNoise(outcomeValues(pa), outcomeValues(pb), common)
  const noise = se === null ? null : NOISE_Z * se
  const costPerSuccessDelta =
    a.costPerSuccess && b.costPerSuccess ? b.costPerSuccess / a.costPerSuccess - 1 : null
  const improved = common.filter((_, i) => (deltas[i] ?? 0) > 0)
  const worse = common.filter((_, i) => (deltas[i] ?? 0) < 0)
  const quantity = (field: 'cost_usd' | 'duration_s') =>
    pairedDelta(field, fieldValues(pa, field), fieldValues(pb, field), seed)
  const { verdict, reason } = recommend({
    success: { delta, noise },
    costPerSuccessDelta,
    cost: quantity('cost_usd'),
    duration: quantity('duration_s'),
  })
  return {
    tasks: common.length,
    a,
    b,
    delta,
    noise,
    costPerSuccessDelta,
    flips: { failToSuccess: improved.length, successToFail: worse.length },
    improved,
    worse,
    metrics: compareMetrics(pa, pb, seed),
    recommendation: verdict,
    reason,
  }
}
