import type { TestCase } from './vitest.js'

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }

const decode = (s: string) =>
  s.replace(/&(#x?[0-9a-fA-F]+|\w+);/g, (whole, ref: string) => {
    if (ref.startsWith('#x')) return String.fromCodePoint(Number.parseInt(ref.slice(2), 16))
    if (ref.startsWith('#')) return String.fromCodePoint(Number(ref.slice(1)))
    return ENTITIES[ref] ?? whole
  })

/** attributes of one opening tag, e.g. `classname="a.b" name="t"` */
function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of tag.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g))
    out[m[1] as string] = decode(m[2] ?? m[3] ?? '')
  return out
}

/**
 * Parse a JUnit XML report (pytest `--junitxml`, `node --test --test-reporter=junit`, gotestsum,
 * most other runners). Ids are '<classname> > <name>', the shape the vitest and go parsers give.
 * Skipped tests are left out, as there: a test that did not run has no result.
 */
export function parseJUnitXml(xml: string): TestCase[] {
  if (!/<testsuites?[\s>]/.test(xml)) throw new Error('not a JUnit XML report')
  const cases: TestCase[] = []
  // the suite a testcase sits in names it when it has no classname of its own
  let suite = ''
  const tags = /<testsuite\b([^>]*)>|<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g
  for (const m of xml.matchAll(tags)) {
    if (m[1] !== undefined) {
      suite = attrs(m[1]).name ?? ''
      continue
    }
    const a = attrs(m[2] ?? '')
    const body = m[4] ?? ''
    if (/<skipped[\s/>]/.test(body)) continue
    const failure = /<(failure|error)\b([^>]*?)(\/>|>([\s\S]*?)<\/\1>)/.exec(body)
    const id = [a.classname || suite, a.name ?? ''].filter(Boolean).join(' > ')
    if (!id) continue
    const text = failure
      ? [
          attrs(failure[2] ?? '').message,
          decode((failure[4] ?? '').replace(/<!\[CDATA\[|\]\]>/g, '')),
        ]
          .filter(Boolean)
          .join('\n')
          .trim()
      : ''
    cases.push({ id, passed: !failure, ...(failure ? { message: text.slice(0, 2000) } : {}) })
  }
  return cases
}
