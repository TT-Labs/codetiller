import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { RepoProfileSchema } from '../dataset/task.js'
import type { Sandbox } from '../sandbox/sandbox.js'
import { TaskRepo } from './repo.js'
import {
  acceptChecks,
  judge,
  sensitivePaths,
  verificationDetails,
  verificationSummary,
  verificationVerdict,
  verifyCommit,
} from './verify.js'

const base = (failing: string[] = [], passing: string[] = []) => ({ failing, passing })

const c = (id: string, passed: boolean) => ({ id, passed })

it('only failures that are new relative to the base commit fail verification', () => {
  const cases = [c('a', true), c('b', false), c('flaky-at-base', false)]
  const v = judge(cases, base(['flaky-at-base']))
  expect(v).toMatchObject({ status: 'fail', total: 3, failed: ['b'], known: 1 })
  expect(verificationSummary(v)).toContain('1 of 3 tests newly failing, 1 already failing at base')

  const ok = judge([c('a', true), c('flaky-at-base', false)], base(['flaky-at-base']))
  expect(ok.status).toBe('pass')
  expect(verificationSummary(ok)).toBe('verification passed: 2 tests, 1 already failing at base')
})

it('no report is an error, never a pass', () => {
  expect(judge(null, base()).status).toBe('error')
})

it('reads the verdict back from the timeline text', () => {
  const fail = judge([c('a', false)], base())
  for (const v of [judge([c('a', true)], base()), fail, judge(null, base())])
    expect(verificationVerdict(verificationSummary(v))).toBe(v.status)
  expect(verificationVerdict('skipped: no changes on the branch')).toBe('none')
  expect(verificationVerdict(null)).toBe('none')
})

it('a test that passed at base and no longer runs fails verification; a renamed one is only named', () => {
  const before = base(
    ['f.test.ts > flaky'],
    [
      'f.test.ts > adds',
      'f.test.ts > subtracts',
      'g.test.ts > one',
      'g.test.ts > two',
      'h.test.ts > x',
    ],
  )
  // deleted file (h), a skipped test (f > subtracts: skipped tests are not in the report),
  // and a rename that keeps the file's number of tests (g > two → g > second)
  const now = [
    c('f.test.ts > flaky', false),
    c('f.test.ts > adds', true),
    c('g.test.ts > one', true),
    c('g.test.ts > second', true),
  ]
  const v = judge(now, before)
  expect(v).toMatchObject({
    status: 'fail',
    failed: [],
    removed: ['f.test.ts > subtracts', 'h.test.ts > x'],
    gone: ['g.test.ts > two'],
  })
  const text = verificationSummary(v)
  expect(text.split('\n')[0]).toBe(
    'verification failed: 2 tests no longer run, 1 already failing at base',
  )
  expect(verificationVerdict(text)).toBe('fail')
  expect(verificationDetails(text)).toEqual({
    failing: [],
    removed: ['f.test.ts > subtracts', 'h.test.ts > x'],
    gone: ['g.test.ts > two'],
    sensitive: [],
    baseChecks: [],
    checks: [],
  })
  // a suite that stops collecting tests is the same thing
  expect(judge([], before)).toMatchObject({ status: 'fail', removed: before.passing })
  // a human accepted the removals: they are still named, and no longer fail
  const ok = judge(now, before, { accepted: v.removed })
  expect(ok).toMatchObject({ status: 'pass', removed: [] })
  expect(ok.gone).toEqual(['f.test.ts > subtracts', 'g.test.ts > two', 'h.test.ts > x'])
  // new tests and a failing test that disappeared are nothing to report
  expect(
    judge(
      [c('f.test.ts > adds', true), c('n.test.ts > new', true)],
      base(['f.test.ts > flaky'], ['f.test.ts > adds']),
    ),
  ).toMatchObject({ status: 'pass', removed: [], gone: [] })
})

it('names the changed files that decide how the change is checked, pass or fail', () => {
  const changed = [
    'src/app.ts',
    'src/app.test.ts',
    'vitest.config.ts',
    'apps/web/vitest.config.mts',
    '.github/workflows/ci.yml',
    'package.json',
    'apps/web/package.json',
    'tsconfig.build.json',
    'biome.json',
    '.factory/factory.yaml',
    'Makefile',
    'docs/config.md',
    'scripts/check.sh',
  ]
  // only the package.json whose scripts changed counts; the profile adds its own paths
  const sensitive = sensitivePaths(changed, ['package.json'], ['^scripts/'])
  expect(sensitive).toEqual([
    '.factory/factory.yaml',
    '.github/workflows/ci.yml',
    'Makefile',
    'apps/web/vitest.config.mts',
    'biome.json',
    'package.json (scripts)',
    'scripts/check.sh',
    'tsconfig.build.json',
    'vitest.config.ts',
  ])
  // an all-green report from a changed test config passes, with the config named
  const v = judge([c('a', true)], base([], ['a']), { sensitive: ['vitest.config.ts'] })
  const text = verificationSummary(v)
  expect(text).toBe(
    'verification passed: 1 tests\n\nThis change modifies how it is checked:\n- vitest.config.ts',
  )
  expect(verificationDetails(text).sensitive).toEqual(['vitest.config.ts'])
  expect(
    verificationDetails('verification failed: 1 of 2 tests newly failing\n- a > b').failing,
  ).toEqual(['a > b'])
})

// ---- verifyCommit against a real git repo and a stand-in test runner --------------------------

const git = (cwd: string, ...a: string[]) =>
  execFileSync('git', a, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  }).trim()

/**
 * A repo whose "test runner" is the sandbox below: `tests.txt` lists `<name> pass|fail`, and a
 * `vitest.config.ts` containing `forge` reports every listed test as passed, whatever it says:
 * a reporter the change wrote itself.
 */
async function verifyFixture() {
  const root = mkdtempSync(join(tmpdir(), 'tiller-verify-'))
  const src = join(root, 'src')
  mkdirSync(src)
  git(src, 'init', '-q')
  writeFileSync(join(src, 'lock'), 'l')
  writeFileSync(join(src, 'tests.txt'), 'adds pass\nsubtracts pass\n')
  writeFileSync(join(src, 'vitest.config.ts'), 'export default {}\n')
  mkdirSync(join(src, 'conf'))
  writeFileSync(join(src, 'conf', 'vitest.config.ts'), 'export default {}\n')
  writeFileSync(join(src, 'package.json'), '{"name":"x","scripts":{"test":"vitest run"}}\n')
  git(src, 'add', '-A')
  git(src, 'commit', '-qm', 'base')
  const base = git(src, 'rev-parse', 'HEAD')
  mkdirSync(join(root, 'work'))
  const ws = join(root, 'work', 'task-T-1')
  const repo = new TaskRepo(join(root, 'work', 'task-T-1.repo'), ws)
  await repo.init(src, base, 'tiller/t-1')
  const runs: string[] = []
  const sandbox: Sandbox = {
    exec: async (req) => {
      const done = { exitCode: 0, timedOut: false, stdout: '', stderr: '', duration_s: 0 }
      // a check of the profile: passes unless the tree says otherwise (`types.txt` = "broken")
      if (req.cmd.join(' ').includes('TYPECHECK')) {
        const tree = req.mounts?.find((m) => m.container === '/workspace')?.host as string
        const broken = existsSync(join(tree, 'types.txt'))
        return broken
          ? { ...done, exitCode: 2, stdout: "- src/a.ts(3,7): error TS2322: Type 'string'" }
          : done
      }
      if (!req.cmd.join(' ').includes('RUNTESTS')) return done
      const tree = req.mounts?.find((m) => m.container === '/workspace')?.host as string
      const out = req.mounts?.find((m) => m.container === '/tiller-out')?.host as string
      const forged = readFileSync(join(tree, 'vitest.config.ts'), 'utf8').includes('forge')
      runs.push(forged ? 'forged' : 'honest')
      const assertionResults = readFileSync(join(tree, 'tests.txt'), 'utf8')
        .trim()
        .split('\n')
        .map((l) => l.split(' '))
        .map(([title, result]) => ({
          ancestorTitles: [],
          title,
          status: forged || result === 'pass' ? 'passed' : 'failed',
        }))
      // a test that reaches the report file: whatever ran, the file says all passed
      const overwritten = existsSync(join(tree, 'overwrite-report'))
      const results = overwritten
        ? assertionResults.map((r) => ({ ...r, status: 'passed' }))
        : assertionResults
      writeFileSync(
        join(out, 'report.json'),
        JSON.stringify({
          testResults: [{ name: '/workspace/x.test.ts', assertionResults: results }],
        }),
      )
      // the exit code is the runner's own: it failed if a test failed
      return { ...done, exitCode: assertionResults.some((r) => r.status === 'failed') ? 1 : 0 }
    },
  }
  const profile = RepoProfileSchema.parse({
    image: 'i',
    toolchains: [
      {
        lockfile: 'lock',
        setup: 'true',
        test: 'RUNTESTS {{out}}',
        cache: { volume: 'v', path: '/c' },
      },
    ],
    parser: 'vitest-json',
  })
  const deps = { sandbox, profile, repo, repoName: 'o/r' }
  const change = async (files: Record<string, string>) => {
    for (const [f, text] of Object.entries(files)) writeFileSync(join(ws, f), text)
    return (await repo.commitAll('change')) as string
  }
  return { base, repo, deps, change, runs }
}

it('a change that passes only with the test configuration it wrote itself fails verification', async () => {
  const { base, repo, deps, change, runs } = await verifyFixture()
  // breaks a test and makes the reporter say everything passed
  const head = await change({
    'tests.txt': 'adds pass\nsubtracts fail\n',
    'vitest.config.ts': 'export default { reporters: ["./forge.js"] }\n',
  })
  const v = await verifyCommit(deps, base, head)
  // base suite, the change with its own config (all green), the change with the base config
  expect(runs).toEqual(['honest', 'forged', 'honest'])
  expect(v).toMatchObject({
    status: 'fail',
    failed: [],
    sensitive: ['vitest.config.ts'],
    baseChecks: { status: 'fail', failed: ['x.test.ts > subtracts'] },
  })
  const text = verificationSummary(v)
  expect(text.split('\n')[0]).toBe(
    'verification failed: 1 test fails with the checks as they were before this change',
  )
  expect(verificationDetails(text)).toMatchObject({
    failing: [],
    baseChecks: ['x.test.ts > subtracts'],
    sensitive: ['vitest.config.ts'],
  })
  // a human accepts the changed config: the suite is not run again without it, the file stays named
  expect(await acceptChecks(repo.holder)).toEqual(['vitest.config.ts'])
  const accepted = await verifyCommit(deps, base, head)
  expect(accepted).toMatchObject({
    status: 'pass',
    sensitive: ['vitest.config.ts'],
    baseChecks: null,
  })
  expect(runs.slice(3)).toEqual(['forged'])
})

it('a config change that does not change the result passes, after being checked both ways', async () => {
  const { base, deps, change, runs } = await verifyFixture()
  const head = await change({
    'tests.txt': 'adds pass\nsubtracts pass\nmultiplies pass\n',
    'vitest.config.ts': 'export default { testTimeout: 10000 }\n',
    // scripts changed too: flagged, and restored for the second run without touching the rest
    'package.json':
      '{"name":"x","scripts":{"test":"vitest run --passWithNoTests"},"dependencies":{"a":"1"}}\n',
  })
  const v = await verifyCommit(deps, base, head)
  expect(runs).toEqual(['honest', 'honest', 'honest'])
  expect(v).toMatchObject({
    status: 'pass',
    total: 3,
    sensitive: ['package.json (scripts)', 'vitest.config.ts'],
    baseChecks: { status: 'pass', failed: [] },
  })
  expect(verificationSummary(v).split('\n')[0]).toBe('verification passed: 3 tests')
})

it('a change that touches no check file is verified once; one that touches only CI is not run twice', async () => {
  const { base, deps, change, runs } = await verifyFixture()
  const head = await change({ 'tests.txt': 'adds pass\nsubtracts pass\n', 'src.ts': 'x' })
  expect(await verifyCommit(deps, base, head)).toMatchObject({ status: 'pass', baseChecks: null })
  expect(runs).toEqual(['honest', 'honest'])
  mkdirSync(join(deps.repo.workTree, '.github', 'workflows'), { recursive: true })
  const ci = await change({ '.github/workflows/ci.yml': 'on: push\n' })
  const v = await verifyCommit(deps, base, ci)
  expect(v).toMatchObject({
    status: 'pass',
    sensitive: ['.github/workflows/ci.yml'],
    baseChecks: null,
  })
  expect(runs).toHaveLength(3)
})

it('restoring a check file never writes through a link the change planted', async () => {
  const { base, deps, change } = await verifyFixture()
  const outside = mkdtempSync(join(tmpdir(), 'tiller-outside-'))
  // the directory of a config file becomes a link to somewhere else: putting the file back
  // would write there
  rmSync(join(deps.repo.workTree, 'conf'), { recursive: true })
  symlinkSync(outside, join(deps.repo.workTree, 'conf'))
  const head = await change({ 'tests.txt': 'adds pass\nsubtracts pass\n' })
  const v = await verifyCommit(deps, base, head)
  expect(readdirSync(outside)).toEqual([])
  // checks that cannot be restored are checks that did not pass
  expect(v).toMatchObject({
    status: 'fail',
    sensitive: ['conf/vitest.config.ts'],
    baseChecks: { status: 'error' },
  })
  expect(verificationSummary(v).split('\n')[0]).toBe(
    'verification failed: no test report with the checks as they were before this change',
  )
  expect(v.log).toContain('conf/vitest.config.ts leads outside the tree')
})

it('a report that hides what the runner saw is an error: the exit code and the report disagree', async () => {
  const { base, deps, change } = await verifyFixture()
  // no check file touched: a test breaks and the test code itself rewrites the report
  const head = await change({ 'tests.txt': 'adds pass\nsubtracts fail\n', 'overwrite-report': '' })
  const v = await verifyCommit(deps, base, head)
  expect(v.status).toBe('error')
  expect(verificationSummary(v)).toBe(
    'verification error: the test command failed but its report shows no failing test: main (exit 1)',
  )
  expect(verificationVerdict(verificationSummary(v))).toBe('error')
  // an honest failing report is a failure, not an error
  const honest = await change({ 'tests.txt': 'adds pass\nsubtracts fail\n' })
  rmSync(join(deps.repo.workTree, 'overwrite-report'))
  const again = (await deps.repo.commitAll('honest')) as string
  expect(honest).toBeUndefined()
  expect(await verifyCommit(deps, base, again)).toMatchObject({
    status: 'fail',
    failed: ['x.test.ts > subtracts'],
  })
})

it('a check of the profile that passed before the change fails verification, with what it printed', async () => {
  const { base, deps, change } = await verifyFixture()
  const profile = RepoProfileSchema.parse({
    ...deps.profile,
    checks: [{ name: 'typecheck', run: 'TYPECHECK' }],
  })
  const head = await change({ 'tests.txt': 'adds pass\nsubtracts pass\n', 'types.txt': 'broken' })
  const v = await verifyCommit({ ...deps, profile }, base, head)
  // the tests pass; the type check, which CI would have been the first to run, does not
  expect(v).toMatchObject({
    status: 'fail',
    failed: [],
    checks: [{ name: 'typecheck', output: "- src/a.ts(3,7): error TS2322: Type 'string'" }],
  })
  const text = verificationSummary(v)
  expect(text).toBe(
    [
      'verification failed: 1 check failed',
      '',
      'Failed checks (they passed before this change):',
      '- typecheck',
      '',
      'Output of typecheck (the end):',
      '```',
      "- src/a.ts(3,7): error TS2322: Type 'string'",
      '```',
    ].join('\n'),
  )
  // the output is not read as a list, although its line starts like an entry of one
  expect(verificationDetails(text)).toMatchObject({ checks: ['typecheck'], failing: [] })
})

it('a check that already fails at the base commit is not held against the change', async () => {
  const { deps, repo, change } = await verifyFixture()
  const profile = RepoProfileSchema.parse({
    ...deps.profile,
    checks: [{ name: 'typecheck', run: 'TYPECHECK' }],
  })
  // the type check is broken before the task starts
  const brokenBase = await change({ 'types.txt': 'broken' })
  const head = await change({ 'tests.txt': 'adds pass\nsubtracts pass\nmore pass\n' })
  const v = await verifyCommit({ ...deps, profile }, brokenBase, head)
  expect(v).toMatchObject({ status: 'pass', checks: [], total: 3 })
  expect(JSON.parse(readFileSync(join(repo.holder, 'baseline.json'), 'utf8'))).toMatchObject({
    failingChecks: ['typecheck'],
  })
})
