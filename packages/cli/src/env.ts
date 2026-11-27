import { createHash, randomBytes } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DockerGateway,
  DockerRegistryProxy,
  DockerSandbox,
  Factory,
  GitHubForge,
  GitHubIssues,
  GitWorkspaces,
  InClusterApi,
  inClusterNamespace,
  KubernetesSandbox,
  type ModelGateway,
  PRICES,
  type PreflightLimits,
  PreflightLimitsSchema,
  type Prices,
  PricesSchema,
  type Project,
  ProjectSchema,
  RepoProfileSchema,
  ServiceGateway,
  ServiceRegistryProxy,
  Store,
  type WorkerSandbox,
  WorkItems,
} from '@codetiller/core'
import { parse } from 'yaml'

/** Where tiller is installed (the checkout, or the image's install dir): `images/`, `defaults/`. */
export const ROOT = fileURLToPath(new URL('../../../', import.meta.url))

/**
 * What ships with tiller: default configs, prompts and skills. The working dir holds what an
 * installation changed or added.
 */
export const DEFAULTS = resolve(ROOT, 'defaults')

/** A file of the working dir, or the one of that name tiller ships with. */
export const own = (...rel: string[]) =>
  existsSync(resolve(...rel)) ? resolve(...rel) : resolve(DEFAULTS, ...rel)

/** Where a skill `name@N` is looked for: the working dir first. */
export const SKILL_DIRS = [resolve('skills'), resolve(DEFAULTS, 'skills')]

export const loadProfile = async (dir: string) =>
  RepoProfileSchema.parse(parse(await readFile(resolve(dir, 'profile.yaml'), 'utf8')))

/**
 * Where sandboxes run. Default: containers of the docker daemon of this machine. With
 * `TILLER_SANDBOX=kubernetes`: pods of the cluster and namespace tiller itself runs in, where the
 * model gateway and the registry proxy are Deployments somebody installed (deploy/kubernetes).
 */
export const ON_KUBERNETES = process.env.TILLER_SANDBOX === 'kubernetes'

/** `http://name:port` with the name resolved: sandbox pods have no DNS. */
export async function byAddress(url: string): Promise<URL> {
  const u = new URL(url)
  u.hostname = (await lookup(u.hostname, { family: 4 })).address
  return u
}

/** What the factory needs to know about its cluster; `problem` when it could not find out. */
export async function kubernetes() {
  const gatewayUrl = process.env.TILLER_GATEWAY_URL ?? 'http://tiller-gateway:8080'
  const registryUrl = process.env.TILLER_REGISTRY_URL ?? 'http://tiller-registry:8081'
  const adminToken = process.env.TILLER_GATEWAY_ADMIN_TOKEN ?? ''
  const base = { gatewayUrl, adminToken, claim: process.env.TILLER_CLAIM ?? 'tiller-home' }
  try {
    if (adminToken.length < 32)
      throw new Error('TILLER_GATEWAY_ADMIN_TOKEN is not set (the secret the gateway also has)')
    const [gateway, registry] = await Promise.all([byAddress(gatewayUrl), byAddress(registryUrl)])
    const health = (u: URL) => new URL('/healthz', u).href
    return {
      ...base,
      api: new InClusterApi(),
      namespace: inClusterNamespace(),
      gateway,
      registry,
      // Before it runs anything, every pod checks that the cluster's API is out of its reach
      // (its network policy is in place), and an agent or an install that its one way out works.
      networks: {
        '*': {
          closed: `https://${process.env.KUBERNETES_SERVICE_HOST}:${process.env.KUBERNETES_SERVICE_PORT ?? 443}/version`,
        },
        'tiller-agents': { open: health(gateway) },
        'tiller-install': { open: health(registry) },
      },
    }
  } catch (e) {
    return { ...base, problem: (e as Error).message }
  }
}
export const KUBE = ON_KUBERNETES ? await kubernetes() : undefined

export function kube() {
  if (!KUBE || 'problem' in KUBE)
    throw new Error(`Kubernetes: ${KUBE?.problem ?? 'TILLER_SANDBOX is not kubernetes'}`)
  return KUBE
}

/**
 * Agents reach the model through a gateway container and nothing else, and never hold the
 * key. `TILLER_EGRESS=direct` opts out (key in the agent's env, open network): for debugging only.
 * On Kubernetes the gateway is a Deployment that holds the key; the factory has none.
 */
export function modelGateway(key: string): ModelGateway | undefined {
  if (ON_KUBERNETES) {
    const k = kube()
    return new ServiceGateway({
      url: k.gatewayUrl,
      agentUrl: k.gateway.origin,
      adminToken: k.adminToken,
    })
  }
  if (process.env.TILLER_EGRESS === 'direct') {
    console.error('TILLER_EGRESS=direct: agents get the model key and open network access')
    return undefined
  }
  return new DockerGateway({
    key,
    script: resolve(ROOT, 'images', 'gateway', 'gateway.mjs'),
  })
}

/**
 * The UI's API token: made once, kept in a file only this user can read (`.cache/ui-token`), so
 * the printed link keeps working across restarts. Never mounted into a container. Delete the
 * file to get a new one.
 */
export function uiToken(): string {
  const file = resolve('.cache', 'ui-token')
  try {
    const token = readFileSync(file, 'utf8').trim()
    if (/^[0-9a-f]{48,}$/.test(token)) return token
  } catch {}
  const token = randomBytes(32).toString('hex')
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${token}\n`, { mode: 0o600 })
  chmodSync(file, 0o600)
  return token
}

/** Model prices the gateway budgets with: the built-in list, with tiller.yaml `prices` on top. */
export function loadPrices(): Prices {
  let raw = ''
  try {
    raw = readFileSync(resolve('tiller.yaml'), 'utf8')
  } catch {}
  const own = (parse(raw) as { prices?: unknown } | null)?.prices
  return { ...PRICES, ...PricesSchema.parse(own ?? {}) }
}

/**
 * The sandbox every command uses. Dependency installs reach the package registries through a
 * read-only proxy on a closed network (`TILLER_EGRESS=direct`: open network, without the gateway).
 */
export function dockerSandbox(owner?: string): WorkerSandbox {
  if (ON_KUBERNETES) {
    const k = kube()
    return new KubernetesSandbox({
      api: k.api,
      namespace: k.namespace,
      home: resolve('.'),
      claim: k.claim,
      registry: new ServiceRegistryProxy(async () => k.registry.hostname),
      owner,
      // next to the factory's own pod: one node mounts the claim
      colocate: { 'app.kubernetes.io/name': 'tiller' },
      networks: k.networks,
    })
  }
  if (process.env.TILLER_EGRESS === 'direct') return new DockerSandbox({ owner })
  return new DockerSandbox({ registry: registryProxy(), owner })
}

/** The worker of this working dir, as the label of the containers it starts. */
export const workerName = () => createHash('sha256').update(resolve('.')).digest('hex').slice(0, 12)

export const registryProxy = () =>
  new DockerRegistryProxy({
    script: resolve(ROOT, 'images', 'gateway', 'registry.mjs'),
  })

export function stringList(v: unknown, what: string): string[] {
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string'))
    throw new Error(`tiller.yaml ${what} must be a list of strings`)
  return v as string[]
}

/**
 * tiller.yaml `factory`: `projects` (intake; none = no intake) and `preflight` limits (defaults
 * apply without the section; `enabled: false` turns the assessment off).
 */
export function loadFactoryConfig(): {
  projects: Project[]
  preflight: PreflightLimits
  skills: string[]
  models: string[]
  review: { enabled: boolean }
  ci: { fix: 'ask' | 'auto' | 'off'; max_attempts: number }
} {
  let raw = ''
  try {
    raw = readFileSync(resolve('tiller.yaml'), 'utf8')
  } catch {}
  const factory = (
    parse(raw) as {
      factory?: {
        projects?: unknown
        preflight?: unknown
        skills?: unknown
        models?: unknown
        review?: { enabled?: unknown }
        ci?: { fix?: unknown; max_attempts?: unknown }
      }
    } | null
  )?.factory
  return {
    projects: ProjectSchema.array().parse(factory?.projects ?? []),
    preflight: PreflightLimitsSchema.parse(factory?.preflight ?? {}),
    // factory skills every task gets; empty until one has passed the eval gate
    skills: stringList(factory?.skills ?? [], 'factory.skills'),
    // models a human may choose for a task or as the default, in place of a config's own
    models: stringList(factory?.models ?? [], 'factory.models'),
    // second reader of every verified change; off unless tiller.yaml turns it on
    review: { enabled: factory?.review?.enabled === true },
    // what to do when the repository's CI fails on a task's PR; a human decides unless told otherwise
    ci: {
      fix: factory?.ci?.fix === 'auto' || factory?.ci?.fix === 'off' ? factory.ci.fix : 'ask',
      max_attempts:
        typeof factory?.ci?.max_attempts === 'number' && factory.ci.max_attempts > 0
          ? Math.floor(factory.ci.max_attempts)
          : 2,
    },
  }
}

/**
 * Factory over tiller.db; agents run only when ANTHROPIC_API_KEY is set. With
 * TILLER_GITHUB_TOKEN (never passed to the agent) branches are pushed, draft PRs opened and
 * labelled issues of the tiller.yaml projects imported.
 */
export function openFactory(
  log: (m: string) => void = console.log,
  opts: { worker?: boolean } = {},
) {
  const store = new Store(resolve('tiller.db'), resolve('artifacts'))
  // the worker's containers are marked as its own: see `runWorker`
  const sandbox = dockerSandbox(opts.worker ? workerName() : undefined)
  // on Kubernetes the model key is the gateway's alone: the factory runs agents without it
  const key = process.env.ANTHROPIC_API_KEY ?? (ON_KUBERNETES ? '' : undefined)
  const githubToken = process.env.TILLER_GITHUB_TOKEN
  const forge = githubToken ? new GitHubForge(githubToken) : undefined
  const factory = new Factory({
    items: new WorkItems(store),
    sandbox,
    // clones and fetches as the factory, not as whoever's git is configured on this machine
    workspaces: new GitWorkspaces(resolve('.cache'), { auth: forge?.gitAuth() }),
    root: resolve('.'),
    defaults: DEFAULTS,
    env: key === undefined ? undefined : key ? { ANTHROPIC_API_KEY: key } : {},
    gateway: key === undefined ? undefined : modelGateway(key),
    prices: loadPrices(),
    forge,
    tracker: githubToken ? new GitHubIssues(githubToken) : undefined,
    ...loadFactoryConfig(),
    maxConcurrent: 2,
    log,
  })
  return { store, factory, sandbox }
}

/**
 * Start the worker of this working dir, and return how to stop it. A sandbox container outlives
 * the `docker run` that started it: when the factory stops, it ends its containers itself; when
 * it was killed instead, the next start removes what it left running. Either way no agent goes
 * on spending, or writing into a workspace, with nobody waiting for it.
 */
export async function runWorker(factory: Factory, sandbox: WorkerSandbox) {
  const left = await sandbox.reap()
  if (left) console.log(`removed ${left} container(s) a previous run of the factory left behind`)
  factory.start()
  return async () => {
    factory.stop()
    const ended = await sandbox.killAll()
    if (ended) console.log(`stopped ${ended} running container(s)`)
    // each interrupted run writes down how it ended before the database closes
    await factory.idle()
  }
}

/** Two benchmarks of one dataset paired per task: all tasks, and without the underspecified ones. */
