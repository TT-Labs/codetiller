import { randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, statfs, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Sandbox } from '../sandbox/sandbox.js'

/**
 * `tiller doctor`: what an installation needs before its first task, each measured, none assumed.
 * No model call, no change outside a scratch directory of the working dir.
 */
export interface DoctorCheck {
  name: string
  /** `warn` = the factory works without it, with less; `FAIL` = tasks cannot run */
  status: 'ok' | 'warn' | 'FAIL'
  detail: string
  /** what to do about it */
  fix?: string
}

export interface RepoAccess {
  /** the role the forge reports for the token allows pushing branches */
  push: boolean
  /** the repository's CI is readable; a string = why not */
  ci: true | string
}

export interface DoctorInput {
  /** the working dir: database, artifacts, `.cache/` with repositories and workspaces */
  home: string
  sandbox: Sandbox
  /** the image a repository without one of its own runs in */
  image: string
  /** what runs the sandboxes (docker, kubernetes): `version` rejects when it does not answer */
  runtime: { name: string; version: () => Promise<string>; fix: string }
  /** how to get the sandbox image when it is missing; absent = it cannot be asked for up front */
  imageFix?: string
  /** what to do when a container does not see the working dir where the factory has it */
  sharedFix: string
  /** version of git on this machine; rejects when there is none */
  git: () => Promise<string>
  /** uid the factory runs as */
  uid: number
  /** is the model key set (a text = where it is, when not with the factory); never the value */
  modelKey: boolean | string
  forgeToken: boolean
  /** onboarded repositories, and what the forge token may do in one */
  repos: string[]
  repoAccess?: (repo: string) => Promise<RepoAccess>
  /** schema version of the database */
  schema: number
  /** free bytes on the filesystem of the working dir */
  freeBytes?: () => Promise<number>
}

/** uid of the user every sandbox container runs as (`node` in the base image) */
export const SANDBOX_UID = 1000
const GB = 1024 ** 3
const MIN_FREE_GB = 10

const message = (e: unknown) =>
  (e instanceof Error ? e.message : String(e)).trim().split('\n').pop()?.slice(0, 300) ?? ''

/**
 * A workspace is a directory of the factory, mounted into containers by its path. That holds
 * only when the docker daemon sees the same directory under the same path (not so when the
 * factory runs in a container that mounts it elsewhere) and when the container's user may write
 * what the factory made, and the factory may remove what the container wrote.
 */
async function workspaceCheck(input: DoctorInput): Promise<DoctorCheck> {
  const name = 'workspaces'
  const work = join(input.home, '.cache', 'work')
  let dir: string
  try {
    await mkdir(work, { recursive: true })
    dir = await mkdtemp(join(work, 'doctor-'))
  } catch (e) {
    return {
      name,
      status: 'FAIL',
      detail: `${input.home} is not writable: ${message(e)}`,
      fix: `give ${input.home} to uid ${input.uid}, the user tiller runs as`,
    }
  }
  const nonce = randomBytes(8).toString('hex')
  try {
    await writeFile(join(dir, 'from-factory'), nonce)
    const res = await input.sandbox.exec({
      image: input.image,
      cmd: [
        'sh',
        '-c',
        'printf "seen=%s\\n" "$(cat /probe/from-factory 2>/dev/null)"; mkdir /probe/made 2>/dev/null && printf %s "$1" > /probe/made/from-container && echo written=yes || echo written=no',
        'probe',
        nonce,
      ],
      mounts: [{ host: dir, container: '/probe' }],
      network: 'none',
      limits: { timeout_s: 60 },
    })
    const out = res.stdout
    if (res.exitCode === null || !out.includes('seen='))
      return {
        name,
        status: 'FAIL',
        detail: `a container could not be started on ${dir}: ${message(res.stderr) || `exit ${res.exitCode}`}`,
      }
    if (!out.includes(`seen=${nonce}`))
      return {
        name,
        status: 'FAIL',
        detail: `a container does not see ${input.home} as tiller sees it: a workspace mounted into it would be empty`,
        fix: input.sharedFix,
      }
    if (!out.includes('written=yes'))
      return {
        name,
        status: 'FAIL',
        detail: `containers run as uid ${SANDBOX_UID} and cannot write into a workspace tiller (uid ${input.uid}) made`,
        fix: `run tiller as uid ${SANDBOX_UID} and give it ${input.home} (chown -R ${SANDBOX_UID}:${SANDBOX_UID})`,
      }
    const back = await readFile(join(dir, 'made', 'from-container'), 'utf8').catch(() => '')
    if (back !== nonce)
      return {
        name,
        status: 'FAIL',
        detail: 'tiller cannot read what a container wrote into a workspace',
        fix: `run tiller as uid ${SANDBOX_UID}`,
      }
    try {
      await rm(join(dir, 'made'), { recursive: true })
    } catch (e) {
      return {
        name,
        status: 'FAIL',
        detail: `tiller cannot remove what a container wrote into a workspace: ${message(e)}`,
        fix: `run tiller as uid ${SANDBOX_UID}`,
      }
    }
    return {
      name,
      status: 'ok',
      detail: `${input.home}: the same files for tiller and a container, written by both`,
    }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

export async function doctor(input: DoctorInput): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = []
  const add = (c: DoctorCheck) => checks.push(c)

  const daemon = await input.runtime.version().then(
    (v) => ({ ok: true, text: v.trim() }),
    (e) => ({ ok: false, text: message(e) }),
  )
  add(
    daemon.ok
      ? { name: input.runtime.name, status: 'ok', detail: daemon.text }
      : {
          name: input.runtime.name,
          status: 'FAIL',
          detail: `${input.runtime.name} does not answer: ${daemon.text}`,
          fix: input.runtime.fix,
        },
  )

  add(
    await input.git().then(
      (v): DoctorCheck => ({ name: 'git', status: 'ok', detail: v.trim() }),
      (e): DoctorCheck => ({
        name: 'git',
        status: 'FAIL',
        detail: `git does not run: ${message(e)}`,
        fix: 'install git',
      }),
    ),
  )

  // where the image can be asked for, a missing one is said plainly; elsewhere the probe pod says it
  const image = daemon.ok && input.imageFix ? await input.sandbox.imageId?.(input.image) : undefined
  if (daemon.ok && input.imageFix)
    add(
      image
        ? { name: 'sandbox image', status: 'ok', detail: `${input.image} (${image.slice(7, 19)})` }
        : {
            name: 'sandbox image',
            status: 'FAIL',
            detail: `${input.image} is not on this ${input.runtime.name} host`,
            fix: input.imageFix,
          },
    )
  if (daemon.ok && (image || !input.imageFix)) add(await workspaceCheck(input))

  add({ name: 'database', status: 'ok', detail: `schema version ${input.schema}` })

  if (input.freeBytes) {
    const free = await input.freeBytes().catch(() => null)
    if (free !== null)
      add({
        name: 'disk',
        status: free < MIN_FREE_GB * GB ? 'warn' : 'ok',
        detail: `${(free / GB).toFixed(1)} GB free in ${input.home}${free < MIN_FREE_GB * GB ? `: repositories, workspaces and transcripts live here (under ${MIN_FREE_GB} GB)` : ''}`,
      })
  }

  add(
    input.modelKey
      ? {
          name: 'model key',
          status: 'ok',
          detail: typeof input.modelKey === 'string' ? input.modelKey : 'ANTHROPIC_API_KEY is set',
        }
      : {
          name: 'model key',
          status: 'FAIL',
          detail: 'ANTHROPIC_API_KEY is not set: tasks can be queued, not run',
          fix: `put it into ${join(input.home, '.env')}`,
        },
  )
  add(
    input.forgeToken
      ? { name: 'forge token', status: 'ok', detail: 'TILLER_GITHUB_TOKEN is set' }
      : {
          name: 'forge token',
          status: 'warn',
          detail:
            'TILLER_GITHUB_TOKEN is not set: no private repositories, no pushes, no pull requests, no issue intake',
          fix: `put it into ${join(input.home, '.env')}`,
        },
  )
  if (input.forgeToken && input.repoAccess)
    for (const repo of input.repos) {
      const name = `repo ${repo}`
      add(
        await input.repoAccess(repo).then(
          (a): DoctorCheck =>
            !a.push
              ? {
                  name,
                  status: 'FAIL',
                  detail:
                    'readable, and the role of the token does not allow a push: no branch, no pull request',
                  fix: 'give the token Contents: write and Pull requests: write on this repository',
                }
              : a.ci === true
                ? { name, status: 'ok', detail: 'readable, role allows a push, CI readable' }
                : {
                    name,
                    status: 'warn',
                    detail: `readable, role allows a push; CI is not readable (${a.ci}): the factory will not see failed checks on its pull requests`,
                    fix: 'give the token Checks, Commit statuses and Actions: read',
                  },
          (e): DoctorCheck => ({
            name,
            status: 'FAIL',
            detail: `the token does not reach it: ${message(e)}`,
            fix: 'add the repository to what the token may access',
          }),
        ),
      )
    }
  return checks
}

export const freeBytesOf = (dir: string) => () =>
  statfs(dir).then((s) => Number(s.bavail) * Number(s.bsize))

export const doctorOk = (checks: DoctorCheck[]) => !checks.some((c) => c.status === 'FAIL')

export function renderDoctor(checks: DoctorCheck[]): string {
  const width = Math.max(...checks.map((c) => c.name.length))
  const lines = checks.map(
    (c) =>
      `${c.status.padEnd(4)} ${c.name.padEnd(width)}  ${c.detail}${c.fix && c.status !== 'ok' ? `\n${' '.repeat(width + 7)}→ ${c.fix}` : ''}`,
  )
  const failed = checks.filter((c) => c.status === 'FAIL').length
  const warned = checks.filter((c) => c.status === 'warn').length
  const verdict = failed
    ? `${failed} check${failed === 1 ? '' : 's'} failed`
    : `ready${warned ? ` (${warned} warning${warned === 1 ? '' : 's'})` : ''}`
  return `${lines.join('\n')}\n\n${verdict}`
}
