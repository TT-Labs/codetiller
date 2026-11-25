import { expect, it } from 'vitest'
import {
  deltaNoise,
  detectableDelta,
  noiseSummary,
  outcomeValues,
  repeatsFor,
  taskNoise,
} from './noise.js'

const rows = (spec: Record<string, string>) =>
  outcomeValues(
    Object.entries(spec).flatMap(([task_id, outs]) =>
      [...outs].map((o) => ({ task_id, outcome: o === 's' ? 'success' : 'fail' })),
    ),
  )

it('estimates per-task variance without bias and skips single runs', () => {
  const n = taskNoise(rows({ stable: 'sss', flaky: 'sf', mostly: 'ssf', once: 's' }))
  expect(n.get('stable')?.variance).toBe(0)
  expect(n.get('flaky')?.variance).toBe(0.5)
  expect(n.get('mostly')?.variance).toBeCloseTo(1 / 3)
  expect(n.get('once')?.variance).toBeNull()
})

it('summarises a benchmark: only repeated tasks, unstable count, standard error', () => {
  const s = noiseSummary(rows({ t1: 'ss', t2: 'sf', t3: 'ff', t4: 'fs', single: 's' }))
  expect(s).toMatchObject({ tasks: 4, runs: 8, mean: 0.5, unstable: 2, variance: 0.25 })
  // two flaky tasks, variance 0.5 over 2 runs each: sqrt(0.25 + 0.25) / 4
  expect(s.se).toBeCloseTo(Math.sqrt(0.5) / 4)
})

it('delta noise pools both sides per task: zero only when every run of a task agrees', () => {
  const a = rows({ t1: 'ss', t2: 'ff' })
  expect(deltaNoise(a, a, ['t1', 't2'])).toBe(0)
  // one run per side that disagrees (McNemar): pooled variance 0.5, on each side once
  expect(deltaNoise(rows({ t1: 's' }), rows({ t1: 'f' }), ['t1'])).toBeCloseTo(1)
  // a full flip between configs counts as noise under "no difference": 2 of 4 → variance 1/3
  expect(deltaNoise(rows({ t1: 'ss' }), rows({ t1: 'ff' }), ['t1'])).toBeCloseTo(
    Math.sqrt(1 / 3 / 2 + 1 / 3 / 2),
  )
  expect(deltaNoise(a, rows({ t1: 's' }), ['t1', 't2'])).toBeNull()
  expect(deltaNoise(a, a, [])).toBeNull()
})

it('works for any numeric metric, not only success', () => {
  const turns = [
    { task_id: 't1', value: 10 },
    { task_id: 't1', value: 14 },
    { task_id: 't2', value: 7 },
    { task_id: 't2', value: 7 },
  ]
  expect(taskNoise(turns).get('t1')).toEqual({ runs: 2, mean: 12, variance: 8 })
  // t1 pooled over both sides: 10, 14, 10, 14 → variance 16/3, over 2 runs on each side
  expect(deltaNoise(turns, turns, ['t1', 't2'])).toBeCloseTo(Math.sqrt(16 / 3) / 2)
})

it('detectable delta shrinks with repeats and inverts to repeats needed', () => {
  const d2 = detectableDelta(0.05, 47, 2)
  const d8 = detectableDelta(0.05, 47, 8)
  expect(d8).toBeCloseTo(d2 / 2)
  expect(repeatsFor(0.05, 47, d2)).toBe(2)
  expect(repeatsFor(0.05, 47, d2 / 2)).toBe(8)
})
