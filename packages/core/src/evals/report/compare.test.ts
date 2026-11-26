import { expect, it } from 'vitest'
import { compareRuns, type RunRow } from './compare.js'

const rows = (spec: Record<string, string[]>): RunRow[] =>
  Object.entries(spec).flatMap(([task_id, outs]) =>
    outs.map((outcome) => ({ task_id, outcome, cost_usd: 0.1, duration_s: 10 })),
  )

it('pairs per task and recommends PROMOTE when the gain holds', () => {
  const a = rows({
    t1: ['fail', 'fail'],
    t2: ['fail', 'fail'],
    t3: ['success', 'success'],
    t4: ['fail', 'fail'],
  })
  const b = rows({
    t1: ['success', 'success'],
    t2: ['success', 'success'],
    t3: ['success', 'success'],
    t4: ['success', 'success'],
    t5: ['fail'],
  })
  const c = compareRuns(a, b)
  expect(c.tasks).toBe(4)
  expect(c.delta.mean).toBeCloseTo(0.75)
  expect(c.flips).toEqual({ failToSuccess: 3, successToFail: 0 })
  expect(c.recommendation).toBe('PROMOTE')
})

it('KEEP when no difference', () => {
  const a = rows({ t1: ['success', 'fail'], t2: ['fail', 'fail'] })
  expect(compareRuns(a, a).recommendation).toBe('KEEP')
})

it('reports rerun noise next to the delta', () => {
  const a = rows({ t1: ['success', 'fail'], t2: ['fail', 'fail'] })
  const b = rows({ t1: ['success', 'success'], t2: ['fail', 'fail'] })
  const c = compareRuns(a, b)
  expect(c.delta.mean).toBeCloseTo(0.25)
  // t1 pooled: 3 of 4 → variance 0.25, over 2 runs on each side; t2 never varies
  expect(c.noise).toBeCloseTo((1.96 * Math.sqrt(0.25)) / 2)
  expect(compareRuns(a, a).noise).toBeCloseTo((1.96 * Math.sqrt(1 / 3)) / 2)
})

it('compares process metrics paired per task', () => {
  const run = (task_id: string, turns: number | null): RunRow => ({
    task_id,
    outcome: 'fail',
    cost_usd: 0,
    duration_s: 0,
    metrics: { turns },
  })
  const a = [run('t1', 10), run('t1', 20), run('t2', 8), run('t2', 8), run('only-a', 99)]
  const b = [run('t1', 5), run('t2', 8), run('t2', null)]
  const [m] = compareRuns(a, b).metrics
  expect(m).toMatchObject({ name: 'turns', a: 11.5, b: 6.5 })
  expect(m?.delta.mean).toBeCloseTo(-5)
  // t1 pooled: 10, 20, 5 → variance 175/3, over 2 runs in a and 1 in b; t2 never varies
  expect(m?.noise).toBeCloseTo((1.96 * Math.sqrt(175 / 3 / 2 + 175 / 3)) / 2)
})

it('KEEP when the gain is inside rerun noise, even if the CI over tasks excludes 0', () => {
  // every task improves a little, but each one flips between its own repeats as well
  const flaky = (outs: string[]) =>
    rows(Object.fromEntries(['t1', 't2', 't3'].map((t) => [t, outs])))
  const c = compareRuns(flaky(['fail', 'fail', 'success']), flaky(['fail', 'success', 'success']))
  expect(c.delta.lo).toBeGreaterThan(0)
  expect(Math.abs(c.delta.mean)).toBeLessThan(c.noise ?? 0)
  expect(c.recommendation).toBe('KEEP')
})

it('PROMOTE a cheaper config only when the cost drop itself holds', () => {
  const at = (cost: number[]) =>
    ['t1', 't2', 't3', 't4'].flatMap((task_id) =>
      cost.map((cost_usd) => ({ task_id, outcome: 'success', cost_usd, duration_s: 1 })),
    )
  expect(compareRuns(at([1, 1.02]), at([0.7, 0.72])).recommendation).toBe('PROMOTE')
  // same −30 % on average, but run cost swings more than that between repeats
  const noisy = compareRuns(at([0.2, 1.8]), at([0.1, 1.3]))
  expect(noisy.costPerSuccessDelta).toBeLessThan(-0.15)
  expect(noisy.recommendation).toBe('KEEP')
})

const timed = (outcomes: string[], seconds: number[]) =>
  ['t1', 't2', 't3', 't4'].flatMap((task_id) =>
    seconds.map((duration_s, i) => ({
      task_id,
      outcome: outcomes[i] ?? 'fail',
      cost_usd: 0.1,
      duration_s,
    })),
  )

it('PROMOTE a faster config at no loss of success, only when the time drop holds', () => {
  const base = timed(['success', 'fail'], [100, 104])
  const fast = compareRuns(base, timed(['success', 'fail'], [40, 42]))
  expect(fast.recommendation).toBe('PROMOTE')
  expect(fast.reason).toMatch(
    /^faster at no detectable loss of success: duration per run −60 %, across tasks and beyond rerun noise; success \+0\.0 pp \(rerun noise ±[\d.]+ pp\)$/,
  )
  // same average drop, but durations swing more than that between repeats
  const noisy = compareRuns(
    timed(['success', 'fail'], [20, 184]),
    timed(['success', 'fail'], [10, 72]),
  )
  expect(noisy.recommendation).toBe('KEEP')
  // faster but less successful: never promoted on time
  const worse = compareRuns(base, timed(['fail', 'fail'], [40, 42]))
  expect(worse.recommendation).toBe('KEEP')
  // (four tasks that flip between repeats: far too noisy to call −50 pp anything but a loss)
  expect(worse.reason).toMatch(
    /^success −50\.0 pp \(rerun noise ±[\d.]+ pp.*\) cannot be told from a loss/,
  )
  // under 15 %: not worth a promotion
  expect(compareRuns(base, timed(['success', 'fail'], [90, 94])).recommendation).toBe('KEEP')
})

it('lists the tasks that improved and got worse, and says why it keeps', () => {
  const a = rows({ t1: ['fail', 'fail'], t2: ['success', 'success'], t3: ['fail', 'fail'] })
  const b = rows({ t1: ['success', 'fail'], t2: ['success', 'fail'], t3: ['fail', 'fail'] })
  const c = compareRuns(a, b)
  expect(c.improved).toEqual(['t1'])
  expect(c.worse).toEqual(['t2'])
  expect(c.recommendation).toBe('KEEP')
  expect(c.reason).toMatch(
    /^success \+0\.0 pp \(rerun noise ±[\d.]+ pp; a loss of up to [\d.]+ pp cannot be ruled out\) does not hold as a gain, and no cost/,
  )
})

// 40 tasks × 3 repeats: 30 always succeed, 10 flip (2 of 3). Rerun noise of a comparison: about ±6 pp.
const sample = (lostRuns: number, lostTasks: number, seconds: number[]): RunRow[] =>
  Array.from({ length: 40 }, (_, t) => t).flatMap((t) =>
    seconds.map((duration_s, i) => {
      const flaky = t >= 30
      const base = flaky ? i !== 1 : true
      // candidate variants: one more failed run on the first flaky task, or whole stable tasks lost
      const lost = (flaky && t === 30 && i === 2 && lostRuns > 0) || t < lostTasks
      return {
        task_id: `t${t}`,
        outcome: base && !lost ? 'success' : 'fail',
        cost_usd: 0.1,
        duration_s,
      }
    }),
  )

it('one run less inside a narrow noise band is no detectable loss; the reason says what it could hide', () => {
  const base = sample(0, 0, [100, 104, 102])
  const c = compareRuns(base, sample(1, 0, [40, 42, 41]))
  expect(c.delta.mean).toBeCloseTo(-1 / 120)
  expect(c.noise).toBeGreaterThan(0.04)
  expect(c.noise).toBeLessThan(0.1)
  expect(c.recommendation).toBe('PROMOTE')
  expect(c.reason).toMatch(
    /^faster at no detectable loss of success: duration per run −60 %, across tasks and beyond rerun noise; success −0\.8 pp \(rerun noise ±[\d.]+ pp; a loss of up to [\d.]+ pp cannot be ruled out\)$/,
  )
  // four stable tasks lost: −10 pp is beyond the band, however much faster
  const worse = compareRuns(base, sample(0, 4, [40, 42, 41]))
  expect(worse.delta.mean).toBeCloseTo(-0.1)
  expect(worse.recommendation).toBe('KEEP')
  expect(worse.reason).toMatch(/is a loss beyond rerun noise; cost or time count only/)
})
