export interface ValueRow {
  task_id: string
  value: number
}

/** success as 1/0, so the noise of a success rate and of any other metric share one estimator */
export const outcomeValues = (rows: { task_id: string; outcome: string | null }[]): ValueRow[] =>
  rows.map((r) => ({ task_id: r.task_id, value: r.outcome === 'success' ? 1 : 0 }))

export interface TaskNoise {
  runs: number
  mean: number
  /** unbiased variance of a single run of this task; null with a single run */
  variance: number | null
}

/**
 * Rerun noise: how much a result moves when the same config runs the same task again.
 * Sample variance over the repeats; for success/fail that is s(k−s)/(k(k−1)), the unbiased
 * estimate of p(1−p).
 */
export function taskNoise(rows: ValueRow[]): Map<string, TaskNoise> {
  const values = new Map<string, number[]>()
  for (const r of rows) values.set(r.task_id, [...(values.get(r.task_id) ?? []), r.value])
  return new Map(
    [...values].map(([task, xs]) => {
      const mean = xs.reduce((s, x) => s + x, 0) / xs.length
      const variance =
        xs.length < 2 ? null : xs.reduce((s, x) => s + (x - mean) ** 2, 0) / (xs.length - 1)
      return [task, { runs: xs.length, mean, variance }]
    }),
  )
}

/**
 * Standard error of a paired delta (b − a) over `tasks` if the two configs did not differ: per task
 * the runs of both sides are pooled into one variance estimate, as a rerun of one config would
 * produce them. The task set is held fixed, so a delta beyond this is more than a rerun explains on
 * these tasks; whether it generalises to other tasks is the bootstrap CI over tasks. Pooling makes
 * a real difference look like noise, which errs on the cautious side. null without paired tasks.
 */
export function deltaNoise(a: ValueRow[], b: ValueRow[], tasks: string[]): number | null {
  if (tasks.length === 0) return null
  const pooled = taskNoise([...a, ...b])
  const runs = (rows: ValueRow[]) => {
    const m = new Map<string, number>()
    for (const r of rows) m.set(r.task_id, (m.get(r.task_id) ?? 0) + 1)
    return m
  }
  const ka = runs(a)
  const kb = runs(b)
  let sum = 0
  for (const t of tasks) {
    const x = ka.get(t)
    const y = kb.get(t)
    const v = pooled.get(t)?.variance
    if (!x || !y || v == null) return null
    sum += v / x + v / y
  }
  return Math.sqrt(sum) / tasks.length
}

export interface NoiseSummary {
  tasks: number
  runs: number
  mean: number
  /** tasks whose repeats differ */
  unstable: number
  /** mean per-task variance of a single run (0 = fully deterministic, 0.25 = coin flips) */
  variance: number
  /** standard error of the mean from rerun noise */
  se: number
}

/** Noise of one benchmark; only tasks with at least two runs count. */
export function noiseSummary(rows: ValueRow[]): NoiseSummary {
  const tasks = [...taskNoise(rows).values()].filter((t) => t.variance !== null)
  const n = tasks.length
  const runs = tasks.reduce((s, t) => s + t.runs, 0)
  const sum = (f: (t: TaskNoise) => number) => tasks.reduce((s, t) => s + f(t), 0)
  return {
    tasks: n,
    runs,
    mean: n ? sum((t) => t.mean) / n : 0,
    unstable: tasks.filter((t) => (t.variance ?? 0) > 0).length,
    variance: n ? sum((t) => t.variance ?? 0) / n : 0,
    se: n ? Math.sqrt(sum((t) => (t.variance ?? 0) / t.runs)) / n : 0,
  }
}

// two-sided 5 % + 80 % power: z(0.975) + z(0.80)
const POWER_Z = 1.96 + 0.8416

/**
 * Smallest true delta a paired comparison detects (5 % two-sided, 80 % power) when both
 * configs run `tasks` tasks `repeats` times and a single run has mean per-task `variance`.
 */
export function detectableDelta(variance: number, tasks: number, repeats: number): number {
  return POWER_Z * Math.sqrt((2 * variance) / (repeats * tasks))
}

/** Repeats per config needed to detect `delta`; inverse of {@link detectableDelta}. */
export function repeatsFor(variance: number, tasks: number, delta: number): number {
  // epsilon: an exact integer must not round up on float error
  return Math.ceil((2 * variance * POWER_Z ** 2) / (tasks * delta ** 2) - 1e-9)
}
