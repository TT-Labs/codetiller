import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { ExecRequest, ExecResult, Sandbox } from '../sandbox/sandbox.js'
import { type DoctorInput, doctor, doctorOk, renderDoctor } from './doctor.js'

const done = (stdout: string): ExecResult => ({
  exitCode: 0,
  timedOut: false,
  stdout,
  stderr: '',
  duration_s: 0,
})

/** A docker host: `sees` = does the daemon have the factory's directory at the same path. */
const host = (opts: { sees?: boolean; writes?: boolean } = {}): Sandbox => ({
  imageId: async () => 'sha256:0123456789abcdef',
  exec: async (req: ExecRequest) => {
    const dir = req.mounts?.[0]?.host as string
    const nonce = req.cmd.at(-1) as string
    if (opts.sees === false) return done('seen=\nwritten=yes\n')
    const seen = await readFile(join(dir, 'from-factory'), 'utf8')
    if (opts.writes === false) return done(`seen=${seen}\nwritten=no\n`)
    await mkdir(join(dir, 'made'))
    await writeFile(join(dir, 'made', 'from-container'), nonce)
    return done(`seen=${seen}\nwritten=yes\n`)
  },
})

const input = async (over: Partial<DoctorInput> = {}): Promise<DoctorInput> => ({
  home: await mkdtemp(join(tmpdir(), 'tiller-doctor-')),
  sandbox: host(),
  image: 'codetiller/base:dev',
  runtime: {
    name: 'docker',
    version: async () => 'daemon 29.5.2 linux/arm64\n',
    fix: 'start docker',
  },
  imageFix: 'tiller setup',
  sharedFix: 'mount it at the path it has on the docker host',
  git: async () => 'git version 2.47.0\n',
  uid: 1000,
  modelKey: true,
  forgeToken: true,
  repos: ['o/r'],
  repoAccess: async () => ({ push: true, ci: true }),
  schema: 1,
  freeBytes: async () => 50 * 1024 ** 3,
  ...over,
})

const by = (checks: Awaited<ReturnType<typeof doctor>>) =>
  Object.fromEntries(checks.map((c) => [c.name, c.status]))

it('an installation with everything in place is ready', async () => {
  const checks = await doctor(await input())
  expect(by(checks)).toEqual({
    docker: 'ok',
    git: 'ok',
    'sandbox image': 'ok',
    workspaces: 'ok',
    database: 'ok',
    disk: 'ok',
    'model key': 'ok',
    'forge token': 'ok',
    'repo o/r': 'ok',
  })
  expect(doctorOk(checks)).toBe(true)
  expect(renderDoctor(checks).split('\n').at(-1)).toBe('ready')
})

it('a factory in a container that mounts its directory elsewhere is told so', async () => {
  const checks = await doctor(await input({ sandbox: host({ sees: false }) }))
  const ws = checks.find((c) => c.name === 'workspaces')
  expect(ws?.status).toBe('FAIL')
  expect(ws?.detail).toContain('a container does not see')
  expect(ws?.fix).toBe('mount it at the path it has on the docker host')
  expect(doctorOk(checks)).toBe(false)
})

it('a factory that is not the sandbox user is told that containers cannot write', async () => {
  const checks = await doctor(await input({ sandbox: host({ writes: false }), uid: 1001 }))
  const ws = checks.find((c) => c.name === 'workspaces')
  expect(ws?.status).toBe('FAIL')
  expect(ws?.detail).toBe(
    'containers run as uid 1000 and cannot write into a workspace tiller (uid 1001) made',
  )
})

it('without docker nothing behind it is probed; a missing image names the command', async () => {
  const down = await doctor(
    await input({
      runtime: {
        name: 'docker',
        version: async () => {
          throw new Error('Cannot connect to the Docker daemon at unix:///var/run/docker.sock')
        },
        fix: 'start docker',
      },
    }),
  )
  expect(by(down).docker).toBe('FAIL')
  expect(by(down)['sandbox image']).toBeUndefined()
  expect(by(down).workspaces).toBeUndefined()

  const bare = await doctor(await input({ sandbox: { ...host(), imageId: async () => null } }))
  expect(bare.find((c) => c.name === 'sandbox image')?.fix).toBe('tiller setup')
  expect(by(bare).workspaces).toBeUndefined()
})

it('missing credentials and thin permissions: what works without them, what does not', async () => {
  const checks = await doctor(
    await input({
      modelKey: false,
      repos: ['o/r', 'o/gone', 'o/readonly'],
      repoAccess: async (repo) => {
        if (repo === 'o/gone') throw new Error('GitHub GET /repos/o/gone: 404 Not Found')
        if (repo === 'o/readonly') return { push: false, ci: true }
        return { push: true, ci: '403' }
      },
      freeBytes: async () => 2 * 1024 ** 3,
    }),
  )
  expect(by(checks)).toMatchObject({
    'model key': 'FAIL',
    disk: 'warn',
    'repo o/r': 'warn',
    'repo o/gone': 'FAIL',
    'repo o/readonly': 'FAIL',
  })
  const text = renderDoctor(checks)
  expect(text).toContain('CI is not readable (403)')
  expect(text.split('\n').at(-1)).toBe('3 checks failed')

  const none = await doctor(await input({ forgeToken: false }))
  expect(by(none)['forge token']).toBe('warn')
  // nothing to ask the forge with
  expect(by(none)['repo o/r']).toBeUndefined()
  expect(renderDoctor(none).split('\n').at(-1)).toBe('ready (1 warning)')
})

it('where an image cannot be asked for up front (Kubernetes), the probe pod says what is wrong', async () => {
  const cluster = {
    runtime: { name: 'kubernetes', version: async () => 'cluster v1.35', fix: 'kubectl apply' },
    imageFix: undefined,
  }
  const fine = await doctor(await input(cluster))
  expect(by(fine)).toMatchObject({ kubernetes: 'ok', workspaces: 'ok' })
  expect(by(fine)['sandbox image']).toBeUndefined()

  const open = await doctor(
    await input({
      ...cluster,
      sandbox: {
        exec: async () => ({
          ...done(''),
          exitCode: 126,
          stderr:
            'tiller: this pod can reach http://10.43.0.9:8080/healthz, which its network policy forbids: the cluster does not enforce NetworkPolicy; nothing was run',
        }),
      },
    }),
  )
  const ws = open.find((c) => c.name === 'workspaces')
  expect(ws?.status).toBe('FAIL')
  expect(ws?.detail).toContain('the cluster does not enforce NetworkPolicy')
})
