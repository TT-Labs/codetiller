import { expect, it } from 'vitest'
import { scoreRun } from './score.js'

it('success when all checks pass', () => {
  const r = scoreRun([
    { name: 'build', passed: true },
    { name: 'fail_to_pass', passed: true, total: 2, failed: 0 },
    { name: 'pass_to_pass', passed: true, total: 10, failed: 0 },
  ])
  expect(r).toEqual({ outcome: 'success', score: 1 })
})

it('partial F2P is fail with partial score', () => {
  const r = scoreRun([
    { name: 'fail_to_pass', passed: false, total: 2, failed: 1 },
    { name: 'pass_to_pass', passed: true, total: 10, failed: 0 },
  ])
  expect(r.outcome).toBe('fail')
  expect(r.score).toBeCloseTo(0.75)
})
