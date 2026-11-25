import type { TestCase } from './vitest.js'

interface GoEvent {
  Action?: string
  Package?: string
  Test?: string
  Output?: string
}

/**
 * Parse `go test -json`; ids are '<package> > <Test/subtest>'. Each package also yields a
 * '<package> > (package)' case, so a package that no longer compiles (no test events at all)
 * shows up as a failure instead of silently dropping its tests.
 */
export function parseGoTestJson(output: string): TestCase[] {
  const cases: TestCase[] = []
  const out = new Map<string, string>()
  for (const line of output.split('\n')) {
    if (!line.startsWith('{')) continue
    let ev: GoEvent
    try {
      ev = JSON.parse(line) as GoEvent
    } catch {
      continue
    }
    if (!ev.Package) continue
    const id = `${ev.Package} > ${ev.Test ?? '(package)'}`
    if (ev.Action === 'output') {
      const prev = out.get(id) ?? ''
      if (prev.length < 2000) out.set(id, prev + (ev.Output ?? ''))
    } else if (ev.Action === 'pass') {
      cases.push({ id, passed: true })
    } else if (ev.Action === 'fail') {
      cases.push({ id, passed: false, message: out.get(id)?.slice(0, 2000) })
    }
  }
  return cases
}
