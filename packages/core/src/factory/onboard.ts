import { parse, stringify } from 'yaml'
import { type RepoProfile, RepoProfileSchema } from '../dataset/task.js'
import { REPO_FACTORY_FILE } from './preflight.js'

/**
 * What the factory needs to know about a repository lives in the repository, in
 * `.factory/factory.yaml` → `sandbox:` (image, how dependencies are installed, how tests run).
 * The factory reads it from git at the task's base commit, so an agent cannot change the sandbox
 * it runs in. Until a repository carries the file, the profile proposed at onboarding is used.
 */
export function repoSandbox(file: string | undefined): RepoProfile | undefined {
  if (file === undefined) return undefined
  let raw: unknown
  try {
    raw = (parse(file) as { sandbox?: unknown } | null)?.sandbox
  } catch (e) {
    throw new Error(`${REPO_FACTORY_FILE}: ${(e as Error).message.slice(0, 300)}`)
  }
  if (raw === undefined || raw === null) return undefined
  const parsed = RepoProfileSchema.safeParse(raw)
  if (!parsed.success)
    throw new Error(
      `${REPO_FACTORY_FILE} sandbox: ${parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')
        .slice(0, 400)}`,
    )
  return parsed.data
}

/** where the profile a task runs with came from */
export type ProfileSource = 'repository' | 'onboarding' | 'factory'

/** The `sandbox:` section to commit to the repository: the profile without what is default. */
export function sandboxYaml(profile: RepoProfile): string {
  const { suites, checks, sensitive_paths, ...rest } = profile
  const section = {
    ...rest,
    ...(suites.length ? { suites } : {}),
    ...(checks.length ? { checks } : {}),
    ...(sensitive_paths.length ? { sensitive_paths } : {}),
  }
  return stringify({ sandbox: section }, { lineWidth: 0 })
}

/** One suite of the baseline check at onboarding: does the proposed profile run? */
export interface SuiteCheck {
  name: string
  /** tests the suite reported; null = no report (the command failed, or wrote none) */
  tests: number | null
  failing: number
  seconds: number
  /** the end of the output when there was no report: what to fix */
  log?: string
}

export interface Onboarding {
  repo: string
  /** commit the repository was looked at */
  head: string
  source: ProfileSource
  profile: RepoProfile | null
  /** what detection found and what a human should check */
  notes: string[]
  /** null = not checked (no profile, or the check was skipped) */
  check: {
    installed: boolean
    error?: string
    suites: SuiteCheck[]
    /** the profile's checks at the default branch: one that fails there is not held against a change */
    checks?: { name: string; ok: boolean; seconds: number }[]
  } | null
}

/** the profile runs: dependencies installed and every suite wrote a report */
export const onboardingOk = (o: Onboarding) =>
  Boolean(
    o.check?.installed && o.check.suites.length && o.check.suites.every((s) => s.tests !== null),
  )
