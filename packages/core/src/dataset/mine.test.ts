import { expect, it } from 'vitest'
import { isTestFile } from './mine.js'

it('detects test files', () => {
  expect(isTestFile('src/utils/cookie.test.ts')).toBe(true)
  expect(isTestFile('src/jsx/index.test.tsx')).toBe(true)
  expect(isTestFile('src/helper/testing/index.ts')).toBe(false)
})
