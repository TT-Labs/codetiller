import { expect, it } from 'vitest'
import { leakWarnings } from './improve.js'

it('flags identifiers unique to one task reference fix', () => {
  const refs = [
    { task_id: 'a', reference_diff: '+  const cacheableStatusCodes = x', issue: 'etag on errors' },
    { task_id: 'b', reference_diff: '+  return parseBody(req)', issue: 'body' },
    { task_id: 'c', reference_diff: '+  return parseBody(other)', issue: 'body2' },
  ]
  const w = leakWarnings('- Use `cacheableStatusCodes` and `parseBody` carefully', refs)
  expect(w).toEqual(['`cacheableStatusCodes` appears only in the reference fix of a'])
})
