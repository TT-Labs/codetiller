import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, join, sep } from 'node:path'
import type { RepoProfile } from '../profile/profile.js'
import { ensureDeps } from '../sandbox/deps.js'
import type { Sandbox } from '../sandbox/sandbox.js'
import { type CheckRun, runCheck, runTests, type TestRun } from '../verify/tests.js'
import type { TestCase } from '../verify/vitest.js'
import type { TaskRepo } from './repo.js'

export interface Verification {
  /** error = the suite produced no usable report (setup/crash): nothing can be said about the change */
  status: 'pass' | 'fail' | 'error'
  /** what is wrong with the report, when it is not simply missing */
  error?: string
  total: number
  /** tests failing now that did not fail at the task's base commit */
  failed: string[]
  /** tests failing now and at base: not the agent's fault, don't block on them */
  known: number
  /**
   * Passed at base, do not run now, and their file ended up with fewer tests than it had:
   * deleted or skipped. Fails verification like a failing test.
   */
  removed: string[]
  /**
   * Passed at base and do not run now, without counting as a failure: the file kept its number
   * of tests (renamed or rewritten), or a human accepted the removal. Named for the reviewer.
   */
  gone: string[]
  /** changed files that decide how the change is checked: test config, CI, package scripts, .factory/ */
  sensitive: string[]
  /**
   * The suite once more with those files as they were at the base commit, when the change
   * touched any that the suite reads: what fails (or no longer runs) then. A change must pass
   * with the checks it did not write. null = not run (nothing to restore, or a human accepted them).
   */
  baseChecks: { status: Verification['status']; failed: string[] } | null
  /**
   * The profile's checks (type check, lint, build) that fail now and passed at the base commit,
   * with the end of their output. They fail verification like a failing test.
   */
  checks: { name: string; output: string }[]
  log: string
}

/** The suite's result at the task's base commit: what the change is measured against. */
export interface Baseline {
  failing: string[]
  passing: string[]
  /**
   * At base the test command already failed without a failing test in its report (a suite with
   * a failing coverage threshold, say): for this task that disagreement proves nothing.
   */
  disagrees?: boolean
  /** checks of the profile that already fail at base: not held against the change */
  failingChecks?: string[]
}

/** the file (vitest) or package (go test) a test id belongs to */
const fileOf = (id: string) => id.split(' > ')[0] ?? id

/**
 * Deterministic verdict. Only failures that are new relative to the base commit count, and a
 * test that passed at base must still run: the suite runs the agent's code, so "nothing fails"
 * is also what a change that deletes or skips its tests looks like.
 */
export function judge(
  cases: TestCase[] | null,
  baseline: Baseline,
  opts: { log?: string; sensitive?: string[]; accepted?: string[]; checks?: CheckRun[] } = {},
): Verification {
  const { log = '', sensitive = [] } = opts
  const known = new Set(baseline.failingChecks ?? [])
  const checks = (opts.checks ?? [])
    .filter((c) => !c.ok && !known.has(c.name))
    .map((c) => ({ name: c.name, output: c.output }))
  if (!cases)
    return {
      status: 'error',
      total: 0,
      failed: [],
      known: 0,
      removed: [],
      gone: [],
      sensitive,
      baseChecks: null,
      checks,
      log,
    }
  const base = new Set(baseline.failing)
  const failing = cases.filter((c) => !c.passed).map((c) => c.id)
  const failed = failing.filter((id) => !base.has(id))
  const now = new Set(cases.map((c) => c.id))
  const count = (ids: Iterable<string>) => {
    const n = new Map<string, number>()
    for (const id of ids) n.set(fileOf(id), (n.get(fileOf(id)) ?? 0) + 1)
    return n
  }
  const before = count([...baseline.passing, ...baseline.failing])
  const after = count(now)
  const accepted = new Set(opts.accepted ?? [])
  const missing = baseline.passing.filter((id) => !now.has(id))
  // a file with as many tests as before lost none: its tests were renamed or rewritten
  const shrank = (id: string) => (after.get(fileOf(id)) ?? 0) < (before.get(fileOf(id)) ?? 0)
  const removed = missing.filter((id) => shrank(id) && !accepted.has(id))
  return {
    status: failed.length || removed.length || checks.length ? 'fail' : 'pass',
    total: cases.length,
    failed,
    known: failing.length - failed.length,
    removed,
    gone: missing.filter((id) => !removed.includes(id)),
    sensitive,
    baseChecks: null,
    checks,
    log,
  }
}

/**
 * The verdict once the suite also ran with the base commit's checks: a change that passes only
 * with the test configuration it wrote itself has not passed.
 */
export function withBaseChecks(v: Verification, base: Verification): Verification {
  return {
    ...v,
    status: v.status === 'pass' && base.status !== 'pass' ? 'fail' : v.status,
    baseChecks: { status: base.status, failed: [...base.failed, ...base.removed] },
  }
}

/**
 * Verdict of a timeline `verification` entry, read back from the text {@link verificationSummary}
 * and the factory write (events store text only). `none` = no verdict: skipped or unrecognised.
 */
export function verificationVerdict(text: string | null): Verification['status'] | 'none' {
  if (text?.startsWith('verification passed')) return 'pass'
  if (text?.startsWith('verification failed')) return 'fail'
  if (text?.startsWith('verification error')) return 'error'
  return 'none'
}

// headings of the lists under the verdict line; the UI and the PR read the text back by them
const REMOVED = 'No longer run (passed before this change):'
const GONE = 'No longer run, not counted as a failure (replaced in the same file, or accepted):'
const SENSITIVE = 'This change modifies how it is checked:'
const BASE_CHECKS = 'Fails with the checks as they were before this change:'
const CHECKS = 'Failed checks (they passed before this change):'
const OUTPUT = 'Output of '

const list = (items: string[], max = 10) => [
  ...items.slice(0, max).map((f) => `- ${f}`),
  ...(items.length > max ? [`- … ${items.length - max} more`] : []),
]

export function verificationSummary(v: Verification): string {
  const base = v.baseChecks && v.baseChecks.status !== 'pass' ? v.baseChecks : null
  const flags = [
    ...(v.gone.length ? ['', GONE, ...list(v.gone)] : []),
    ...(v.sensitive.length ? ['', SENSITIVE, ...list(v.sensitive, 20)] : []),
  ]
  if (v.status === 'error')
    return [`verification error: ${v.error ?? 'test suite produced no report'}`, ...flags].join(
      '\n',
    )
  const known = v.known ? `, ${v.known} already failing at base` : ''
  if (v.status === 'pass')
    return [`verification passed: ${v.total} tests${known}`, ...flags].join('\n')
  const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
  const what = [
    ...(v.failed.length ? [`${v.failed.length} of ${v.total} tests newly failing`] : []),
    ...(v.removed.length ? [`${count(v.removed.length, 'test', 'tests')} no longer run`] : []),
    ...(v.checks.length ? [`${count(v.checks.length, 'check', 'checks')} failed`] : []),
    ...(base
      ? [
          base.status === 'error'
            ? 'no test report with the checks as they were before this change'
            : `${count(base.failed.length, 'test fails', 'tests fail')} with the checks as they were before this change`,
        ]
      : []),
  ].join(', ')
  return [
    `verification failed: ${what}${known}`,
    ...list(v.failed),
    ...(v.removed.length ? ['', REMOVED, ...list(v.removed)] : []),
    ...(base?.failed.length ? ['', BASE_CHECKS, ...list(base.failed)] : []),
    ...(v.checks.length ? ['', CHECKS, ...list(v.checks.map((c) => c.name))] : []),
    ...flags,
    // what each failed check printed, for whoever fixes it; after the lists, which end here
    ...v.checks.flatMap((c) => ['', `${OUTPUT}${c.name} (the end):`, '```', c.output, '```']),
  ].join('\n')
}

/** The lists of a verification text, as {@link verificationSummary} wrote them. */
export function verificationDetails(text: string | null) {
  const out = {
    failing: [] as string[],
    removed: [] as string[],
    gone: [] as string[],
    sensitive: [] as string[],
    baseChecks: [] as string[],
    checks: [] as string[],
  }
  let into: string[] | null = out.failing
  for (const line of (text ?? '').split('\n').slice(1)) {
    if (line === REMOVED) into = out.removed
    else if (line === GONE) into = out.gone
    else if (line === SENSITIVE) into = out.sensitive
    else if (line === BASE_CHECKS) into = out.baseChecks
    else if (line === CHECKS) into = out.checks
    // what a check printed is not a list, whatever its lines start with
    else if (line.startsWith(OUTPUT)) into = null
    else if (line.startsWith('- ')) into?.push(line.slice(2))
  }
  return out
}

const SENSITIVE_PATHS = [
  // test runners and what configures them
  /(^|\/)(vitest|jest|playwright|cypress|karma|ava|mocha)\.(config|workspace)\.[cm]?[jt]sx?$/,
  /(^|\/)\.mocharc(\.[\w.]+)?$/,
  /(^|\/)(pytest\.ini|tox\.ini|conftest\.py|setup\.cfg|noxfile\.py|pyproject\.toml)$/,
  /(^|\/)(Makefile|justfile|Taskfile\.ya?ml)$/,
  // CI
  /^\.github\/(workflows|actions)\//,
  /^\.gitlab-ci\.yml$/,
  /^\.circleci\//,
  /(^|\/)Jenkinsfile$/,
  // lint and type checks
  /(^|\/)(biome\.jsonc?|\.eslintrc(\.[\w.]+)?|eslint\.config\.[cm]?[jt]s|\.golangci\.ya?ml)$/,
  /(^|\/)tsconfig(\.[\w.-]+)?\.json$/,
  // the factory's own instructions and limits for this repository
  /^\.factory\//,
]

/**
 * Changed files that decide how a change is checked. `scripts` = the changed package.json files
 * whose scripts differ (the test command lives there); `extra` = patterns of the repo's profile.
 */
export function sensitivePaths(changed: string[], scripts: string[] = [], extra: string[] = []) {
  const patterns = [...SENSITIVE_PATHS, ...extra.map((p) => new RegExp(p))]
  const hit = changed.filter((f) => patterns.some((p) => p.test(f)))
  return [...new Set([...hit, ...scripts.map((f) => `${f} (scripts)`)])].sort()
}

export interface VerifyDeps {
  sandbox: Sandbox
  profile: RepoProfile
  repo: TaskRepo
  /** GitHub owner/name (deps volume key) */
  repoName: string
  log?: (m: string) => void
}

/** files only a CI service or the factory reads: restoring them changes nothing in a local suite */
const NOT_READ_BY_THE_SUITE =
  /^(\.github\/|\.gitlab-ci\.yml$|\.circleci\/|\.factory\/)|(^|\/)Jenkinsfile$/

/** Is `target` inside `root` once links are followed? A path of the change may run through a symlink. */
async function inside(root: string, target: string): Promise<boolean> {
  let dir = dirname(target)
  // the deepest directory that exists decides where a write would land
  while (!(await realpath(dir).catch(() => null))) dir = dirname(dir)
  const real = await realpath(dir)
  const base = await realpath(root)
  return real === base || real.startsWith(base + sep)
}

/**
 * In an exported tree, put the files that decide the checks back to what they were at `base`:
 * a file the change added is removed, one it changed or deleted gets its base content, and a
 * package.json gets its base `scripts` only (its dependencies belong to the change).
 */
async function restoreChecks(deps: VerifyDeps, tree: string, base: string, sensitive: string[]) {
  const show = (path: string) => deps.repo.git(['show', `${base}:${path}`]).catch(() => null)
  for (const entry of sensitive) {
    const scripts = entry.endsWith(' (scripts)')
    const path = scripts ? entry.slice(0, -' (scripts)'.length) : entry
    const target = join(tree, path)
    // never write through a link the change planted
    if (!(await inside(tree, target))) throw new Error(`${path} leads outside the tree`)
    const before = await show(path)
    if (scripts) {
      const now = await readFile(target, 'utf8').catch(() => null)
      if (now === null) continue
      const pkg = JSON.parse(now) as { scripts?: unknown }
      const old = before ? (JSON.parse(before) as { scripts?: unknown }).scripts : undefined
      if (old === undefined) delete pkg.scripts
      else pkg.scripts = old
      await writeFile(target, `${JSON.stringify(pkg, null, 2)}\n`)
      continue
    }
    await rm(target, { recursive: true, force: true })
    if (before !== null) {
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, before)
    }
  }
}

/**
 * Full suite on a clean export of `commit`, offline, in a fresh container (never the workspace).
 * `restore`: with the files that decide the checks put back to their content at that base.
 */
async function suite(
  deps: VerifyDeps,
  commit: string,
  restore?: { base: string; sensitive: string[] },
) {
  const tree = await deps.repo.exportTree(commit)
  try {
    if (restore) await restoreChecks(deps, tree, restore.base, restore.sensitive)
    const nm = await ensureDeps(deps.sandbox, deps.profile, tree, deps.repoName, deps.log)
    // main toolchain suite, then the profile's extra suites (polyglot repos); any suite without a
    // report makes the whole result unknown
    const runs: { name: string; t: TestRun }[] = [
      { name: 'main', t: await runTests(deps.sandbox, deps.profile, tree, [], { deps: nm }) },
    ]
    for (const s of deps.profile.suites) {
      const t = await runTests(deps.sandbox, deps.profile, tree, [], { deps: nm, suite: s })
      runs.push({ name: s.name, t })
    }
    const missing = runs.filter((r) => !r.t.cases).map((r) => r.name)
    // The runner's exit code is decided by the runner; the report is a file the tests can
    // reach. A command that failed while its report shows no failing test: the two disagree.
    const disagree = runs
      .filter((r) => r.t.exec.exitCode !== 0 && r.t.cases?.every((c) => c.passed))
      .map((r) => `${r.name} (exit ${r.t.exec.exitCode})`)
    // the profile's checks: what the repository's CI would otherwise be the first to say
    const checks: CheckRun[] = []
    if (!restore)
      for (const c of deps.profile.checks)
        checks.push(await runCheck(deps.sandbox, deps.profile, tree, c, { deps: nm }))
    const log = [
      ...runs.map((r) => `=== suite ${r.name}\n${r.t.exec.stdout}\n${r.t.exec.stderr}`),
      ...checks.map((c) => `=== check ${c.name}: ${c.ok ? 'ok' : 'FAILED'}\n${c.output}`),
    ].join('\n')
    if (missing.length)
      return { cases: null, log: `no report from: ${missing.join(', ')}\n${log}`, disagree, checks }
    return { cases: runs.flatMap((r) => r.t.cases ?? []), log, disagree, checks }
  } finally {
    await rm(tree, { recursive: true, force: true })
  }
}

const scriptsOf = (json: string | null) => {
  try {
    return JSON.stringify((JSON.parse(json ?? '{}') as { scripts?: unknown }).scripts ?? {})
  } catch {
    // unreadable is a change worth a look
    return json
  }
}

/** What the change touches of the things that check it (read from trusted git, never the workspace). */
async function sensitiveChanges(deps: VerifyDeps, base: string, commit: string) {
  const changed = (await deps.repo.git(['diff', '--name-only', '-z', base, commit]))
    .split('\0')
    .filter(Boolean)
  const show = (rev: string, path: string) =>
    deps.repo.git(['show', `${rev}:${path}`]).catch(() => null)
  const scripts: string[] = []
  for (const f of changed.filter((p) => /(^|\/)package\.json$/.test(p)))
    if (scriptsOf(await show(base, f)) !== scriptsOf(await show(commit, f))) scripts.push(f)
  return sensitivePaths(changed, scripts, deps.profile.sensitive_paths)
}

/** removals a human accepted for this task: they no longer fail its verification */
const ACCEPTED_FILE = 'accepted-removed.json'
/** changed check files a human accepted for this task: the suite is not run again without them */
const ACCEPTED_CHECKS_FILE = 'accepted-checks.json'
/** the last verdict in full (the timeline text is cut to ten names per list) */
const LAST_FILE = 'verification.json'

const readJson = <T>(path: string): Promise<T | null> =>
  readFile(path, 'utf8').then(
    (raw) => JSON.parse(raw) as T,
    () => null,
  )

/**
 * A human says the tests that no longer run may go: the ones the last verification named stop
 * counting as failures for this task. Returns them.
 */
export async function acceptRemoved(holder: string): Promise<string[]> {
  const last = await readJson<Verification>(join(holder, LAST_FILE))
  const removed = last?.removed ?? []
  if (!removed.length) return []
  const before = (await readJson<string[]>(join(holder, ACCEPTED_FILE))) ?? []
  await writeFile(
    join(holder, ACCEPTED_FILE),
    JSON.stringify([...new Set([...before, ...removed])]),
  )
  return removed
}

/**
 * A human says the changed check files are fine: the ones the last verification named are no
 * longer put back to their base content for a second run. They stay listed. Returns them.
 */
export async function acceptChecks(holder: string): Promise<string[]> {
  const last = await readJson<Verification>(join(holder, LAST_FILE))
  const sensitive = last?.sensitive ?? []
  if (!sensitive.length) return []
  const before = (await readJson<string[]>(join(holder, ACCEPTED_CHECKS_FILE))) ?? []
  await writeFile(
    join(holder, ACCEPTED_CHECKS_FILE),
    JSON.stringify([...new Set([...before, ...sensitive])]),
  )
  return sensitive
}

/**
 * Verification step: the agent's commit must not break tests that passed at the task's
 * base commit, and must not make them disappear. The base result is computed once per task and
 * cached next to the trusted git dir.
 */
export async function verifyCommit(
  deps: VerifyDeps,
  base: string,
  commit: string,
): Promise<Verification> {
  const cache = join(deps.repo.holder, 'baseline.json')
  const sensitive = await sensitiveChanges(deps, base, commit)
  // a cache from before passing tests were kept (a plain list) is computed again
  let baseline = await readJson<Baseline>(cache)
  // (so is one from before the profile had checks: what fails at base has to be known)
  const stale =
    !baseline ||
    Array.isArray(baseline) ||
    (deps.profile.checks.length > 0 && baseline.failingChecks === undefined)
  if (!baseline || stale) {
    deps.log?.('verify: baseline suite at base commit (once per task)')
    const b = await suite(deps, base)
    if (!b.cases)
      return judge(
        null,
        { failing: [], passing: [] },
        {
          log: `baseline at ${base} produced no report\n${b.log}`,
          sensitive,
        },
      )
    baseline = {
      failing: b.cases.filter((c) => !c.passed).map((c) => c.id),
      passing: b.cases.filter((c) => c.passed).map((c) => c.id),
      ...(b.disagree.length ? { disagrees: true } : {}),
      failingChecks: b.checks.filter((c) => !c.ok).map((c) => c.name),
    }
    await writeFile(cache, JSON.stringify(baseline))
  }
  const r = await suite(deps, commit)
  const accepted = (await readJson<string[]>(join(deps.repo.holder, ACCEPTED_FILE))) ?? []
  let v = judge(r.cases, baseline, { log: r.log, sensitive, accepted, checks: r.checks })
  if (r.cases && r.disagree.length && !baseline.disagrees)
    // a report that says more than the runner did is not a report to go by
    v = {
      ...judge(null, baseline, { log: r.log, sensitive }),
      error: `the test command failed but its report shows no failing test: ${r.disagree.join(', ')}`,
    }
  // The suite just ran with the test configuration the change itself wrote, which can make any
  // report. Where the change touched such files, the suite runs once more with them as they
  // were at the base commit; the change has to pass that too, unless a human accepted the files.
  const fine = new Set(
    (await readJson<string[]>(join(deps.repo.holder, ACCEPTED_CHECKS_FILE))) ?? [],
  )
  const restore = sensitive.filter((f) => !fine.has(f) && !NOT_READ_BY_THE_SUITE.test(f))
  if (restore.length && v.status !== 'error') {
    deps.log?.(`verify: again with ${restore.length} check file(s) as at the base commit`)
    const again = await suite(deps, commit, { base, sensitive: restore }).catch((e: Error) => ({
      cases: null,
      log: `could not restore the checks: ${e.message}`,
      disagree: [] as string[],
      checks: [] as CheckRun[],
    }))
    // the same disagreement in the second run means the same: no report to go by
    const usable = again.disagree.length && !baseline.disagrees ? null : again.cases
    v = withBaseChecks(v, judge(usable, baseline, { accepted }))
    v.log = `${v.log}\n\n=== with the checks as at the base commit\n${again.log}`
  }
  await writeFile(join(deps.repo.holder, LAST_FILE), JSON.stringify({ ...v, log: '' }))
  return v
}
