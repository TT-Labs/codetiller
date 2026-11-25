import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { OFFLINE_PRELUDE } from '../agents/claude-code.js'
import type { RepoProfile, Suite } from '../dataset/task.js'
import type { DepsMount } from '../sandbox/deps.js'
import type { ExecResult, Sandbox } from '../sandbox/sandbox.js'
import { parseGoTestJson } from './gotest.js'
import { parseJUnitXml } from './junit.js'
import { parseVitestJson, type TestCase } from './vitest.js'

export const CONTAINER_ROOT = '/workspace'
// report goes to a fresh per-run host dir, not the workspace: reusing a path that the host just
// deleted intermittently fails with ENOENT through Colima virtiofs
const OUT = '/tiller-out'

/** One of the profile's checks (type check, lint, build): passed = the command exited 0. */
export interface CheckRun {
  name: string
  ok: boolean
  /** the end of what it printed */
  output: string
}

/** Run one check command on workspace `ws`, offline, with the installed dependencies. */
export async function runCheck(
  sandbox: Sandbox,
  profile: RepoProfile,
  ws: string,
  check: { name: string; run: string },
  opts: { deps: DepsMount; timeout_s?: number },
): Promise<CheckRun> {
  const exec = await sandbox.exec({
    image: profile.image,
    // package managers must not wait for a network that is not there (as for the agent)
    cmd: ['sh', '-c', `${OFFLINE_PRELUDE}\n${check.run}`],
    mounts: [{ host: ws, container: CONTAINER_ROOT }],
    volumes: opts.deps.volumes,
    tmpfs: opts.deps.scratch,
    network: 'none',
    workdir: CONTAINER_ROOT,
    limits: { timeout_s: opts.timeout_s ?? 900 },
  })
  const output = `${exec.stdout}\n${exec.stderr}`.trim()
  return {
    name: check.name,
    ok: exec.exitCode === 0 && !exec.timedOut,
    output: `${exec.timedOut ? 'timed out\n' : ''}${output}`
      .split('\n')
      .slice(-40)
      .join('\n')
      .slice(-4000),
  }
}

export interface TestRun {
  cases: TestCase[] | null // null = no report (setup/crash)
  exec: ExecResult
}

/**
 * Run the toolchain's test command for `files` (or `opts.suite`'s own command) in a fresh container
 * on workspace `ws`.
 */
export async function runTests(
  sandbox: Sandbox,
  profile: RepoProfile,
  ws: string,
  files: string[],
  opts: { deps: DepsMount; timeout_s?: number; suite?: Suite },
): Promise<TestRun> {
  // sibling of .cache/work (must be under $HOME: Colima shares only that into the VM)
  const outRoot = join(dirname(dirname(ws)), 'out')
  await mkdir(outRoot, { recursive: true })
  const out = await mkdtemp(join(outRoot, 'run-'))
  const test = (opts.suite?.test ?? opts.deps.toolchain.test)
    .replace('{{out}}', `${OUT}/report.json`)
    .replace('{{files}}', files.join(' '))
  const exec = await sandbox.exec({
    image: profile.image,
    cmd: ['sh', '-c', test],
    mounts: [
      { host: ws, container: CONTAINER_ROOT },
      { host: out, container: OUT },
    ],
    volumes: opts.deps.volumes,
    tmpfs: opts.deps.scratch,
    network: 'none', // verification is offline: deps come from the volume
    workdir: CONTAINER_ROOT,
    limits: { timeout_s: opts.timeout_s ?? 900 },
  })
  if (process.env.TILLER_DEBUG) console.error(`--- ${test}\n${exec.stdout}\n${exec.stderr}`)
  const raw = await readFile(join(out, 'report.json'), 'utf8').catch(() => null)
  await rm(out, { recursive: true, force: true })
  if (!raw) return { cases: null, exec }
  const parser = opts.suite?.parser ?? profile.parser
  // a report the parser cannot read is no report: the caller treats it as an error, not a pass
  try {
    const cases =
      parser === 'go-test-json'
        ? parseGoTestJson(raw)
        : parser === 'junit-xml'
          ? parseJUnitXml(raw)
          : parseVitestJson(raw, CONTAINER_ROOT)
    return { cases, exec }
  } catch {
    return { cases: null, exec }
  }
}
