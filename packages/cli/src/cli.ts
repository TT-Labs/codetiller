#!/usr/bin/env node
import { execFile, spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { networkInterfaces } from 'node:os'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import {
  type AuditRun,
  auditSandbox,
  auditTask,
  collectEvidence,
  compareRuns,
  configHash,
  DEFAULT_IMAGE,
  DockerGateway,
  DockerRegistryProxy,
  DockerSandbox,
  type Draft,
  detectableDelta,
  doctor,
  doctorOk,
  estimateTokens,
  Factory,
  freeBytesOf,
  GitHubForge,
  GitHubIssues,
  GitWorkspaces,
  gateVerdict,
  generateSkill,
  git,
  IMPROVE_MODEL,
  Improver,
  InClusterApi,
  inClusterNamespace,
  inferFailToPass,
  KubernetesSandbox,
  leakWarnings,
  loadConfig,
  loadLabels,
  loadRunRows,
  loadSkill,
  loadTask,
  type ModelGateway,
  mineCandidates,
  missingCommands,
  modelAccess,
  noiseSummary,
  type Onboarding,
  onboardingOk,
  PRICES,
  type PreflightLimits,
  PreflightLimitsSchema,
  type Prices,
  PricesSchema,
  type Project,
  ProjectSchema,
  patchFiles,
  RepoProfileSchema,
  renderDoctor,
  renderEvidence,
  repeatsFor,
  runBenchmark,
  runTask,
  type Sandbox,
  ServiceGateway,
  ServiceRegistryProxy,
  Store,
  sandboxYaml,
  sanitizeSkill,
  sourceFiles,
  splitTasks,
  taskNoise,
  validateTask,
  type WorkerSandbox,
  WorkItems,
} from '@codetiller/core'
import { startServer } from '@codetiller/server'
import { Command } from 'commander'
import { parse, stringify } from 'yaml'

// secrets (ANTHROPIC_API_KEY) from gitignored .env; real env wins
try {
  process.loadEnvFile('.env')
} catch {}

/**
 * What ships with tiller (the checkout, or the image's install dir): default configs and prompts,
 * the Dockerfile of the sandbox base image. The working dir holds what an installation changed.
 */
const DEFAULTS = fileURLToPath(new URL('../../../', import.meta.url))

/** A file of the working dir, or the one of that name tiller ships with. */
const own = (...rel: string[]) =>
  existsSync(resolve(...rel)) ? resolve(...rel) : resolve(DEFAULTS, ...rel)

const todo = (name: string) => () => {
  console.error(`tiller ${name}: not implemented yet`)
  process.exitCode = 1
}

const loadProfile = async (dir: string) =>
  RepoProfileSchema.parse(parse(await readFile(resolve(dir, 'profile.yaml'), 'utf8')))

/**
 * Where sandboxes run. Default: containers of the docker daemon of this machine. With
 * `TILLER_SANDBOX=kubernetes`: pods of the cluster and namespace tiller itself runs in, where the
 * model gateway and the registry proxy are Deployments somebody installed (deploy/kubernetes).
 */
const ON_KUBERNETES = process.env.TILLER_SANDBOX === 'kubernetes'

/** `http://name:port` with the name resolved: sandbox pods have no DNS. */
async function byAddress(url: string): Promise<URL> {
  const u = new URL(url)
  u.hostname = (await lookup(u.hostname, { family: 4 })).address
  return u
}

/** What the factory needs to know about its cluster; `problem` when it could not find out. */
async function kubernetes() {
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
const KUBE = ON_KUBERNETES ? await kubernetes() : undefined

function kube() {
  if (!KUBE || 'problem' in KUBE)
    throw new Error(`Kubernetes: ${KUBE?.problem ?? 'TILLER_SANDBOX is not kubernetes'}`)
  return KUBE
}

/**
 * Agents reach the model through a gateway container and nothing else, and never hold the
 * key. `TILLER_EGRESS=direct` opts out (key in the agent's env, open network): for debugging only.
 * On Kubernetes the gateway is a Deployment that holds the key; the factory has none.
 */
function modelGateway(key: string): ModelGateway | undefined {
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
    script: fileURLToPath(new URL('../../../images/gateway/gateway.mjs', import.meta.url)),
  })
}

/**
 * The UI's API token: made once, kept in a file only this user can read (`.cache/ui-token`), so
 * the printed link keeps working across restarts. Never mounted into a container. Delete the
 * file to get a new one.
 */
function uiToken(): string {
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
function loadPrices(): Prices {
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
function dockerSandbox(owner?: string): WorkerSandbox {
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
const workerName = () => createHash('sha256').update(resolve('.')).digest('hex').slice(0, 12)

const registryProxy = () =>
  new DockerRegistryProxy({
    script: fileURLToPath(new URL('../../../images/gateway/registry.mjs', import.meta.url)),
  })

function stringList(v: unknown, what: string): string[] {
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string'))
    throw new Error(`tiller.yaml ${what} must be a list of strings`)
  return v as string[]
}

/**
 * tiller.yaml `factory`: `projects` (intake; none = no intake) and `preflight` limits (defaults
 * apply without the section; `enabled: false` turns the assessment off).
 */
function loadFactoryConfig(): {
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
function openFactory(log: (m: string) => void = console.log, opts: { worker?: boolean } = {}) {
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
async function runWorker(factory: Factory, sandbox: WorkerSandbox) {
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
async function loadComparison(store: Store, a: string, b: string, split: string) {
  const find = (name: string) => {
    const bm = store.findBenchmark(name)
    const rec = bm && store.getBenchmark(bm.id)
    if (!rec) throw new Error(`benchmark not found: ${name}`)
    return rec
  }
  const A = find(a)
  const B = find(b)
  if (A.dataset !== B.dataset) throw new Error('benchmarks use different datasets')
  const dir = resolve('datasets', A.dataset)
  let ids: Set<string> | undefined
  if (split !== 'all') {
    const parts = parse(await readFile(resolve(dir, 'split.yaml'), 'utf8')) as Record<
      string,
      string[]
    >
    ids = new Set(parts[split] ?? [])
  }
  const rows = async (id: string) =>
    (await loadRunRows(store, store.runsOf(id))).filter((r) => !ids || ids.has(r.task_id))
  const ra = await rows(A.id)
  const rb = await rows(B.id)
  const { underspecified } = await loadLabels(dir)
  const all = compareRuns(ra, rb)
  const solvable = (r: { task_id: string }) => !(r.task_id in underspecified)
  const rest = compareRuns(ra.filter(solvable), rb.filter(solvable))
  return { A, B, all, sub: rest.tasks < all.tasks ? rest : null }
}

const program = new Command('tiller')
  .description('codetiller — coding agent factory')
  .version('0.0.0')

const dataset = program.command('dataset').description('benchmark datasets')
dataset
  .command('mine <dir>')
  .description('propose task drafts from merged PRs that close an issue and change tests')
  .requiredOption('--repo <repo>')
  .option('--since <date>', 'merged on/after', '2026-07-01')
  .option('--limit <n>', 'max PRs to scan', '300')
  .action(async (dir: string, opts: { repo: string; since: string; limit: string }) => {
    const profile = await loadProfile(dir)
    const inc = profile.test_include ? new RegExp(profile.test_include) : undefined
    const exc = profile.test_exclude ? new RegExp(profile.test_exclude) : undefined
    const existing = new Set(
      (await readdir(resolve(dir, 'tasks')).catch(() => [])).map((f) => f.replace(/\.yaml$/, '')),
    )
    const drafts = await mineCandidates({
      repo: opts.repo,
      since: opts.since,
      limit: Number(opts.limit),
      testFilter: (p) => (!inc || inc.test(p)) && !exc?.test(p),
      log: console.log,
    })
    await mkdir(resolve(dir, 'drafts'), { recursive: true })
    let n = 0
    for (const d of drafts) {
      if (existing.has(d.id)) continue
      await writeFile(resolve(dir, 'drafts', `${d.id}.yaml`), stringify(d, { lineWidth: 0 }))
      n++
    }
    console.log(`${n} new drafts in ${resolve(dir, 'drafts')}`)
  })
dataset
  .command('infer <dir>')
  .description('drafts → tasks: run hidden tests at base/fix, derive fail_to_pass, keep valid ones')
  .option('--repeats <n>', 'determinism repeats', '2')
  .option('--only <id>')
  .action(async (dir: string, opts: { repeats: string; only?: string }) => {
    const profile = await loadProfile(dir)
    const deps = { sandbox: dockerSandbox(), workspaces: new GitWorkspaces(resolve('.cache')) }
    const files = (await readdir(resolve(dir, 'drafts'))).filter((f) => f.endsWith('.yaml'))
    const rejected: Record<string, string> = {}
    const done = new Set(
      (await readdir(resolve(dir, 'tasks'))).map((f) => f.replace(/\.yaml$/, '')),
    )
    for (const f of files) {
      const draft = parse(await readFile(resolve(dir, 'drafts', f), 'utf8')) as Draft
      if (opts.only && draft.id !== opts.only) continue
      if (!opts.only && done.has(draft.id)) continue
      console.log(`infer ${draft.id}`)
      const r = await inferFailToPass(
        draft,
        profile,
        deps,
        Number(opts.repeats),
        console.log,
      ).catch((e: Error) => ({
        ok: false,
        reason: `error: ${e.message.split('\n')[0]}`,
        fail_to_pass: [],
      }))
      if (!r.ok) {
        console.log(`  REJECT ${r.reason}`)
        rejected[draft.id] = r.reason ?? ''
        continue
      }
      const { flags, source_files: _s, pr, ...rest } = draft
      const task = {
        ...rest,
        fail_to_pass: r.fail_to_pass,
        pass_to_pass: 'suite',
        tags: ['bugfix'],
      }
      const header = [`# mined from PR #${pr}`, ...flags.map((x) => `# REVIEW: ${x}`)].join('\n')
      await writeFile(
        resolve(dir, 'tasks', `${draft.id}.yaml`),
        `${header}\n${stringify(task, { lineWidth: 0 })}`,
      )
      console.log(
        `  TASK ${r.fail_to_pass.length} fail_to_pass${flags.length ? ' (needs review)' : ''}`,
      )
    }
    await writeFile(
      resolve(dir, 'drafts', 'rejected.json'),
      `${JSON.stringify(rejected, null, 2)}\n`,
    )
  })
dataset
  .command('validate <dir>')
  .description('oracle check per task: hidden tests fail at base, pass at fix')
  .option('--task <id>', 'only this task')
  .option('--repeats <n>', 'determinism repeats', '2')
  .action(async (dir: string, opts: { task?: string; repeats: string }) => {
    const profile = RepoProfileSchema.parse(
      parse(await readFile(resolve(dir, 'profile.yaml'), 'utf8')),
    )
    const files = (await readdir(resolve(dir, 'tasks'))).filter((f) => f.endsWith('.yaml'))
    const deps = {
      sandbox: dockerSandbox(),
      workspaces: new GitWorkspaces(resolve('.cache')),
    }
    const results = []
    for (const f of files) {
      const task = await loadTask(resolve(dir, 'tasks', f))
      if (opts.task && task.id !== opts.task) continue
      console.log(`validating ${task.id}`)
      const r = await validateTask(task, profile, deps, Number(opts.repeats), console.log)
      console.log(`${r.valid ? 'VALID  ' : 'INVALID'} ${task.id}`)
      for (const reason of r.reasons) console.log(`  - ${reason}`)
      results.push(r)
    }
    await writeFile(resolve(dir, 'validation.json'), `${JSON.stringify(results, null, 2)}\n`)
    if (results.some((r) => !r.valid)) process.exitCode = 1
  })
dataset
  .command('split <dir>')
  .description('seeded train/holdout split → <dir>/split.yaml')
  .option('--holdout <ratio>', '', '0.4')
  .option('--seed <n>', '', '1')
  .action(async (dir: string, opts: { holdout: string; seed: string }) => {
    const ids = (await readdir(resolve(dir, 'tasks')))
      .filter((f) => f.endsWith('.yaml'))
      .map((f) => f.replace(/\.yaml$/, ''))
    const s = splitTasks(ids, Number(opts.holdout), Number(opts.seed))
    const header = `# tiller dataset split --holdout ${opts.holdout} --seed ${opts.seed}\n`
    await writeFile(resolve(dir, 'split.yaml'), header + stringify(s))
    console.log(
      `train ${s.train.length} · holdout ${s.holdout.length} → ${resolve(dir, 'split.yaml')}`,
    )
  })
dataset
  .command('audit <dir>')
  .description(
    'curation evidence per task from stored runs (no agent runs): what each task can tell',
  )
  .action(async (dir: string) => {
    const name = basename(resolve(dir))
    const files = (await readdir(resolve(dir, 'tasks'))).filter((f) => f.endsWith('.yaml')).sort()
    const tasks = await Promise.all(files.map((f) => loadTask(resolve(dir, 'tasks', f))))
    const labels = await loadLabels(resolve(dir))
    const cache = new GitWorkspaces(resolve('.cache'))
    const store = new Store(resolve('tiller.db'), resolve('artifacts'))
    try {
      const stored = store.datasetRuns(name)
      const pct = (x: number | null) => (x === null ? '—' : `${Math.round(x * 100)}%`)
      console.log(
        `${'task'.padEnd(12)}${'resolution'.padEnd(16)}${'solved'.padEnd(8)}${'by model'.padEnd(34)}${'f2p'.padEnd(6)}${'located'.padEnd(9)}fix files (untouched by any run)`,
      )
      const counts: Record<string, number> = {}
      for (const task of tasks) {
        const mine = stored.filter((r) => r.task_id === task.id)
        const runs: AuditRun[] = await Promise.all(
          mine.map(async (r) => ({
            outcome: r.outcome,
            f2p:
              r.f2p_total === null ? undefined : { total: r.f2p_total, failed: r.f2p_failed ?? 0 },
            files: patchFiles(
              await readFile(resolve('artifacts', r.id, 'diff.patch'), 'utf8').catch(() => ''),
            ),
          })),
        )
        const changed = await git(
          cache.repoCache(task.repo),
          'diff',
          '--name-only',
          task.base_commit,
          task.fix_commit,
        ).catch(() => '')
        const fix = sourceFiles(changed.split('\n').filter(Boolean)).filter(
          (f) => !task.hidden_tests.includes(f),
        )
        const a = auditTask(task.id, runs, fix)
        counts[a.resolution] = (counts[a.resolution] ?? 0) + 1
        const models = [...new Set(mine.map((r) => r.model))]
          .map((m) => {
            const rs = mine.filter((r) => r.model === m)
            return `${m.replace(/^claude-/, '')} ${rs.filter((r) => r.outcome === 'success').length}/${rs.length}`
          })
          .join(' · ')
        console.log(
          `${a.id.padEnd(12)}${a.resolution.padEnd(16)}${`${a.successes}/${a.runs}`.padEnd(8)}${models.padEnd(34)}${pct(a.partial).padEnd(6)}${pct(a.located).padEnd(9)}${a.fixFiles.length} (${a.untouched.length})${labels.underspecified[a.id] ? '  [underspecified]' : ''}`,
        )
      }
      console.log(
        `\n${tasks.length} tasks · ${Object.entries(counts)
          .map(([k, v]) => `${k} ${v}`)
          .join(' · ')} · labelled underspecified ${Object.keys(labels.underspecified).length}`,
      )
      console.log(
        'f2p = median share of fail_to_pass cases passing in unsuccessful runs · located = runs touching every fix file',
      )
    } finally {
      store.close()
    }
  })

program
  .command('skill')
  .command('generate')
  .description('agent writes a one-off onboarding skill from the repo at <commit>')
  .requiredOption('--dataset <name>')
  .requiredOption('--at <commit>', 'older than every base_commit in the dataset')
  .requiredOption('--name <name>', 'skill name, e.g. hono-onboarding')
  .option('--config <name>', 'harness/model used to generate', 'c0-vanilla')
  .option('--prompt <file>', '', 'prompts/onboarding.md')
  .action(
    async (opts: { dataset: string; at: string; name: string; config: string; prompt: string }) => {
      const key = process.env.ANTHROPIC_API_KEY
      if (!key) throw new Error('ANTHROPIC_API_KEY not set (.env)')
      const dir = resolve('datasets', opts.dataset)
      const profile = await loadProfile(dir)
      const files = (await readdir(resolve(dir, 'tasks'))).filter((f) => f.endsWith('.yaml'))
      const tasks = await Promise.all(files.map((f) => loadTask(resolve(dir, 'tasks', f))))
      const repo = tasks[0]?.repo
      if (!repo) throw new Error('dataset has no tasks')
      const ws = new GitWorkspaces(resolve('.cache'))
      const cache = await ws.ensureRepo(repo, [opts.at])
      // leakage guard: generation commit must be an ancestor of every task's base
      for (const t of tasks) {
        const ok = await git(cache, 'merge-base', '--is-ancestor', opts.at, t.base_commit).then(
          () => true,
          () => false,
        )
        if (!ok) throw new Error(`${opts.at} is not older than base of ${t.id}`)
      }
      const r = await generateSkill(
        {
          repo,
          commit: (await git(cache, 'rev-parse', opts.at)).trim(),
          name: opts.name,
          description: `${repo} conventions, structure, testing (generated, no hand edits)`,
          prompt: await readFile(resolve(opts.prompt), 'utf8'),
          profile,
          config: await loadConfig(resolve('configs', `${opts.config}.yaml`)),
          skillsDir: resolve('skills'),
          artifactsDir: resolve('artifacts'),
        },
        {
          sandbox: dockerSandbox(),
          workspaces: ws,
          env: { ANTHROPIC_API_KEY: key },
          gateway: modelGateway(key),
          prices: loadPrices(),
          log: console.log,
        },
      )
      console.log(`${r.path}  v${r.version} · ~${r.tokens} tokens · $${r.cost?.toFixed(2) ?? '?'}`)
    },
  )

program
  .command('config')
  .command('add <file>')
  .description('resolve config, print content hash')
  .action(async (file: string) => {
    const path = resolve(file)
    const config = await loadConfig(path)
    const prompt = await readFile(resolve(config.prompt_template), 'utf8')
    console.log(`${configHash(config, prompt)}  ${config.name}`)
  })

program
  .command('run')
  .description('one task, one config: agent in sandbox → verify → store')
  .requiredOption('--task <id>')
  .requiredOption('--config <name>')
  .requiredOption('--dataset <name>', 'dataset dir under datasets/')
  .option('--keep-workspace')
  .action(
    async (opts: { task: string; config: string; dataset: string; keepWorkspace?: boolean }) => {
      const key = process.env.ANTHROPIC_API_KEY
      if (!key) throw new Error('ANTHROPIC_API_KEY not set (.env)')
      const dir = resolve('datasets', opts.dataset)
      const profile = RepoProfileSchema.parse(
        parse(await readFile(resolve(dir, 'profile.yaml'), 'utf8')),
      )
      const task = await loadTask(resolve(dir, 'tasks', `${opts.task}.yaml`))
      const config = await loadConfig(resolve('configs', `${opts.config}.yaml`))
      const skills = await Promise.all(config.skills.map((s) => loadSkill(resolve('skills'), s)))
      const promptTemplate = await readFile(resolve(config.prompt_template), 'utf8')
      const store = new Store(resolve('tiller.db'), resolve('artifacts'))
      try {
        const {
          run,
          checks,
          dir: artifacts,
        } = await runTask(
          {
            task,
            dataset: opts.dataset,
            profile,
            config,
            promptTemplate,
            skills,
            keepWorkspace: opts.keepWorkspace,
          },
          {
            sandbox: dockerSandbox(),
            workspaces: new GitWorkspaces(resolve('.cache')),
            store,
            env: { ANTHROPIC_API_KEY: key },
            gateway: modelGateway(key),
            prices: loadPrices(),
            log: console.log,
          },
        )
        console.log(`\n${run.outcome.toUpperCase()}  ${run.id}`)
        for (const c of checks) {
          console.log(
            `  ${c.passed ? '✓' : '✗'} ${c.name} ${(c.total ?? 0) - (c.failed ?? 0)}/${c.total}`,
          )
        }
        console.log(
          `  cost $${run.cost_usd?.toFixed(2) ?? '?'} · ${run.turns ?? '?'} turns · ${run.duration_s.toFixed(0)}s · diff ${run.diff_files} files/${run.diff_lines} lines`,
        )
        console.log(`  artifacts ${artifacts}`)
      } finally {
        store.close()
      }
    },
  )

program
  .command('benchmark')
  .description('dataset × config × repeats, parallel, hard budget cap')
  .requiredOption('--dataset <name>')
  .requiredOption('--config <name>')
  .option('--split <split>', 'train | holdout | all (needs datasets/<ds>/split.yaml)', 'all')
  .option('--repeats <n>', '', '1')
  .option('--concurrency <n>', 'parallel runs (each 2 CPU / 4 GB)', '3')
  .option('--budget <usd>', 'stop starting runs once spent', '10')
  .option('--name <name>')
  .option('--only <ids>', 'comma-separated task ids')
  .action(
    async (opts: {
      dataset: string
      config: string
      split: string
      repeats: string
      concurrency: string
      budget: string
      name?: string
      only?: string
    }) => {
      const key = process.env.ANTHROPIC_API_KEY
      if (!key) throw new Error('ANTHROPIC_API_KEY not set (.env)')
      const dir = resolve('datasets', opts.dataset)
      const profile = await loadProfile(dir)
      const files = (await readdir(resolve(dir, 'tasks'))).filter((f) => f.endsWith('.yaml')).sort()
      let tasks = await Promise.all(files.map((f) => loadTask(resolve(dir, 'tasks', f))))
      if (opts.split !== 'all') {
        const split = parse(await readFile(resolve(dir, 'split.yaml'), 'utf8')) as Record<
          string,
          string[]
        >
        const ids = new Set(split[opts.split] ?? [])
        tasks = tasks.filter((t) => ids.has(t.id))
      }
      if (opts.only) {
        const ids = new Set(opts.only.split(','))
        tasks = tasks.filter((t) => ids.has(t.id))
      }
      const config = await loadConfig(resolve('configs', `${opts.config}.yaml`))
      const promptTemplate = await readFile(resolve(config.prompt_template), 'utf8')
      const skills = await Promise.all(config.skills.map((s) => loadSkill(resolve('skills'), s)))
      const name = opts.name ?? config.name
      const repeats = Number(opts.repeats)
      console.log(`TILLER BENCHMARK  ${name}`)
      console.log(
        `config     ${config.name} (${config.harness}, ${config.model}, skills: ${config.skills.join(', ') || '—'})`,
      )
      console.log(
        `dataset    ${opts.dataset} / ${opts.split} · ${tasks.length} tasks × ${repeats} repeats = ${tasks.length * repeats} runs · budget $${opts.budget}\n`,
      )
      const store = new Store(resolve('tiller.db'), resolve('artifacts'))
      try {
        const s = await runBenchmark(
          {
            name,
            dataset: opts.dataset,
            split: opts.split,
            tasks,
            profile,
            config,
            promptTemplate,
            repeats,
            concurrency: Number(opts.concurrency),
            budgetUsd: Number(opts.budget),
            skills,
          },
          {
            sandbox: dockerSandbox(),
            workspaces: new GitWorkspaces(resolve('.cache')),
            store,
            env: { ANTHROPIC_API_KEY: key },
            gateway: modelGateway(key),
            prices: loadPrices(),
            log: console.log,
          },
        )
        const pct = (x: number) => `${(x * 100).toFixed(1)}%`
        const dur = (x: number) => `${Math.floor(x / 60)}m ${Math.round(x % 60)}s`
        console.log(`\nbenchmark        ${s.id}`)
        console.log(`success          ${s.successes}/${s.runs}   ${pct(s.successRate)}`)
        console.log(`cost total       $${s.totalCost.toFixed(2)}`)
        console.log(`cost/run         $${s.costPerRun.toFixed(2)}`)
        console.log(
          `cost/success     ${s.costPerSuccess === null ? '—' : `$${s.costPerSuccess.toFixed(2)}`}`,
        )
        console.log(`median duration  ${dur(s.medianDuration)}`)
        console.log(`timeouts/errors  ${s.timeouts} / ${s.errors}`)
        if (s.skippedForBudget) console.log(`skipped (budget) ${s.skippedForBudget}`)
      } finally {
        store.close()
      }
    },
  )

program
  .command('compare <a> <b>')
  .description('paired per-task comparison of two benchmarks (name = latest with that name, or id)')
  .option('--split <split>', 'train | holdout | all', 'all')
  .action(async (a: string, b: string, opts: { split: string }) => {
    const store = new Store(resolve('tiller.db'), resolve('artifacts'))
    try {
      const { A, B, all, sub } = await loadComparison(store, a, b, opts.split)

      const pct = (x: number) => `${(x * 100).toFixed(1)}%`
      const pp = (x: number) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}`
      const usd = (x: number | null) => (x === null ? '—' : `$${x.toFixed(3)}`)
      const num = (x: number) =>
        Math.abs(x) >= 100 ? x.toFixed(0) : Math.abs(x) >= 10 ? x.toFixed(1) : x.toFixed(3)
      const signed = (x: number) => `${x >= 0 ? '+' : ''}${num(x)}`
      const width = Math.max(14, a.length + 2, b.length + 2)
      const col = (s: string, w = width) => s.padEnd(w)
      // a delta counts when it holds across tasks (CI excludes 0) and exceeds what a rerun moves
      const real = (d: { mean: number; lo: number; hi: number }, noise: number | null) =>
        (d.lo > 0 || d.hi < 0) && noise !== null && Math.abs(d.mean) > noise

      const print = (c: ReturnType<typeof compareRuns>, withMetrics: boolean) => {
        console.log(
          `${col('', 18)}${col(a)}${col(b)}${col('Δ (95% CI over tasks)', 30)}rerun noise`,
        )
        console.log(
          `${col('success', 18)}${col(pct(c.a.successRate))}${col(pct(c.b.successRate))}${col(`${pp(c.delta.mean)} pp (${pp(c.delta.lo)}, ${pp(c.delta.hi)})`, 30)}${c.noise === null ? 'n/a' : `±${(c.noise * 100).toFixed(1)} pp`}${real(c.delta, c.noise) ? '  *' : ''}`,
        )
        console.log(
          `${col('cost/success', 18)}${col(usd(c.a.costPerSuccess))}${col(usd(c.b.costPerSuccess))}${c.costPerSuccessDelta === null ? '—' : `${c.costPerSuccessDelta >= 0 ? '+' : ''}${(c.costPerSuccessDelta * 100).toFixed(0)}%`}`,
        )
        console.log(
          `${col('median dur.', 18)}${col(`${c.a.medianDuration.toFixed(0)}s`)}${col(`${c.b.medianDuration.toFixed(0)}s`)}`,
        )
        console.log(`${col('runs', 18)}${col(String(c.a.runs))}${col(String(c.b.runs))}`)
        if (!withMetrics) return
        console.log(
          `\n${col('per run', 18)}${col(a)}${col(b)}${col('Δ (95% CI over tasks)', 30)}rerun noise`,
        )
        for (const m of c.metrics) {
          console.log(
            `${col(m.name, 18)}${col(num(m.a))}${col(num(m.b))}${col(`${signed(m.delta.mean)} (${signed(m.delta.lo)}, ${signed(m.delta.hi)})`, 30)}${m.noise === null ? 'n/a' : `±${num(m.noise)}`}${real(m.delta, m.noise) ? '  *' : ''}`,
          )
        }
      }

      console.log(`split ${opts.split} · ${all.tasks} paired tasks · ${A.id} vs ${B.id}\n`)
      print(all, true)
      if (sub) {
        console.log(
          `\nsolvable from the issue · ${sub.tasks} tasks (${all.tasks - sub.tasks} labelled underspecified left out)\n`,
        )
        print(sub, false)
      }
      console.log('\n* = holds across tasks (CI excludes 0) and exceeds rerun noise')
      console.log(`tasks improved   ${all.flips.failToSuccess} · worse ${all.flips.successToFail}`)
      console.log(
        `recommendation   ${all.recommendation === 'PROMOTE' ? `PROMOTE ${b}` : `KEEP ${a} (don't promote ${b})`}`,
      )
      console.log(`                 ${all.reason}`)
    } finally {
      store.close()
    }
  })

program
  .command('gate <baseline> <candidate>')
  .description(
    'eval gate for a skill / config change: evidence for the PR as markdown; exit 2 when the rule says KEEP',
  )
  .option('--split <split>', 'train | holdout | all', 'all')
  .option('--out <file>', 'write the evidence here instead of stdout')
  .option(
    '--reference <benchmark>',
    'the config from before any promotion: the candidate must not be below it by more than rerun noise either',
  )
  .action(
    async (a: string, b: string, opts: { split: string; out?: string; reference?: string }) => {
      const store = new Store(resolve('tiller.db'), resolve('artifacts'))
      try {
        const { A, B, all, sub } = await loadComparison(store, a, b, opts.split)
        const side = (bm: typeof A) => ({
          id: bm.id,
          config: bm.config_name,
          model: bm.model,
          skills: bm.skills,
        })
        // promotions add up: against a fixed reference a chain of them cannot lose what none saw
        const ref = opts.reference
          ? await loadComparison(store, opts.reference, b, opts.split)
          : undefined
        const input = {
          dataset: A.dataset,
          split: opts.split,
          a: side(A),
          b: side(B),
          comparison: all,
          solvable: sub,
          reference: ref ? { side: side(ref.A), comparison: ref.all } : undefined,
        }
        const evidence = renderEvidence(input)
        const verdict = gateVerdict(input)
        if (opts.out) {
          await writeFile(resolve(opts.out), `${evidence}\n`)
          console.log(`${verdict.verdict}: ${verdict.reason}\nevidence → ${resolve(opts.out)}`)
        } else console.log(evidence)
        if (verdict.verdict !== 'PROMOTE') process.exitCode = 2
      } finally {
        store.close()
      }
    },
  )

program
  .command('noise')
  .description(
    'rerun noise of a dataset from stored benchmarks: what delta a comparison can detect',
  )
  .requiredOption('--dataset <name>')
  .option('--metric <name>', 'success, or a per-run metric of `tiller compare`', 'success')
  .option('--delta <x>', 'effect to plan for, in metric units (0.05 = 5 pp)', '0.05')
  .action(async (opts: { dataset: string; metric: string; delta: string }) => {
    const store = new Store(resolve('tiller.db'), resolve('artifacts'))
    try {
      const benchmarks = store.datasetBenchmarks(opts.dataset)
      const unit = (x: number) =>
        opts.metric === 'success' || opts.metric === 'f2p_share'
          ? `${(x * 100).toFixed(1)} pp`
          : x.toPrecision(3)
      const perTask = new Map<string, number[]>()
      const costs: number[] = []
      console.log(
        `${'benchmark'.padEnd(32)}${'tasks'.padEnd(7)}${'runs'.padEnd(6)}${'mean'.padEnd(11)}${'unstable'.padEnd(10)}${'±95% noise'.padEnd(12)}repeat-to-repeat deltas (same config)`,
      )
      for (const bm of benchmarks) {
        const records = store.runsOf(bm.id)
        const rows = await loadRunRows(store, records)
        const values = rows.flatMap((r, i) => {
          const value =
            opts.metric === 'success' ? (r.outcome === 'success' ? 1 : 0) : r.metrics?.[opts.metric]
          return value == null
            ? []
            : [{ task_id: r.task_id, value, repeat: records[i]?.repeat ?? 0 }]
        })
        costs.push(...records.flatMap((r) => (r.cost_usd === null ? [] : [r.cost_usd])))
        const n = noiseSummary(values)
        if (n.tasks === 0) continue
        for (const [task, t] of taskNoise(values))
          if (t.variance !== null) perTask.set(task, [...(perTask.get(task) ?? []), t.variance])
        // A/A: the same config against itself, one repeat per side
        const repeats = [...new Set(values.map((v) => v.repeat))].sort()
        const mean = (rep: number) => {
          const xs = values.filter((v) => v.repeat === rep)
          return xs.reduce((s, v) => s + v.value, 0) / (xs.length || 1)
        }
        const aa = repeats
          .flatMap((x, i) => repeats.slice(i + 1).map((y) => mean(y) - mean(x)))
          .map((d) => `${d >= 0 ? '+' : ''}${unit(d)}`)
        console.log(
          `${bm.id.padEnd(32)}${String(n.tasks).padEnd(7)}${String(n.runs).padEnd(6)}${unit(n.mean).replace(' pp', '%').padEnd(11)}${String(n.unstable).padEnd(10)}${`±${unit(1.96 * n.se)}`.padEnd(12)}${aa.join(', ')}`,
        )
      }
      const tasks = perTask.size
      if (tasks === 0) {
        console.log('\nno benchmark with repeats: run one with --repeats 2 or more')
        return
      }
      const variance =
        [...perTask.values()].reduce((s, v) => s + v.reduce((x, y) => x + y, 0) / v.length, 0) /
        tasks
      // median: one benchmark on a pricier model must not set the planning price
      const perRun = costs.sort((x, y) => x - y)[Math.floor(costs.length / 2)] ?? 0
      console.log(
        `\n${opts.dataset}: ${tasks} tasks with repeats · mean per-task variance of one run ${variance.toPrecision(3)} · median $${perRun.toFixed(3)}/run`,
      )
      console.log(
        `\nsmallest delta a paired comparison of two configs detects (5 % two-sided, 80 % power)`,
      )
      console.log(`${'repeats'.padEnd(9)}${'detectable'.padEnd(13)}${'runs'.padEnd(7)}cost`)
      for (const r of [1, 2, 3, 5, 10, 20]) {
        console.log(
          `${String(r).padEnd(9)}${unit(detectableDelta(variance, tasks, r)).padEnd(13)}${String(2 * r * tasks).padEnd(7)}$${(2 * r * tasks * perRun).toFixed(0)}`,
        )
      }
      const need = repeatsFor(variance, tasks, Number(opts.delta))
      console.log(
        `\nto detect ${unit(Number(opts.delta))}: ${need} repeats per config = ${2 * need * tasks} runs ≈ $${(2 * need * tasks * perRun).toFixed(0)}`,
      )
      console.log(
        '(rerun noise only, task set held fixed; generalising to other tasks is the CI over tasks)',
      )
    } finally {
      store.close()
    }
  })
program
  .command('improve')
  .description(
    'failed train runs → labelled clusters → proposed learned skill (human/agent review before use)',
  )
  .requiredOption('--benchmark <name>')
  .requiredOption('--dataset <name>')
  .requiredOption('--skill <name>', 'learned skill to write, e.g. hono-learned')
  .option('--split <split>', 'learn only from this split', 'train')
  .option('--max-words <n>', '', '500')
  .action(
    async (opts: {
      benchmark: string
      dataset: string
      skill: string
      split: string
      maxWords: string
    }) => {
      if (opts.split === 'holdout') throw new Error('never learn from holdout')
      const dir = resolve('datasets', opts.dataset)
      const profile = await loadProfile(dir)
      const split = parse(await readFile(resolve(dir, 'split.yaml'), 'utf8')) as Record<
        string,
        string[]
      >
      const trainIds = new Set(split[opts.split] ?? [])
      const store = new Store(resolve('tiller.db'), resolve('artifacts'))
      try {
        const bm = store.findBenchmark(opts.benchmark)
        if (!bm) throw new Error(`benchmark not found: ${opts.benchmark}`)
        const skillRefs = store.benchmarkSkills(bm.id)
        const skills = await Promise.all(skillRefs.map((s) => loadSkill(resolve('skills'), s)))
        const current = skills.map((s) => `## Skill: ${s.name}\n${s.body}`).join('\n\n')
        const failed = store.failedRuns(bm.id).filter((r) => trainIds.has(r.task_id))
        console.log(
          `${failed.length} failed ${opts.split} runs in ${bm.id} (skills: ${skillRefs.join(', ') || '—'})`,
        )
        if (failed.length === 0) return
        const deps = {
          sandbox: dockerSandbox(),
          workspaces: new GitWorkspaces(resolve('.cache')),
          profile,
          artifactsDir: resolve('artifacts'),
        }
        const tasks = new Map<string, Awaited<ReturnType<typeof loadTask>>>()
        for (const r of failed) {
          if (!tasks.has(r.task_id))
            tasks.set(r.task_id, await loadTask(resolve(dir, 'tasks', `${r.task_id}.yaml`)))
        }
        const improver = new Improver()
        const evidence = []
        const labels = []
        for (const r of failed) {
          const task = tasks.get(r.task_id)
          if (!task) continue
          const e = await collectEvidence({ id: r.id, task }, deps)
          evidence.push(e)
          const l = await improver.label(e, current)
          labels.push(l)
          console.log(
            `  ${r.task_id}  ${l.cluster}  (context helps: ${l.would_context_have_helped})`,
          )
        }
        const proposal = await improver.propose(labels, current, {
          repo: tasks.values().next().value?.repo ?? opts.dataset,
          maxWords: Number(opts.maxWords),
        })
        // semantic leak guard over every train task that failed (one entry per task)
        const byTask = new Map(evidence.map((e) => [e.task_id, e]))
        const sanitized = await sanitizeSkill(improver, proposal.skill_markdown, [
          ...byTask.values(),
        ])
        console.log(`  sanitize: removed ${sanitized.removed.length} task-specific passages`)
        const warnings = leakWarnings(sanitized.skill_markdown, evidence)
        const skillDir = resolve('skills', opts.skill)
        await mkdir(skillDir, { recursive: true })
        const versions = (await readdir(skillDir)).map((f) =>
          Number(/^v(\d+)\.md$/.exec(f)?.[1] ?? 0),
        )
        const version = Math.max(0, ...versions) + 1
        const outDir = resolve('artifacts', `improve-${opts.skill}-v${version}`)
        await mkdir(outDir, { recursive: true })
        const meta = {
          name: opts.skill,
          version,
          description: `learned from failures of ${bm.id} (${opts.split} split)`,
          learned_from: {
            benchmark: bm.id,
            split: opts.split,
            runs: failed.length,
            model: IMPROVE_MODEL,
            base_skills: skillRefs,
          },
        }
        await writeFile(
          resolve(skillDir, `v${version}.md`),
          `---\n${stringify(meta)}---\n\n${sanitized.skill_markdown.trim()}\n`,
        )
        await writeFile(resolve(outDir, 'unsanitized.md'), `${proposal.skill_markdown.trim()}\n`)
        await writeFile(resolve(outDir, 'labels.json'), `${JSON.stringify(labels, null, 2)}\n`)
        const report = [
          `# improve ${opts.skill} v${version}`,
          '',
          `benchmark ${bm.id} · ${opts.split} · ${failed.length} failed runs · model ${IMPROVE_MODEL}`,
          '',
          '## Clusters',
          ...proposal.clusters.map(
            (c) =>
              `- **${c.slug}** ×${c.count}${c.addressed ? '' : ' (not addressed)'} — ${c.summary}`,
          ),
          '',
          '## Removed by semantic leak guard',
          ...(sanitized.removed.length
            ? sanitized.removed.map(
                (r) => `- ${r.task_id}: "${r.passage.slice(0, 200)}" — ${r.why}`,
              )
            : ['- none']),
          '',
          '## Lexical leak warnings',
          ...(warnings.length ? warnings.map((w) => `- ${w}`) : ['- none']),
          '',
          '## Evidence',
          ...labels.map((l) => `- ${l.task_id} \`${l.run_id}\`: ${l.cluster} — ${l.root_cause}`),
        ].join('\n')
        await writeFile(resolve(outDir, 'improve-report.md'), `${report}\n`)
        console.log(
          `\nskills/${opts.skill}/v${version}.md · ~${estimateTokens(sanitized.skill_markdown)} tokens · ${warnings.length} leak warnings`,
        )
        console.log(`report ${resolve(outDir, 'improve-report.md')}`)
      } finally {
        store.close()
      }
    },
  )
program
  .command('review')
  .requiredOption('--benchmark <name>')
  .option('--sample <n>', '', '30')
  .action(todo('review'))
program
  .command('runs')
  .option('--benchmark <name>')
  .option('--outcome <outcome>')
  .action(todo('runs'))
program
  .command('ui')
  .description('local factory UI: tasks, inbox, run conversations, evals (http://127.0.0.1:<port>)')
  .option('--port <port>', '', '4317')
  .option(
    '--host <address>',
    'address to listen on; 0.0.0.0 in a container whose port the host publishes',
    '127.0.0.1',
  )
  .option(
    '--url <url>',
    'address people open the UI at, when it is not this machine (a reverse proxy, a server name)',
  )
  .option('--api-only', 'serve the API only (web dev: pnpm --filter @codetiller/web dev)')
  .action(async (opts: { port: string; host: string; url?: string; apiOnly?: boolean }) => {
    const { store, factory, sandbox } = openFactory(console.log, { worker: true })
    // packages/web/dist, from both src/ (tsx) and dist/ (built)
    const webDir = opts.apiOnly
      ? undefined
      : fileURLToPath(new URL('../../web/dist', import.meta.url))
    // worker executes only runs a human queued (no automatic spawn)
    const stopWorker = await runWorker(factory, sandbox)
    const token = uiToken()
    // the web dev server proxies with its own Host
    const ports = opts.apiOnly ? [opts.port, '5173'] : [opts.port]
    // answered: this machine by its loopback names, and the one public address it was told
    const site = opts.url ? new URL(opts.url) : undefined
    const hosts = [
      ...ports.flatMap((p) => [`127.0.0.1:${p}`, `localhost:${p}`]),
      ...(site ? [site.host] : []),
    ]
    const server = startServer(
      { store, root: resolve('.'), factory, token, hosts },
      { port: Number(opts.port), host: opts.host, webDir },
    )
    // the link carries the token once; the page keeps it and drops it from the address
    const base = site ? site.origin : `http://127.0.0.1:${opts.apiOnly ? '5173' : opts.port}`
    const url = `${base}/?token=${token}`
    const note = opts.apiOnly ? ` (API on :${opts.port}; web dev server on :5173)` : ''
    console.log(`tiller ui → ${url}${note}`)
    if (!factory.canRun) console.log('ANTHROPIC_API_KEY not set: tasks can be queued, not run')
    const stop = async () => {
      await stopWorker()
      server.close(() => store.close())
      // open connections (a page following a run) must not keep a stopped factory alive
      if ('closeAllConnections' in server) server.closeAllConnections()
    }
    process.on('SIGINT', stop)
    process.on('SIGTERM', stop)
  })

program
  .command('tools')
  .description('commands agents tried that the sandbox images lack (scans run transcripts)')
  .action(async () => {
    const dir = resolve('artifacts')
    const totals = new Map<string, { count: number; runs: number }>()
    let runs = 0
    let affected = 0
    for (const id of await readdir(dir).catch(() => [])) {
      const raw = await readFile(resolve(dir, id, 'transcript.jsonl'), 'utf8').catch(() => null)
      if (raw === null) continue
      runs++
      const missing = missingCommands(raw)
      if (missing.length) affected++
      for (const m of missing) {
        const t = totals.get(m.command) ?? { count: 0, runs: 0 }
        totals.set(m.command, { count: t.count + m.count, runs: t.runs + 1 })
      }
    }
    console.log(`${affected} of ${runs} runs hit a missing command`)
    for (const [command, t] of [...totals].sort((a, b) => b[1].runs - a[1].runs))
      console.log(`${command.padEnd(16)} ${String(t.runs).padStart(4)} runs  ${t.count} times`)
  })

program
  .command('gateway <action>')
  .description(
    'model gateway and registry proxy containers: `stop` removes them (the next run starts fresh ones)',
  )
  .action(async (action: string) => {
    if (action !== 'stop') throw new Error('usage: tiller gateway stop')
    if (ON_KUBERNETES)
      throw new Error(
        'on Kubernetes the gateway and the proxy are Deployments: kubectl rollout restart',
      )
    const key = process.env.ANTHROPIC_API_KEY ?? ''
    await new DockerGateway({ key, script: '' }).stop()
    await registryProxy().stop()
    console.log('model gateway and registry proxy stopped')
  })

/** IPv4 addresses of this machine (or of tiller's own container) other than loopback. */
const ownAddresses = () =>
  Object.values(networkInterfaces())
    .flat()
    .filter((a) => a && a.family === 'IPv4' && !a.internal)
    .map((a) => (a as { address: string }).address)

const run = promisify(execFile)
const docker = (args: string[]) => run('docker', args).then((r) => r.stdout)

const dockerDoctor = () => ({
  sandbox: new DockerSandbox() as Sandbox,
  runtime: {
    name: 'docker',
    version: () =>
      docker(['version', '--format', '{{.Server.Version}} {{.Server.Os}}/{{.Server.Arch}}']).then(
        (v) => `daemon ${v.trim()}`,
      ),
    fix: 'start docker; in a container, mount /var/run/docker.sock and add the group that owns it',
  },
  imageFix: 'tiller setup',
  sharedFix: `mount the directory into tiller's container at the path it has on the docker host (${resolve('.')}:${resolve('.')})`,
})

/** On Kubernetes: the API answers and may be asked for pods; the gateway answers the factory. */
function kubernetesDoctor() {
  const k = KUBE
  return {
    // a cluster the factory could not read gets no probe pod: the runtime check says why
    sandbox: (k && !('problem' in k)
      ? dockerSandbox()
      : { exec: () => Promise.reject() }) as Sandbox,
    runtime: {
      name: 'kubernetes',
      version: async () => {
        const c = kube()
        const v = await c.api.call('GET', '/version')
        const pods = await c.api.call('GET', `/api/v1/namespaces/${c.namespace}/pods?limit=1`)
        if (pods.status !== 200)
          throw new Error(
            `the service account may not list pods in ${c.namespace} (${pods.status})`,
          )
        const health = await fetch(new URL('/healthz', c.gatewayUrl)).then(
          (r) => r.status,
          (e: Error) => e.message,
        )
        if (health !== 200) throw new Error(`the model gateway does not answer: ${health}`)
        const git = (v.body as { gitVersion?: string }).gitVersion ?? `HTTP ${v.status}`
        return `cluster ${git}, namespace ${c.namespace}, gateway and registry proxy found`
      },
      fix: 'kubectl apply -k deploy/kubernetes, and create the secret it names',
    },
    imageFix: 'push it to a registry the cluster pulls from (TILLER_BASE_IMAGE names it)',
    sharedFix: `mount the claim ${k?.claim} at ${resolve('.')} in tiller's pod`,
  }
}

/** The checks of `tiller doctor` on this working dir; opens the database (and so migrates it). */
async function checkInstallation() {
  const store = new Store(resolve('tiller.db'), resolve('artifacts'))
  const token = process.env.TILLER_GITHUB_TOKEN
  const forge = token ? new GitHubForge(token) : undefined
  try {
    return await doctor({
      home: resolve('.'),
      ...(ON_KUBERNETES ? kubernetesDoctor() : dockerDoctor()),
      image: DEFAULT_IMAGE,
      git: () => run('git', ['--version']).then((r) => r.stdout),
      uid: process.getuid?.() ?? -1,
      // on Kubernetes the key is the gateway's: it is there when the gateway answers
      modelKey: ON_KUBERNETES
        ? 'held by the model gateway; the factory has none'
        : Boolean(process.env.ANTHROPIC_API_KEY),
      forgeToken: Boolean(token),
      repos: [
        ...new Set([
          ...new WorkItems(store).repos().map((r) => r.repo),
          ...loadFactoryConfig().projects.map((p) => p.repo),
        ]),
      ],
      repoAccess: forge ? (repo) => forge.access(repo) : undefined,
      schema: store.migrated.to,
      freeBytes: freeBytesOf(resolve('.')),
    })
  } finally {
    store.close()
  }
}

program
  .command('doctor')
  .description(
    'check this installation: docker, the sandbox image, workspaces shared with the docker daemon, credentials, repositories; exit 1 when a check fails',
  )
  .action(async () => {
    const checks = await checkInstallation()
    console.log(renderDoctor(checks))
    if (!doctorOk(checks)) process.exitCode = 1
  })

program
  .command('setup')
  .description(
    'prepare a docker host for tiller: build the sandbox base image when it is missing, then `tiller doctor`',
  )
  .option('--rebuild', 'build the image even when there is one')
  .action(async (opts: { rebuild?: boolean }) => {
    if (ON_KUBERNETES)
      throw new Error(
        `on Kubernetes the cluster pulls ${DEFAULT_IMAGE} from a registry: push it there (TILLER_BASE_IMAGE names it), then tiller doctor`,
      )
    const have = await new DockerSandbox().imageId(DEFAULT_IMAGE)
    if (have && !opts.rebuild) console.log(`${DEFAULT_IMAGE} is there (${have.slice(7, 19)})`)
    else {
      console.log(`building ${DEFAULT_IMAGE} (Node, Go, Python and the agent CLI: a few GB)`)
      const code = await new Promise<number | null>((done, fail) =>
        spawn('docker', ['build', '-t', DEFAULT_IMAGE, resolve(DEFAULTS, 'images', 'base')], {
          stdio: 'inherit',
        })
          .on('error', fail)
          .on('close', done),
      )
      if (code !== 0) throw new Error(`docker build failed (exit ${code})`)
    }
    console.log('')
    const checks = await checkInstallation()
    console.log(renderDoctor(checks))
    if (!doctorOk(checks)) process.exitCode = 1
  })

program
  .command('audit')
  .description(
    'Probe the trust boundary inside the containers the factory starts (no model call); exit 1 on a failed probe',
  )
  .option('--image <image>', 'image that is probed', DEFAULT_IMAGE)
  .option('--profile <name>', 'probe the image of this sandbox profile (datasets/<name>) instead')
  .option('--config <name>', '', 'c0-vanilla')
  .option('--port <port>', 'where the factory UI/API listens', '4317')
  .action(async (opts: { image: string; profile?: string; config: string; port: string }) => {
    const key = process.env.ANTHROPIC_API_KEY ?? ''
    if (!key && !ON_KUBERNETES) throw new Error('ANTHROPIC_API_KEY not set (.env)')
    const image = opts.profile
      ? (await loadProfile(resolve('datasets', opts.profile))).image
      : opts.image
    const config = await loadConfig(own('configs', `${opts.config}.yaml`))
    // a run as the factory would open it: one model, a budget no probe gets near
    const access = await modelAccess(key ? { ANTHROPIC_API_KEY: key } : {}, modelGateway(key), {
      label: 'audit',
      config,
      prices: loadPrices(),
    })
    const results = await auditSandbox({
      sandbox: dockerSandbox(),
      image,
      config,
      access,
      port: Number(opts.port),
      hosts: ownAddresses(),
      kubeApi: process.env.KUBERNETES_SERVICE_HOST
        ? `${process.env.KUBERNETES_SERVICE_HOST}:${process.env.KUBERNETES_SERVICE_PORT ?? 443}`
        : undefined,
      workDir: resolve('.cache', 'work'),
    })
    console.log(
      `model access: ${access.via}${access.network ? ` (network ${access.network})` : ''}\n`,
    )
    let last = ''
    for (const r of results) {
      if (r.container !== last) console.log(`${last ? '\n' : ''}${r.container} container`)
      last = r.container
      console.log(`  ${r.status.padEnd(5)} ${r.probe.padEnd(21)}${r.observed.padEnd(18)}${r.want}`)
    }
    await access.close()
    // from the host itself: any process of this user can reach the port, so the API must refuse
    // a call without the token here too
    const api = await fetch(`http://127.0.0.1:${opts.port}/api/health`).then(
      (r) => String(r.status),
      () => 'not running',
    )
    const apiOk = api === '401' || api === 'not running'
    console.log(
      `\nhost\n  ${(apiOk ? 'ok' : 'FAIL').padEnd(5)} ${'api_no_token'.padEnd(21)}${api.padEnd(18)}factory API answers no call without the token`,
    )
    if (!apiOk) process.exitCode = 1
    const failed = results.filter((r) => r.status === 'FAIL')
    const open = results.filter((r) => r.status === 'open')
    console.log(
      `\n${failed.length ? `${failed.length} probe(s) FAILED: the boundary does not hold` : 'boundary holds for every probe'}${open.length ? ` · ${open.length} known open gap(s)` : ''}`,
    )
    if (failed.length) process.exitCode = 1
  })

program
  .command('daemon')
  .description('tillerd without the UI: import labelled issues, execute runs humans queued')
  .action(async () => {
    const { store, factory, sandbox } = openFactory(console.log, { worker: true })
    if (!factory.canRun) console.log('ANTHROPIC_API_KEY not set: tasks can be queued, not run')
    if (!factory.canImport)
      console.log('intake off: needs TILLER_GITHUB_TOKEN and factory.projects in tiller.yaml')
    const stopWorker = await runWorker(factory, sandbox)
    console.log('tiller daemon running (ctrl-c to stop)')
    const stop = async () => {
      await stopWorker()
      store.close()
    }
    process.on('SIGINT', stop)
    process.on('SIGTERM', stop)
  })

const repoCmd = program
  .command('repo')
  .description(
    'repositories the factory works on: onboarding, their sandbox profile, the baseline check',
  )

/** What onboarding found, for a terminal. */
function printOnboarding(o: Onboarding) {
  console.log(`${o.repo} at ${o.head.slice(0, 8)}`)
  for (const n of o.notes) console.log(`  · ${n}`)
  if (!o.profile)
    return console.log('\nno profile: write `sandbox:` in .factory/factory.yaml by hand')
  if (o.check) {
    console.log(`\nbaseline check${o.check.installed ? '' : ': dependency install FAILED'}`)
    if (o.check.error) console.log(o.check.error.replace(/^/gm, '    '))
    for (const c of o.check.suites) {
      const result =
        c.tests === null ? 'NO REPORT' : `${c.tests} tests, ${c.failing} failing at the base`
      console.log(`  ${c.name.padEnd(16)} ${result}  (${c.seconds} s)`)
      if (c.log) console.log(c.log.replace(/^/gm, '    '))
    }
    for (const c of o.check.checks ?? [])
      console.log(
        `  ${`check ${c.name}`.padEnd(28)} ${c.ok ? 'passes' : 'FAILS at the base (not held against a change)'}  (${c.seconds} s)`,
      )
  }
  if (o.source === 'repository') return
  console.log(
    `\nproposed .factory/factory.yaml (commit it to the repository; until then the factory uses this copy):\n`,
  )
  console.log(sandboxYaml(o.profile))
}

repoCmd
  .command('add <owner/name>')
  .description(
    'onboard a repository: take its .factory/factory.yaml or propose a sandbox profile from what is in it, install its dependencies and run its tests once; exit 2 when the profile does not run',
  )
  .option('--config <name>', 'agent config of its tasks (configs/<name>.yaml)', 'c0-vanilla')
  .option('--label <label>', 'issues with this label are imported (`none`: no intake)', 'tiller')
  .option('--no-check', 'do not install and run the tests')
  .action(async (repo: string, opts: { config: string; label: string; check: boolean }) => {
    const { store, factory } = openFactory()
    try {
      const o = await factory.onboard(repo, {
        config: opts.config,
        label: opts.label === 'none' ? null : opts.label,
        check: opts.check,
        log: (m) => console.error(`  ${m}`),
      })
      printOnboarding(o)
      if (o.check && !onboardingOk(o)) process.exitCode = 2
    } finally {
      store.close()
    }
  })
repoCmd
  .command('list')
  .description('onboarded repositories and how their last baseline check went')
  .action(() => {
    const { store, factory } = openFactory()
    for (const r of factory.items.repos()) {
      const check = r.checked
        ? `${r.checked.ok ? 'ok' : 'FAILS'} at ${r.checked.head.slice(0, 8)}: ${r.checked.summary}`
        : 'not checked'
      const source = r.profile ? 'onboarding profile' : 'own .factory/factory.yaml'
      console.log(`${r.repo.padEnd(32)} ${source.padEnd(26)} label ${r.label ?? '—'}  ${check}`)
    }
    store.close()
  })
repoCmd
  .command('remove <owner/name>')
  .description('forget an onboarded repository (its tasks stay)')
  .action((repo: string) => {
    const { store, factory } = openFactory()
    factory.items.removeRepo(repo)
    store.close()
  })

const task = program.command('task').description('factory tasks: human-queued agent runs')
task
  .command('create')
  .description('new task (IMPORTED); nothing runs until you enqueue it')
  .requiredOption('--repo <owner/name>')
  .requiredOption('--title <title>')
  .option('--body <text>', '', '')
  .option('--body-file <file>')
  .option(
    '--dataset <name>',
    "a sandbox profile of this checkout (datasets/<name>/profile.yaml); default: the repository's own .factory/factory.yaml, or what `tiller repo add` proposed",
    '',
  )
  .option('--config <name>', 'configs/<name>.yaml', 'c0-vanilla')
  .option('--ref <ref>', 'branch to start from (default: remote default branch)')
  .option('--model <id>', 'run on this model instead of the default (one of factory.models)')
  .option('--enqueue', 'queue the first run right away')
  .action(
    async (opts: {
      repo: string
      title: string
      body: string
      bodyFile?: string
      dataset: string
      config: string
      ref?: string
      model?: string
      enqueue?: boolean
    }) => {
      const { store, factory } = openFactory()
      try {
        const body = opts.bodyFile ? await readFile(resolve(opts.bodyFile), 'utf8') : opts.body
        let item = await factory.create({ ...opts, body })
        if (opts.enqueue) item = factory.enqueue(item.id)
        console.log(
          `${item.id}  ${item.state}  ${item.repo}@${item.base_commit.slice(0, 8)}  ${item.branch}`,
        )
      } finally {
        store.close()
      }
    },
  )
task.command('list').action(() => {
  const { store, factory } = openFactory()
  const totals = factory.items.totals()
  const experiments = factory.items.experiments()
  for (const i of factory.items.list()) {
    const t = totals.get(i.id)
    const mark = experiments.has(i.id) ? '[experiment] ' : ''
    console.log(
      `${i.id.padEnd(6)} ${i.state.padEnd(18)} ${String(t?.runs ?? 0).padStart(2)} runs  $${(t?.cost_usd ?? 0).toFixed(2).padStart(6)}  ${mark}${i.title}`,
    )
  }
  store.close()
})
task
  .command('show <id>')
  .description('timeline: human messages, agent questions/summaries, runs')
  .action((id: string) => {
    const { store, factory } = openFactory()
    const item = factory.items.get(id)
    if (!item) throw new Error(`no task ${id}`)
    console.log(
      `${item.id} ${item.state} · ${item.repo} · ${item.branch} · ${item.config}\n${item.title}\n`,
    )
    for (const r of factory.items.runs(id)) {
      const cost = r.cost_usd === null ? '?' : `$${r.cost_usd.toFixed(2)}`
      const model = store.getConfig(r.config_id)?.model ?? '?'
      console.log(
        `run ${r.seq}  ${model}  ${r.agent_exit ?? 'running'}  ${cost}  ${r.turns ?? '?'} turns`,
      )
    }
    if (factory.items.runs(id).length) console.log('')
    for (const e of factory.items.events(id)) {
      const head = `${e.at.slice(11, 19)} ${e.actor.padEnd(7)} ${e.kind}`
      console.log(e.text ? `${head}\n${e.text.replace(/^/gm, '    ')}` : head)
    }
    store.close()
  })
task
  .command('enqueue <id> [message...]')
  .description('queue a run; the message (answer / feedback) goes to the agent')
  .option('--no-preflight', 'start the first run without the read-only assessment')
  .option('--model <id>', 'run on this model from now on (`default` = back to the default)')
  .option('--out-of-order', 'a part of a split: start without waiting for the part before it')
  .action(
    (
      id: string,
      message: string[],
      opts: { preflight: boolean; model?: string; outOfOrder?: boolean },
    ) => {
      const { store, factory } = openFactory()
      try {
        const model = opts.model === 'default' ? null : opts.model
        const item = factory.enqueue(id, message.join(' '), {
          skipPreflight: !opts.preflight,
          model,
          outOfOrder: opts.outOfOrder,
        })
        const waits = factory.waitsFor(id)
        console.log(waits ? `${item.state}: starts when ${waits.id} is merged` : item.state)
      } finally {
        store.close()
      }
    },
  )
task
  .command('experiment <ids...>')
  .description(
    'mark tasks as experiments (run to try the factory itself): left out of the metrics; --off unmarks',
  )
  .option('--off', 'count them in the metrics again')
  .action((ids: string[], opts: { off?: boolean }) => {
    const { store, factory } = openFactory()
    try {
      for (const id of ids) factory.setExperiment(id, !opts.off)
      console.log(
        `${ids.length} task(s) ${opts.off ? 'count in the metrics again' : 'marked as experiments'}`,
      )
    } finally {
      store.close()
    }
  })
task
  .command('model [id] [model]')
  .description(
    'the model tasks run on. No arguments: the default and the models on offer. `<model>`: set the default (`none` = each config decides). `<task> <model>`: for one task (`default` = no own choice)',
  )
  .action(async (first?: string, second?: string) => {
    const { store, factory } = openFactory()
    try {
      if (first && second) {
        factory.setModel(first, second === 'default' ? null : second)
        const m = await factory.modelOf(first)
        console.log(`${first}: next run on ${m.model} (${m.source})`)
        return
      }
      if (first) factory.setDefaultModel(first === 'none' ? null : first)
      const s = factory.modelSettings()
      console.log(`default model: ${s.default_model ?? "none (each task's config decides)"}`)
      console.log(`on offer (tiller.yaml factory.models): ${s.models.join(', ') || 'none'}`)
    } finally {
      store.close()
    }
  })
task
  .command('review <id>')
  .description(
    "second reader on its own: a read-only agent reads the task's change (or --base..--head of its repo) and reports what tests cannot say; nothing is recorded on the task",
  )
  .option('--base <commit>', "read the change from this commit (default: the task's base)")
  .option('--head <commit>', 'up to this commit (default: the head of the task branch)')
  .option('--json', 'print the report as JSON')
  .option('--task-only', 'give the reader the task text without the human messages that came later')
  .action(
    async (
      id: string,
      opts: { base?: string; head?: string; json?: boolean; taskOnly?: boolean },
    ) => {
      const { store, factory } = openFactory()
      try {
        const item = factory.items.get(id)
        if (!item) throw new Error(`no task ${id}`)
        const head = opts.head ?? (await factory.head(id))
        const r = await factory.readChange(item, opts.base ?? item.base_commit, head, {
          messages: !opts.taskOnly,
        })
        const cost = r.stored.cost_usd === null ? '?' : `$${r.stored.cost_usd.toFixed(3)}`
        if (opts.json) console.log(JSON.stringify({ ...r.stored, text: r.text }, null, 2))
        else
          console.log(
            `${r.text}\n\n(${cost} · ${r.stored.turns ?? '?'} turns · ${Math.round(r.stored.duration_s ?? 0)} s · ${r.stored.run_id})`,
          )
      } finally {
        store.close()
      }
    },
  )
task
  .command('ci <id>')
  .description(
    "what the repository's CI says about the task's pull request; --fix sends the failing checks and the end of their logs to the agent",
  )
  .option('--fix', 'queue a run with the failing checks as its message')
  .action(async (id: string, opts: { fix?: boolean }) => {
    const { store, factory } = openFactory()
    try {
      await factory.syncPrs()
      const ci = factory.items.ci(id)
      if (!ci) return console.log('no CI seen for this task (no pull request, or no token)')
      const failing = ci.failing.map((c) => c.name).join(', ')
      console.log(
        `CI ${ci.state} at ${ci.head.slice(0, 7)} (${ci.total} checks${failing ? `; failing: ${failing}` : ''}; sent to the agent ${ci.attempts}×)`,
      )
      if (opts.fix) {
        await factory.fixCi(id, 'human')
        console.log('queued for the agent; run the worker')
      }
    } finally {
      store.close()
    }
  })
task
  .command('verify <id>')
  .description(
    'verify the task branch again without an agent run (push when it passes); --accept-removed: tests the change removed stop failing it',
  )
  .option('--accept-removed', 'the tests the last verification found removed may go')
  .option(
    '--accept-checks',
    'the changed files that decide the checks (test config, scripts) are fine: no second run with the old ones',
  )
  .action(async (id: string, opts: { acceptRemoved?: boolean; acceptChecks?: boolean }) => {
    const { store, factory } = openFactory()
    try {
      const { accepted, done } = await factory.verifyAgain(id, opts)
      if (accepted.length) console.log(`accepted: ${accepted.join(', ').slice(0, 400)}`)
      await done
      console.log(factory.items.get(id)?.state)
    } finally {
      store.close()
    }
  })
task
  .command('update <id>')
  .description(
    'bring the default branch into the task: clean merge → verify and push; conflicts → queued for the agent',
  )
  .action(async (id: string) => {
    const { store, factory } = openFactory()
    try {
      const { result, done } = await factory.update(id)
      await done
      const state = factory.items.get(id)?.state
      console.log(
        result === 'current'
          ? 'already on the current default branch'
          : result === 'merged'
            ? `merged without conflicts → ${state}`
            : `conflicts: queued for the agent (${state}); run the worker`,
      )
    } finally {
      store.close()
    }
  })
task
  .command('split <id>')
  .description(
    'approve the split the preflight proposed: its parts become tasks, the original is cancelled',
  )
  .action((id: string) => {
    const { store, factory } = openFactory()
    try {
      for (const t of factory.split(id)) console.log(`${t.id}  ${t.state}  ${t.title}`)
    } finally {
      store.close()
    }
  })
task
  .command('import')
  .description('import labelled issues of the tiller.yaml projects now (IMPORTED, not queued)')
  .action(async () => {
    const { store, factory } = openFactory()
    try {
      const { created, errors } = await factory.importIssues()
      if (errors.length) process.exitCode = 1
      for (const i of created) console.log(`${i.id}  ${i.repo}  ${i.title}  ${i.external_url}`)
      console.log(`${created.length} imported`)
    } finally {
      store.close()
    }
  })
task
  .command('manifest <runId>')
  .description(
    'what a run was made of (repo commit, skills, model, image, prompt); --check: can it still be rebuilt',
  )
  .option('--check', 'verify every input is still there and unchanged; exit 1 on drift')
  .action(async (runId: string, opts: { check?: boolean }) => {
    const { store, factory } = openFactory()
    try {
      const { manifest, checks } = await factory.checkRun(runId)
      if (!opts.check) return console.log(JSON.stringify(manifest, null, 2))
      for (const c of checks)
        console.log(`${c.ok ? 'ok   ' : 'DRIFT'}  ${c.what.padEnd(28)}${c.detail}`)
      const drift = checks.filter((c) => !c.ok).length
      console.log(
        drift
          ? `\n${drift} input(s) differ: a rerun would not be the same run`
          : '\nall inputs can be rebuilt unchanged',
      )
      if (drift) process.exitCode = 1
    } finally {
      store.close()
    }
  })
task
  .command('metrics')
  .description('delivery, first pass, human interventions and cost over all tasks')
  .action(() => {
    const { store, factory } = openFactory()
    const m = factory.metrics()
    const pct = (x: number | null) => (x === null ? '—' : `${(x * 100).toFixed(0)}%`)
    const usd = (x: number | null) => (x === null ? '—' : `$${x.toFixed(2)}`)
    const num = (x: number | null) => (x === null ? '—' : x.toFixed(2))
    if (m.experiments) console.log(`(${m.experiments} tasks marked as experiments are left out)\n`)
    for (const f of m.funnel) console.log(`${f.stage.padEnd(28)}${f.tasks}`)
    const row = (key: string, g: (typeof m)['total']) =>
      `${key.padEnd(28)}${String(g.tasks).padEnd(7)}${String(g.delivered).padEnd(11)}${pct(g.firstPassRate).padEnd(12)}${num(g.interventionsPerTask).padEnd(15)}${usd(g.costPerDelivered).padEnd(16)}${usd(g.cost_usd)}`
    console.log(
      `\n${''.padEnd(28)}${'tasks'.padEnd(7)}${'delivered'.padEnd(11)}${'first pass'.padEnd(12)}${'interv./task'.padEnd(15)}${'cost/delivered'.padEnd(16)}cost`,
    )
    console.log(row('all', m.total))
    for (const g of m.byRepo) console.log(row(g.key, g))
    for (const g of m.byConfig) console.log(row(`config ${g.key}`, g))
    for (const g of m.byModel) console.log(row(`model ${g.key}`, g))
    console.log(`\nreview        ${JSON.stringify(m.review)}`)
    console.log(`preflight     ${JSON.stringify(m.preflight)}`)
    console.log(`verification  ${JSON.stringify(m.verification)}`)
    store.close()
  })
task
  .command('sync')
  .description(
    'PR feedback now: queue tasks with a new `/tiller …` PR comment, close merged / closed ones',
  )
  .action(async () => {
    const { store, factory } = openFactory()
    try {
      const { queued, closed, errors } = await factory.syncPrs()
      if (errors.length) process.exitCode = 1
      for (const e of errors) console.error(e)
      console.log(`${queued.length} queued${queued.length ? ` (${queued.join(', ')})` : ''}`)
      console.log(`${closed.length} closed${closed.length ? ` (${closed.join(', ')})` : ''}`)
    } finally {
      store.close()
    }
  })
task
  .command('run')
  .description('execute queued runs in the foreground until the queue is empty')
  .action(async () => {
    const { store, factory } = openFactory()
    if (!factory.canRun) throw new Error('ANTHROPIC_API_KEY not set (.env)')
    try {
      await factory.drain()
    } finally {
      store.close()
    }
  })
for (const [name, fn] of [
  ['complete', (f: Factory, id: string) => f.complete(id)],
  ['cancel', (f: Factory, id: string) => f.cancel(id)],
] as const) {
  task.command(`${name} <id>`).action((id: string) => {
    const { store, factory } = openFactory()
    console.log(fn(factory, id).state)
    store.close()
  })
}
program.command('show <runId>').action(todo('show'))

await program.parseAsync()
