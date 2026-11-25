import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { RepoProfileSchema } from '../dataset/task.js'
import { ensureDeps } from './deps.js'
import type { ExecRequest, Sandbox } from './sandbox.js'

const profile = RepoProfileSchema.parse({
  image: 'i',
  toolchains: [
    {
      lockfile: 'pnpm-lock.yaml',
      setup: 'pnpm install --frozen-lockfile',
      test: 't',
      cache: { volume: 'tiller-pnpm-store', path: '/home/node/.pnpm-store' },
    },
  ],
  parser: 'vitest-json',
})

/** a sandbox whose dependency volume is empty: the marker check fails, so an install follows */
function recorder(access?: Awaited<ReturnType<NonNullable<Sandbox['installAccess']>>>) {
  const requests: ExecRequest[] = []
  const sandbox: Sandbox = {
    exec: async (req) => {
      requests.push(req)
      const cold = req.cmd[0] === 'test'
      return { exitCode: cold ? 1 : 0, timedOut: false, stdout: '', stderr: '', duration_s: 0 }
    },
    ...(access ? { installAccess: async () => access } : {}),
  }
  return { sandbox, requests }
}

const workspace = (lock: string) => {
  const ws = mkdtempSync(join(tmpdir(), 'tiller-deps-'))
  writeFileSync(join(ws, 'pnpm-lock.yaml'), lock)
  return ws
}

it('an install reaches the registry proxy only, with a package store of its repository', async () => {
  const { sandbox, requests } = recorder({
    network: 'tiller-install',
    env: { pnpm_config_registry: 'http://tiller-registry:8081/npm/' },
  })
  const nm = await ensureDeps(sandbox, profile, workspace('lock-a'), 'o/r')
  const install = requests.find((r) => r.cmd.join(' ').includes('pnpm install')) as ExecRequest
  expect(install.network).toBe('tiller-install')
  expect(install.env).toEqual({
    pnpm_config_registry: 'http://tiller-registry:8081/npm/',
    // without it pnpm 12 keeps its store inside the container and the volume stays empty
    pnpm_config_store_dir: '/home/node/.pnpm-store',
  })
  expect(install.volumes).toEqual([
    { name: nm.volumes[0]?.name, container: '/workspace/node_modules' },
    { name: 'tiller-pnpm-store-o-r', container: '/home/node/.pnpm-store' },
  ])
  // the steps around it need no network at all
  expect(requests.filter((r) => r !== install).map((r) => r.network)).toEqual(['none', 'none'])
  // another repository gets another store
  const other = recorder({ network: 'tiller-install', env: {} })
  await ensureDeps(other.sandbox, profile, workspace('lock-b'), 'x/y')
  expect(
    other.requests.find((r) => r.cmd.join(' ').includes('pnpm install'))?.volumes?.[1]?.name,
  ).toBe('tiller-pnpm-store-x-y')
})

it('without a registry proxy the install runs on the open network, as before', async () => {
  const { sandbox, requests } = recorder()
  await ensureDeps(sandbox, profile, workspace('lock-c'), 'o/r')
  const install = requests.find((r) => r.cmd.join(' ').includes('pnpm install')) as ExecRequest
  expect(install.network).toBeUndefined()
  expect(install.env).toEqual({ pnpm_config_store_dir: '/home/node/.pnpm-store' })
})

it('dependencies can live anywhere: a venv, a module cache, and a second language with its own install', async () => {
  const poly = RepoProfileSchema.parse({
    image: 'i',
    toolchains: [
      {
        lockfile: 'go.sum',
        setup: 'go mod download',
        test: 't',
        deps: ['/home/node/go/pkg/mod'],
      },
    ],
    parser: 'go-test-json',
    suites: [
      {
        name: 'api tests',
        test: 'cd api && .venv/bin/pytest --junitxml={{out}}',
        parser: 'junit-xml',
        lockfile: 'api/requirements.txt',
        setup: 'cd api && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt',
        deps: ['api/.venv', 'api/.tools'],
        cache: { volume: 'tiller-pip-cache', path: '/home/node/.cache/pip' },
      },
      // a suite without an install of its own shares what is there
      { name: 'lint', test: 'x', parser: 'junit-xml' },
    ],
  })
  const { sandbox, requests } = recorder({ network: 'tiller-install', env: {} })
  const ws = mkdtempSync(join(tmpdir(), 'tiller-deps-'))
  writeFileSync(join(ws, 'go.sum'), 'sum')
  mkdirSync(join(ws, 'api'))
  writeFileSync(join(ws, 'api', 'requirements.txt'), 'pytest')
  const nm = await ensureDeps(sandbox, poly, ws, 'o/r')
  expect(nm.volumes.map((v) => [v.container, v.readonly])).toEqual([
    ['/home/node/go/pkg/mod', true],
    ['/workspace/api/.venv', true],
    ['/workspace/api/.tools', true],
  ])
  // names: per lockfile content, the suite's carry its name, further paths a suffix
  expect(nm.volumes[0]?.name).toMatch(/^tiller-deps-o-r-[0-9a-f]{12}$/)
  expect(nm.volumes[1]?.name).toMatch(/^tiller-deps-o-r-[0-9a-f]{12}-api_tests$/)
  expect(nm.volumes[2]?.name).toMatch(/^tiller-deps-o-r-[0-9a-f]{12}-api_tests-[0-9a-f]{6}$/)
  // nothing JS here: no scratch dirs, and no pnpm setting
  expect(nm.scratch).toEqual([])
  const installs = requests.filter((r) => r.network === 'tiller-install')
  expect(installs.map((r) => r.cmd.at(-1))).toEqual([
    '(go mod download) && touch /home/node/go/pkg/mod/.tiller-ready-v2',
    '(cd api && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt) && touch /workspace/api/.venv/.tiller-ready-v2',
  ])
  expect(installs[0]?.env).toEqual({})
  expect(installs[1]?.volumes?.at(-1)).toEqual({
    name: 'tiller-pip-cache-o-r',
    container: '/home/node/.cache/pip',
  })
  // the cache volume is given to the node user like the dependency volumes
  const chown = requests.find((r) => r.cmd[0] === 'chown' && r.cmd.includes('/workspace/api/.venv'))
  expect(chown?.cmd).toEqual([
    'chown',
    '1000:1000',
    '/workspace/api/.venv',
    '/workspace/api/.tools',
    '/home/node/.cache/pip',
  ])
  // a profile that installs the same lockfile somewhere else gets volumes of its own
  const moved = RepoProfileSchema.parse({
    ...poly,
    toolchains: [{ ...poly.toolchains[0], deps: ['/home/node/go/pkg/mod', 'vendor'] }],
  })
  const again = await ensureDeps(recorder().sandbox, moved, ws, 'o/r')
  expect(again.volumes[0]?.name).not.toBe(nm.volumes[0]?.name)
  // a suite whose lockfile is not in this commit is not installed
  const later = recorder({ network: 'tiller-install', env: {} })
  const bare = mkdtempSync(join(tmpdir(), 'tiller-deps-'))
  writeFileSync(join(bare, 'go.sum'), 'other')
  expect((await ensureDeps(later.sandbox, poly, bare, 'o/r')).volumes).toHaveLength(1)
})
