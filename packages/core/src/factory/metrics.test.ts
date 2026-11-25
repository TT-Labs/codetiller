import { expect, it } from 'vitest'
import { factoryMetrics, type TaskFacts } from './metrics.js'
import type { WorkEvent, WorkItem, WorkRun } from './model.js'

let seq = 0
const ev = (kind: WorkEvent['kind'], text: string | null = null): WorkEvent => ({
  id: ++seq,
  item_id: 'T',
  at: '2026-11-15T00:00:00Z',
  // messages are the human's; everything else here is the factory's record
  actor: kind === 'message' ? 'human' : 'factory',
  kind,
  text,
  run_id: null,
})
const run = (cost: number): WorkRun =>
  ({ id: `r${++seq}`, cost_usd: cost, duration_s: 10 }) as WorkRun
const task = (
  over: Partial<TaskFacts> & { state?: WorkItem['state']; repo?: string },
): TaskFacts => ({
  item: {
    id: `T-${++seq}`,
    repo: over.repo ?? 'o/r',
    config: 'c0',
    state: over.state ?? 'PR_OPEN',
  } as WorkItem,
  runs: [],
  events: [],
  ...over,
})

it('measures delivery, first pass, interventions and cost per delivered task', () => {
  const tasks = [
    // delivered by one run, no intervention: first pass
    task({
      runs: [run(0.1)],
      events: [
        ev('message', 'extra instructions'),
        ev('run_started'),
        ev('verification', 'verification passed: 3 tests'),
      ],
      pr: { number: 1, url: 'u' },
      preflight: {
        verdict: 'pass',
        report: null,
        run_id: null,
        cost_usd: 0.05,
        turns: 3,
        duration_s: 9,
      },
    }),
    // delivered after review feedback: two runs, one intervention; later merged
    task({
      state: 'COMPLETED',
      runs: [run(0.2), run(0.1)],
      events: [
        ev('run_started'),
        ev('verification', 'verification failed: 1 of 3 tests newly failing'),
        ev('message', 'fix the test'),
        ev('run_started'),
        ev('verification', 'verification passed: 3 tests'),
      ],
      pr: { number: 2, url: 'u' },
    }),
    // stopped by the preflight, never ran
    task({
      state: 'WAITING_FOR_HUMAN',
      repo: 'o/other',
      events: [ev('preflight', 'too large')],
      preflight: {
        verdict: 'too_large',
        report: null,
        run_id: null,
        cost_usd: 0.1,
        turns: 3,
        duration_s: 30,
      },
    }),
    // ran, verification failed, nothing delivered: its cost still counts
    task({
      state: 'REVIEW',
      runs: [run(0.3)],
      events: [ev('run_started'), ev('verification', 'verification error: no report')],
    }),
    // never started
    task({ state: 'IMPORTED' }),
  ]
  const m = factoryMetrics(tasks)
  expect(m.total).toMatchObject({
    tasks: 5,
    ran: 3,
    delivered: 2,
    accepted: 1,
    firstPass: 1,
    interventions: 1,
    runs: 4,
    firstPassRate: 0.5,
  })
  expect(m.total.cost_usd).toBeCloseTo(0.85)
  expect(m.total.costPerDelivered).toBeCloseTo(0.425)
  expect(m.total.costPerAccepted).toBeCloseTo(0.85)
  expect(m.total.interventionsPerTask).toBeCloseTo(1 / 3)
  expect(Object.fromEntries(m.funnel.map((f) => [f.stage, f.tasks]))).toEqual({
    Created: 5,
    'Started (assessed or run)': 4,
    'Stopped by preflight': 1,
    'Agent ran': 3,
    'Delivered (verified)': 2,
    'Pull request opened': 2,
    Accepted: 1,
  })
  // two PRs: one still open, one merged after the human asked for a fix (asked before the PR
  // opened does not count: no `pr` event precedes that message here, so it is "as is")
  expect(m.review).toMatchObject({ prs: 2, pending: 1, rejected: 0 })
  expect(m.preflight).toEqual({ pass: 1, too_large: 1 })
  expect(m.verification).toEqual({ pass: 2, fail: 1, error: 1 })
  expect(m.byRepo.map((g) => [g.key, g.tasks, g.delivered])).toEqual([
    ['o/other', 1, 0],
    ['o/r', 4, 2],
  ])
})

it('classifies decided pull requests by what the human had to do', () => {
  const pr = { number: 1, url: 'u' }
  const opened = () => [
    ev('run_started'),
    ev('verification', 'verification passed: 3 tests'),
    ev('pr', 'draft PR #1'),
  ]
  const m = factoryMetrics([
    task({ state: 'COMPLETED', runs: [run(0.1)], events: opened(), pr }),
    task({
      state: 'COMPLETED',
      runs: [run(0.1)],
      events: [ev('message', 'instructions'), ...opened()],
      pr,
    }),
    task({
      state: 'COMPLETED',
      runs: [run(0.1), run(0.1)],
      events: [...opened(), ev('message', 'rename it'), ev('run_started')],
      pr,
    }),
    task({ state: 'CANCELLED', runs: [run(0.1)], events: opened(), pr }),
    task({ state: 'PR_OPEN', runs: [run(0.1)], events: opened(), pr }),
    task({ state: 'COMPLETED', runs: [run(0.1)], events: [ev('run_started')] }),
  ])
  expect(m.review).toEqual({
    prs: 5,
    acceptedAsIs: 2,
    acceptedAfterChanges: 1,
    rejected: 1,
    pending: 1,
    asIsRate: 0.5,
  })
})

it('ratios are null without a denominator', () => {
  const m = factoryMetrics([task({ state: 'IMPORTED' })])
  expect(m.total).toMatchObject({
    interventionsPerTask: null,
    firstPassRate: null,
    costPerDelivered: null,
    costPerAccepted: null,
  })
})

it('a message the factory itself sent to the agent is not a human intervention', () => {
  const conflict: WorkEvent = { ...ev('message', 'these files have conflicts'), actor: 'factory' }
  const m = factoryMetrics(
    [
      task({
        runs: [run(0.1), run(0.1)],
        pr: { number: 1, url: '' },
        state: 'COMPLETED',
        events: [ev('run_started'), ev('pr', 'draft PR #1'), conflict, ev('run_started')],
      }),
    ],
    3,
  )
  expect(m.total.interventions).toBe(0)
  expect(m.review).toMatchObject({ acceptedAsIs: 1, acceptedAfterChanges: 0 })
  // experiments are counted, and are in no figure
  expect(m.experiments).toBe(3)
  expect(m.total.tasks).toBe(1)
})
