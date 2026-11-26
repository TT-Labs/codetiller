import { expect, it } from 'vitest'
import { compareRuns, type RunRow } from './compare.js'
import { gateVerdict, renderEvidence } from './evidence.js'

const runs = (outcomes: string[], seconds: number[]): RunRow[] =>
  ['t1', 't2', 't3', 't4'].flatMap((task_id, t) =>
    seconds.map((duration_s, i) => ({
      task_id,
      // t1 and t2 always succeed, t3 and t4 follow `outcomes`
      outcome: t < 2 ? 'success' : (outcomes[i] ?? 'fail'),
      cost_usd: 0.1,
      duration_s,
      metrics: { duration_s, turns: 8 },
    })),
  )

it('renders the evidence a skill change ships with', () => {
  const a = runs(['fail', 'fail'], [100, 104])
  const b = runs(['fail', 'fail'], [40, 42])
  const text = renderEvidence({
    dataset: 'zod',
    split: 'all',
    a: { id: 'base-1', config: 'c1', model: 'm', skills: ['onboarding@1'] },
    b: { id: 'cand-1', config: 'c1a', model: 'm', skills: ['onboarding@1', 'ops@1'] },
    comparison: compareRuns(a, b),
    solvable: compareRuns(a.slice(0, 6), b.slice(0, 6)),
  })
  expect(text.split('\n\n').slice(0, 3)).toEqual([
    '## Eval evidence',
    '**PROMOTE** — faster at no detectable loss of success: duration per run −60 %, across tasks and beyond rerun noise; success +0.0 pp (rerun noise ±0.0 pp).',
    'Dataset `zod` (split all) · 4 paired tasks · 8 baseline runs, 8 candidate runs.',
  ])
  expect(text).toContain(
    '| success | 50.0 % (4/8) | 50.0 % (4/8) | +0.0 pp | +0.0 … +0.0 | ±0.0 | no |',
  )
  expect(text).toContain('| success, 3 tasks solvable from the issue | 66.7 % (4/6) |')
  expect(text).toMatch(
    /\| duration per run \(s\) \| 102 \| 41\.0 \| −61\.0 \| .* \| \*\*yes\*\* \|/,
  )
  expect(text).toContain('| turns | 8.000 | 8.000 | +0.000 | +0.000 … +0.000 | ±0.000 | no |')
  expect(text).toContain('Tasks improved: none\nTasks worse: none')
  expect(text).toContain('Candidate: `cand-1` · config `c1a` · m · skills: `onboarding@1`, `ops@1`')
})

it('holds a candidate against the reference too: promotions must not add up a loss', () => {
  const stable = (ok: number, seconds: number[]): RunRow[] =>
    Array.from({ length: 10 }, (_, t) => t).flatMap((t) =>
      seconds.map((duration_s) => ({
        task_id: `t${t}`,
        outcome: t < ok ? 'success' : 'fail',
        cost_usd: 0.1,
        duration_s,
        metrics: { duration_s },
      })),
    )
  const reference = stable(8, [100, 104])
  const baseline = stable(6, [100, 104]) // an earlier promotion already cost two tasks
  const candidate = stable(6, [40, 42])
  const s = { id: 'x', config: 'c', model: 'm', skills: [] }
  const comparison = compareRuns(baseline, candidate)
  // against its baseline alone the candidate is promoted on time
  expect(gateVerdict({ comparison }).verdict).toBe('PROMOTE')
  const held = { comparison, reference: { side: s, comparison: compareRuns(reference, candidate) } }
  expect(gateVerdict(held)).toMatchObject({ verdict: 'KEEP' })
  // (the two tasks that differ make the comparison noisy: −20 pp is then "cannot be told from a loss")
  expect(gateVerdict(held).reason).toMatch(
    /^against the reference: success −20\.0 pp \(rerun noise ±[\d.]+ pp.*\) cannot be told from a loss, although against the baseline: faster/,
  )
  const text = renderEvidence({ dataset: 'd', split: 'all', a: s, b: s, ...held })
  expect(text).toContain('**KEEP** — against the reference')
  expect(text).toContain(
    '| success, reference → candidate | 80.0 % (16/20) | 60.0 % (12/20) | −20.0 pp |',
  )
  // a candidate level with the reference passes both
  const level = { comparison, reference: { side: s, comparison: compareRuns(baseline, candidate) } }
  expect(gateVerdict(level).verdict).toBe('PROMOTE')
})
