import { loadConfig } from '../config/config.js'
import type { RepoProfile } from '../profile/profile.js'
import { ensureDeps } from '../sandbox/deps.js'
import { runCheck, runTests } from '../verify/tests.js'
import { git } from '../workspace/git.js'
import type { FactoryBase } from './base.js'
import { detectProfile } from './detect.js'
import { type Onboarding, onboardingOk, repoSandbox, type SuiteCheck } from './onboard.js'
import { REPO_FACTORY_FILE } from './preflight.js'

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

/**
 * Onboarding: look at a repository, take its own sandbox profile or propose one from what is
 * in it, and check the profile by running it: dependencies installed (through the registry
 * proxy), every suite run once at the head of the default branch. The result is remembered,
 * so tasks of the repository can run before its `.factory/factory.yaml` is merged.
 */
export async function onboardRepo(
  base: FactoryBase,
  repo: string,
  opts: { config: string; label?: string | null; check?: boolean; log?: (m: string) => void },
): Promise<Onboarding> {
  if (!REPO.test(repo)) throw new Error('repo must be owner/name')
  await loadConfig(await base.configPath(opts.config))
  const log = opts.log ?? (() => {})
  const { workspaces, sandbox } = base.deps
  const cache = await workspaces.ensureRepo(repo, [])
  await workspaces.fetch(repo)
  const head = (await git(cache, 'rev-parse', '--verify', 'origin/HEAD^{commit}')).trim()
  const show = (path: string) => git(cache, 'show', `${head}:${path}`).catch(() => null)
  const own = repoSandbox((await show(REPO_FACTORY_FILE)) ?? undefined)
  let profile: RepoProfile | null = own ?? null
  let notes: string[] = own ? [`${REPO_FACTORY_FILE} of the repository is used as it is`] : []
  if (!own) {
    const paths = (await git(cache, 'ls-tree', '-r', '--name-only', '-z', head))
      .split('\0')
      .filter(Boolean)
    ;({ profile, notes } = await detectProfile({ paths, read: show }))
  }
  const out: Onboarding = {
    repo,
    head,
    source: own ? 'repository' : 'onboarding',
    profile,
    notes,
    check: null,
  }
  if (profile && opts.check !== false) {
    if ((await sandbox.imageId?.(profile.image)) === null)
      throw new Error(
        `sandbox image ${profile.image} is not on this host: \`tiller setup\` gets the factory's own, an image of the repository is built or pulled by hand`,
      )
    const ws = await workspaces.create(repo, head, `onboard-${repo.replace('/', '-')}`)
    const suites: SuiteCheck[] = []
    try {
      log(`installing dependencies (${profile.toolchains.map((t) => t.lockfile).join(' | ')})`)
      const nm = await ensureDeps(sandbox, profile, ws, repo, log)
      const runs = [undefined, ...profile.suites]
      for (const suite of runs) {
        const name = suite?.name ?? 'main'
        log(`running suite ${name}`)
        const started = Date.now()
        const t = await runTests(sandbox, profile, ws, [], { deps: nm, suite })
        suites.push({
          name,
          tests: t.cases ? t.cases.length : null,
          failing: t.cases ? t.cases.filter((c) => !c.passed).length : 0,
          seconds: Math.round((Date.now() - started) / 1000),
          ...(t.cases ? {} : { log: `${t.exec.stdout}\n${t.exec.stderr}`.trim().slice(-1200) }),
        })
      }
      const checks: { name: string; ok: boolean; seconds: number }[] = []
      for (const c of profile.checks) {
        log(`running check ${c.name}`)
        const started = Date.now()
        const r = await runCheck(sandbox, profile, ws, c, { deps: nm })
        checks.push({
          name: c.name,
          ok: r.ok,
          seconds: Math.round((Date.now() - started) / 1000),
        })
      }
      out.check = { installed: true, suites, checks }
    } catch (e) {
      out.check = { installed: false, error: (e as Error).message.slice(-1500), suites }
    } finally {
      await workspaces.dispose(ws)
    }
  }
  const ok = onboardingOk(out)
  base.items.setRepo({
    repo,
    // a repository that carries its own profile needs none remembered here
    profile: own ? null : profile,
    config: opts.config,
    label: opts.label === undefined ? (base.items.repo(repo)?.label ?? 'tiller') : opts.label,
    checked: out.check
      ? {
          at: new Date().toISOString(),
          head,
          ok,
          summary: out.check.installed
            ? out.check.suites
                .map(
                  (c) =>
                    `${c.name}: ${c.tests === null ? 'no report' : `${c.tests} tests, ${c.failing} failing`}`,
                )
                .join('; ')
            : 'dependency install failed',
        }
      : null,
  })
  return out
}
