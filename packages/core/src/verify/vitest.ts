import { relative } from 'node:path'

export interface TestCase {
  id: string // '<file> > <describe…> > <title>'
  passed: boolean
  message?: string // first failure message (failed tests only)
}

interface VitestJson {
  testResults: {
    name: string
    status?: string
    message?: string
    assertionResults: {
      ancestorTitles: string[]
      title: string
      status: string
      failureMessages?: string[]
    }[]
  }[]
}

/**
 * Parse vitest `--reporter=json`; ids relative to repo root so they match task YAML. A file that
 * failed without any failing test (import/syntax error) yields a failing '<file> > (file)' case,
 * otherwise its tests would just vanish from the result.
 */
export function parseVitestJson(json: string, root: string): TestCase[] {
  const r = JSON.parse(json) as VitestJson
  return r.testResults.flatMap((f) => {
    const file = f.name.startsWith('/') ? relative(root, f.name) : f.name
    const cases: TestCase[] = f.assertionResults
      .filter((a) => a.status !== 'skipped' && a.status !== 'pending' && a.status !== 'todo')
      .map((a) => ({
        id: [file, ...a.ancestorTitles, a.title].join(' > '),
        passed: a.status === 'passed',
        ...(a.status === 'passed' ? {} : { message: a.failureMessages?.[0]?.slice(0, 2000) }),
      }))
    if (f.status === 'failed' && cases.every((c) => c.passed))
      cases.push({ id: `${file} > (file)`, passed: false, message: f.message?.slice(0, 2000) })
    return cases
  })
}
