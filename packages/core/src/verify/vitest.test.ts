import { expect, it } from 'vitest'
import { parseVitestJson } from './vitest.js'

it('builds ids relative to container root', () => {
  const json = JSON.stringify({
    testResults: [
      {
        name: '/workspace/src/utils/cookie.test.ts',
        assertionResults: [
          { ancestorTitles: ['Set cookie'], title: 'a', status: 'passed' },
          { ancestorTitles: ['Set cookie'], title: 'b', status: 'failed' },
          { ancestorTitles: [], title: 'c', status: 'skipped' },
        ],
      },
    ],
  })
  expect(parseVitestJson(json, '/workspace')).toEqual([
    { id: 'src/utils/cookie.test.ts > Set cookie > a', passed: true },
    { id: 'src/utils/cookie.test.ts > Set cookie > b', passed: false },
  ])
})

it('a file that fails to load is a failing case', () => {
  const json = JSON.stringify({
    testResults: [
      {
        name: '/workspace/a.test.ts',
        status: 'failed',
        message: 'SyntaxError',
        assertionResults: [],
      },
      {
        name: '/workspace/b.test.ts',
        status: 'failed',
        assertionResults: [{ ancestorTitles: [], title: 'x', status: 'failed' }],
      },
    ],
  })
  expect(parseVitestJson(json, '/workspace')).toEqual([
    { id: 'a.test.ts > (file)', passed: false, message: 'SyntaxError' },
    { id: 'b.test.ts > x', passed: false },
  ])
})
