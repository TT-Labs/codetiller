import { expect, it } from 'vitest'
import { splitTasks } from './split.js'

it('splits deterministically and disjointly', () => {
  const ids = Array.from({ length: 20 }, (_, i) => `t${i}`)
  const a = splitTasks(ids, 0.4, 1)
  expect(a).toEqual(splitTasks([...ids].reverse(), 0.4, 1))
  expect(a.holdout).toHaveLength(8)
  expect(a.train).toHaveLength(12)
  expect(new Set([...a.train, ...a.holdout]).size).toBe(20)
})
