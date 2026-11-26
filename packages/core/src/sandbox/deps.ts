import { access, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { RepoProfile, Toolchain } from '../profile/profile.js'
import { sha256 } from '../util/hash.js'
import type { Sandbox } from './sandbox.js'

const WORKSPACE = '/workspace'
const MARKER = '.tiller-ready-v2'
// tool caches written at runtime inside node_modules; pre-created so tmpfs can mount over them
// in the read-only volume
const SCRATCH = ['.vite-temp', '.vite', '.cache']

export interface DepsMount {
  /** every volume of installed dependencies: mounted read-only into agent and test containers */
  volumes: { name: string; container: string; readonly: true }[]
  /** writable scratch dirs inside those volumes */
  scratch: string[]
  toolchain: Toolchain
}

/** One dependency install: the main toolchain's, or that of a suite with a lockfile of its own. */
interface Install {
  /** what distinguishes it in volume names; '' = the main toolchain */
  label: string
  lockfile: string
  setup: string
  deps: string[]
  cache?: { volume: string; path: string }
}

const exists = (p: string) =>
  access(p).then(
    () => true,
    () => false,
  )

/** Pick the toolchain whose lockfile exists in the workspace (repos migrate package managers). */
export async function resolveToolchain(profile: RepoProfile, ws: string): Promise<Toolchain> {
  for (const t of profile.toolchains) if (await exists(join(ws, t.lockfile))) return t
  throw new Error(
    `no known lockfile in ${ws} (${profile.toolchains.map((t) => t.lockfile).join(', ')})`,
  )
}

/** a dependency path of the profile as a path in the container */
const inContainer = (p: string) => (p.startsWith('/') ? p : `${WORKSPACE}/${p}`)

/**
 * Installed deps live in named volumes keyed by lockfile hash: installed once, then mounted
 * read-only into agent + verify containers (bind-mount installs on macOS take minutes).
 */
const inflight = new Map<string, Promise<DepsMount['volumes']>>()

/** Concurrency-safe: parallel runs needing the same volumes share one install. */
export async function ensureDeps(
  sandbox: Sandbox,
  profile: RepoProfile,
  ws: string,
  repo: string,
  log: (m: string) => void = () => {},
): Promise<DepsMount> {
  const toolchain = await resolveToolchain(profile, ws)
  const slug = repo.replace('/', '-')
  const installs: Install[] = [{ label: '', ...toolchain }]
  // a suite with a lockfile and a setup installs its own dependencies (a second language)
  for (const s of profile.suites)
    if (s.lockfile && s.setup && (await exists(join(ws, s.lockfile))))
      installs.push({
        label: s.name,
        lockfile: s.lockfile,
        setup: s.setup,
        deps: s.deps ?? ['node_modules'],
        cache: s.cache,
      })
  const volumes: DepsMount['volumes'] = []
  for (const install of installs) {
    const lock = await readFile(join(ws, install.lockfile), 'utf8')
    // What is installed where is part of the identity: a profile that adds a path or changes the
    // install must not find the volumes of the old one "ready". The plain node_modules case
    // keeps the name it always had (the lockfile alone), so existing volumes stay valid.
    const plain = install.deps.length === 1 && install.deps[0] === 'node_modules'
    const key = plain ? lock : `${lock}\n${install.setup}\n${install.deps.join('\n')}`
    const base = `tiller-deps-${slug}-${sha256(key).slice(0, 12)}${install.label ? `-${install.label.replace(/[^\w.-]/g, '_')}` : ''}`
    let p = inflight.get(base)
    if (!p) {
      p = installDeps(sandbox, profile, ws, base, install, slug, log)
      inflight.set(base, p)
      p.catch(() => inflight.delete(base))
    }
    volumes.push(...(await p))
  }
  const scratch = volumes
    .filter((v) => v.container.endsWith('/node_modules'))
    .flatMap((v) => SCRATCH.map((d) => `${v.container}/${d}`))
  return { volumes, scratch, toolchain }
}

async function installDeps(
  sandbox: Sandbox,
  profile: RepoProfile,
  ws: string,
  base: string,
  install: Install,
  repoSlug: string,
  log: (m: string) => void,
): Promise<DepsMount['volumes']> {
  const mounts = [{ host: ws, container: WORKSPACE }]
  // the first path keeps the plain name (volumes made before there could be several)
  const volumes = install.deps.map((path, i) => ({
    name: i === 0 ? base : `${base}-${sha256(path).slice(0, 6)}`,
    container: inContainer(path),
  }))
  const first = volumes[0] as (typeof volumes)[number]
  const marker = `${first.container}/${MARKER}`
  // the package manager's cache, one per repository: an install driven by one repo's agent must
  // not write into what another repo's installs read from
  const cache = install.cache
    ? [{ name: `${install.cache.volume}-${repoSlug}`, container: install.cache.path }]
    : []
  // An install runs code the agent chose (install scripts, an edited lockfile): it reaches the
  // registries through the proxy and nothing else. Without a proxy (tests, opt-out): open network.
  const access = await sandbox.installAccess?.()
  const check = await sandbox.exec({
    image: profile.image,
    cmd: ['test', '-f', marker],
    mounts,
    volumes: [first],
    network: 'none',
    limits: { timeout_s: 60 },
  })
  if (check.exitCode !== 0) {
    log(`deps: ${install.lockfile} → volume ${base} (one-off install)`)
    // fresh volumes are root-owned, the cache's too when the image has no such directory
    if (sandbox.ownVolumes) await sandbox.ownVolumes([...volumes, ...cache])
    else
      await sandbox.exec({
        image: profile.image,
        user: '0:0',
        caps: ['CHOWN'],
        cmd: ['chown', '1000:1000', ...[...volumes, ...cache].map((v) => v.container)],
        mounts,
        volumes: [...volumes, ...cache],
        network: 'none',
        limits: { timeout_s: 60 },
      })
    const scratch = volumes
      .filter((v) => v.container.endsWith('/node_modules'))
      .flatMap((v) => SCRATCH.map((d) => `${v.container}/${d}`))
    const after = [...(scratch.length ? [`mkdir -p ${scratch.join(' ')}`] : []), `touch ${marker}`]
    const res = await sandbox.exec({
      image: profile.image,
      // subshell: a setup that ends with `exit` must not skip the marker
      cmd: ['sh', '-c', `(${install.setup}) && ${after.join(' && ')}`],
      mounts,
      volumes: [...volumes, ...cache],
      workdir: WORKSPACE,
      network: access?.network,
      env: {
        ...access?.env,
        // pnpm 12 reads its own prefix: without this its store is a directory of the container
        // that goes away with it, and the store volume stays empty
        ...(install.cache && install.lockfile.endsWith('pnpm-lock.yaml')
          ? { pnpm_config_store_dir: install.cache.path }
          : {}),
      },
      limits: { timeout_s: 1800 },
    })
    if (res.exitCode !== 0)
      throw new Error(`deps install failed: ${`${res.stdout}\n${res.stderr}`.trim().slice(-1500)}`)
  }
  return volumes.map((v) => ({ ...v, readonly: true as const }))
}
