import { expect, it } from 'vitest'
import { type AuditRun, auditTask, sourceFiles } from './audit.js'

const run = (outcome: string, files: string[], failed = 0, total = 4): AuditRun => ({
  outcome,
  files,
  f2p: { total, failed },
})

it('keeps only source files of a reference fix', () => {
  expect(
    sourceFiles([
      'packages/zod/src/v4/core/schemas.ts',
      'packages/zod/src/v4/classic/tests/string.test.ts',
      'src/types.test-d.ts',
      '.changeset/brave-cats.md',
      'docs/api.mdx',
      'README.md',
    ]),
  ).toEqual(['packages/zod/src/v4/core/schemas.ts'])
})

it('classifies resolution and measures how close the failed runs got', () => {
  const fix = ['src/a.ts', 'src/v3/b.ts']
  const a = auditTask(
    't',
    [
      run('fail', ['src/a.ts'], 1),
      run('fail', ['src/a.ts'], 1),
      run('fail', ['src/a.ts', 'x.ts'], 3),
      run('fail', [], 4),
    ],
    fix,
  )
  expect(a).toMatchObject({ runs: 4, successes: 0, resolution: 'unsolved', located: 0 })
  // passing shares 0.75, 0.75, 0.25, 0 → median 0.5
  expect(a.partial).toBe(0.5)
  expect(a.untouched).toEqual(['src/v3/b.ts'])

  const mixed = [run('success', fix), run('fail', fix, 2), run('success', fix), run('fail', fix, 2)]
  expect(auditTask('t', mixed, fix)).toMatchObject({
    resolution: 'discriminating',
    located: 1,
    partial: 0.5,
    untouched: [],
  })
  expect(auditTask('t', mixed.slice(0, 3), fix).resolution).toBe('unknown')
  expect(
    auditTask(
      't',
      [0, 1, 2, 3].map(() => run('success', fix)),
      fix,
    ).resolution,
  ).toBe('saturated')
})
