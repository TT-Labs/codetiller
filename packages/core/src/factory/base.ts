import { access, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import type { AgentResult } from '../agents/agent.js'
import { type Config, loadConfig } from '../config/config.js'
import type { ResolvedSkill } from '../context/resolve.js'
import { type RepoProfile, RepoProfileSchema } from '../profile/profile.js'
import type { GatewayUsage, ModelAccess } from '../sandbox/gateway.js'
import { priceFor } from '../sandbox/prices.js'
import { sha256 } from '../util/hash.js'
import { git } from '../workspace/git.js'
import type { FactoryDeps, ModelChoice } from './deps.js'
import type { WorkItems } from './items.js'
import type { RunManifest } from './manifest.js'
import type { WorkItem } from './model.js'
import { type ProfileSource, repoSandbox } from './onboard.js'
import { REPO_FACTORY_FILE } from './preflight.js'
import { TaskRepo } from './repo.js'
import type { Project } from './tracker.js'

const DEFAULT_MODEL = 'default_model'
// the assessment reads, it does not build: a fraction of a write run's budget
export const PREFLIGHT_RUN = { max_turns: 30, timeout_s: 600 }
export const exists = (p: string) =>
  access(p).then(
    () => true,
    () => false,
  )

/**
 * What every part of the factory stands on: its dependencies, where a task's files are, which
 * config, model and sandbox profile a task runs with, and what a run was made of.
 */
export class FactoryBase {
  readonly items: WorkItems
  /** tasks with a run, an update or a verification in flight in this process */
  readonly active = new Set<string>()
  /** start what is queued; set by the `Factory` that owns the queue */
  kick: () => void = () => {}

  constructor(readonly deps: FactoryDeps) {
    this.items = deps.items
  }

  /** Where a factory skill `name@N` is looked for: the working dir, then what ships. */
  skillDirs() {
    return [
      join(this.deps.root, 'skills'),
      ...(this.deps.defaults ? [join(this.deps.defaults, 'skills')] : []),
    ]
  }

  log(m: string) {
    this.deps.log?.(m)
  }

  mustGet(id: string): WorkItem {
    const item = this.items.get(id)
    if (!item) throw new Error(`no task ${id}`)
    return item
  }

  /** A file of the working dir, or the one of that name the factory ships with. */
  async own(...rel: string[]) {
    const mine = join(this.deps.root, ...rel)
    if (!this.deps.defaults || (await exists(mine))) return mine
    return join(this.deps.defaults, ...rel)
  }

  configPath(name: string) {
    return this.own('configs', `${name}.yaml`)
  }

  async prompt(name: string) {
    return readFile(await this.own('prompts', 'factory', name), 'utf8')
  }

  workspaceDir(id: string) {
    return join(this.deps.workspaces.cacheDir, 'work', `task-${id}`)
  }

  /** Trusted git for the item: its git dir is never mounted into a container. */
  repo(id: string) {
    return new TaskRepo(
      join(this.deps.workspaces.cacheDir, 'work', `task-${id}.repo`),
      this.workspaceDir(id),
    )
  }

  stateDir(id: string) {
    return join(this.deps.workspaces.cacheDir, 'work', `task-${id}.state`)
  }

  /**
   * Repositories the factory takes issues from: the ones onboarded (`tiller repo add`) and the
   * ones listed in tiller.yaml; an onboarded entry wins.
   */
  projects(): Project[] {
    const onboarded = this.items
      .repos()
      .filter((r) => r.label)
      .map((r) => ({ repo: r.repo, profile: '', config: r.config, label: r.label as string }))
    const listed = (this.deps.projects ?? []).filter(
      (p) => !onboarded.some((o) => o.repo === p.repo),
    )
    return [...onboarded, ...listed]
  }

  /**
   * The sandbox profile of a task: the repository's own (`.factory/factory.yaml` → `sandbox`,
   * read from git at the task's base commit, so an agent cannot change the sandbox it runs in),
   * else the one proposed when the repository was onboarded, else a profile of the factory's
   * own checkout (`datasets/<name>/profile.yaml`: how repositories were set up before).
   */
  async profileOf(
    repo: string,
    commit: string,
    dataset: string,
  ): Promise<{ profile: RepoProfile; source: ProfileSource }> {
    const cache = this.deps.workspaces.repoCache(repo)
    const file = await git(cache, 'show', `${commit}:${REPO_FACTORY_FILE}`).catch(() => undefined)
    const own = repoSandbox(file)
    if (own) return { profile: own, source: 'repository' }
    const onboarded = this.items.repo(repo)?.profile
    if (onboarded) return { profile: onboarded, source: 'onboarding' }
    if (dataset) {
      const raw = await readFile(
        join(this.deps.root, 'datasets', dataset, 'profile.yaml'),
        'utf8',
      ).catch(() => undefined)
      if (raw !== undefined)
        return { profile: RepoProfileSchema.parse(parse(raw)), source: 'factory' }
    }
    throw new Error(
      `no sandbox profile for ${repo}: add \`sandbox:\` to ${REPO_FACTORY_FILE} in the repository, or run \`tiller repo add ${repo}\``,
    )
  }

  async profile(item: Pick<WorkItem, 'repo' | 'base_commit' | 'dataset'>) {
    return (await this.profileOf(item.repo, item.base_commit, item.dataset)).profile
  }

  /** Models a human may choose from (tiller.yaml `factory.models`), and the default if one is set. */
  modelSettings(): { models: string[]; default_model: string | null } {
    return {
      models: this.deps.models ?? [],
      default_model: this.items.setting(DEFAULT_MODEL) ?? null,
    }
  }

  /** A model outside the offered list is refused here, before anything is queued. */
  checkModel(model: string) {
    if (!(this.deps.models ?? []).includes(model))
      throw new Error(
        `model ${model.slice(0, 80)} is not offered: add it to factory.models in tiller.yaml`,
      )
    if (!priceFor(model, this.deps.prices))
      throw new Error(`model ${model} has no price: add it under prices in tiller.yaml`)
  }

  /** The model tasks run on unless one is chosen for the task; null = each task's config decides. */
  setDefaultModel(model: string | null) {
    if (model !== null) this.checkModel(model)
    this.items.setSetting(DEFAULT_MODEL, model)
    return this.modelSettings()
  }

  /** Choose the model of one task; applies from its next run. null = back to the default. */
  setModel(id: string, model: string | null) {
    const item = this.mustGet(id)
    if (model !== null) this.checkModel(model)
    if ((this.items.model(id) ?? null) === model) return item
    this.items.setModel(id, model)
    const text = model ? `model for the next runs: ${model}` : 'model for the next runs: default'
    this.items.event(id, 'human', 'state', text)
    return item
  }

  /** Task's choice, then the factory default, then the config file. */
  modelChoice(itemId: string, configModel: string): ModelChoice {
    const own = this.items.model(itemId)
    if (own) return { model: own, source: 'task' }
    const standard = this.items.setting(DEFAULT_MODEL)
    if (standard) return { model: standard, source: 'default' }
    return { model: configModel, source: 'config' }
  }

  /** What the task page shows: the model of the next run, and what it is without an own choice. */
  async modelOf(id: string): Promise<ModelChoice & { chosen: string | null; fallback: string }> {
    const item = this.mustGet(id)
    const config = await loadConfig(await this.configPath(item.config))
    return {
      ...this.modelChoice(id, config.model),
      chosen: this.items.model(id) ?? null,
      fallback: this.items.setting(DEFAULT_MODEL) ?? config.model,
    }
  }

  /**
   * The task's config with the model its next run uses. The config file keeps harness, skills
   * and limits; only the model is replaced, and the result is what gets hashed and recorded.
   */
  async configFor(item: WorkItem): Promise<Config> {
    const config = await loadConfig(await this.configPath(item.config))
    const { model, source } = this.modelChoice(item.id, config.model)
    // a choice made earlier must still be on offer when the run starts
    if (source !== 'config') this.checkModel(model)
    return { ...config, model }
  }

  /** A task is assessed once, before its first write run. */
  wantsPreflight(id: string) {
    return Boolean(
      this.deps.preflight?.enabled && !this.items.preflight(id) && this.items.runs(id).length === 0,
    )
  }

  /**
   * The codetiller code doing the work (run manifest): version and git commit of this package's
   * checkout, not of the working dir, which only holds datasets and configs. Resolved once.
   */
  checkout: Promise<RunManifest['factory']> | undefined
  factoryInfo() {
    this.checkout ??= (async () => {
      // src/factory or dist/factory → the package root
      const pkgDir = fileURLToPath(new URL('../..', import.meta.url))
      const commit = await git(pkgDir, 'rev-parse', 'HEAD').then(
        (s) => s.trim(),
        () => null,
      )
      const dirty = commit ? Boolean((await git(pkgDir, 'status', '--porcelain')).trim()) : false
      const pkg = await readFile(join(pkgDir, 'package.json'), 'utf8').then(
        (s) => JSON.parse(s) as { version?: string },
        () => ({}) as { version?: string },
      )
      return { version: pkg.version ?? 'unknown', commit, dirty }
    })()
    return this.checkout
  }

  /** The inputs of a run, written before the agent starts. */
  async manifest(
    item: WorkItem,
    config: Config,
    skills: ResolvedSkill[],
    r: {
      id: string
      kind: RunManifest['run']['kind']
      seq: number | null
      head: string
      configId: string
      image: string
      access: ModelAccess
      template: string
      prompt: string
      context: string
      resumed: string | null
      messages: number[]
    },
  ): Promise<RunManifest> {
    const readOnly = r.kind !== 'run'
    return {
      schema: 1,
      run: { id: r.id, kind: r.kind, seq: r.seq, started_at: new Date().toISOString() },
      task: {
        id: item.id,
        title: item.title,
        source: item.source,
        external_url: item.external_url,
      },
      repo: {
        name: item.repo,
        branch: item.branch,
        base_commit: item.base_commit,
        head_before: r.head,
      },
      factory: await this.factoryInfo(),
      agent: {
        harness: config.harness,
        model: config.model,
        config: config.name,
        config_id: r.configId,
        limits: config.limits,
        resumed_session: r.resumed,
      },
      sandbox: {
        image: r.image,
        image_id: (await this.deps.sandbox.imageId?.(r.image)) ?? null,
        workspace: readOnly ? 'read-only' : 'read-write',
        network: r.access.network ?? 'bridge',
        model_access: r.access.via,
        disallowed_tools: [
          'WebFetch',
          'WebSearch',
          ...(readOnly ? ['Edit', 'Write', 'NotebookEdit'] : []),
        ],
      },
      prompt: { template: r.template, sha256: sha256(r.prompt) },
      skills: skills.map(({ name, source, ref, sha256: hash, tokens }) => ({
        name,
        source,
        ref,
        sha256: hash,
        tokens,
      })),
      context_sha256: r.context ? sha256(r.context) : null,
      human_messages: r.messages,
    }
  }
}

export const NO_PREFLIGHT = {
  report: null,
  run_id: null,
  cost_usd: null,
  turns: null,
  duration_s: null,
}

/** A run's cost as the manifest records it: the figure, where it is from, and the agent's own. */
export function costOf(agent: AgentResult, usage: GatewayUsage | undefined) {
  return {
    cost_usd: agent.cost_usd,
    cost_source: agent.cost_source,
    ...(usage
      ? {
          agent_cost_usd: agent.agent_cost_usd ?? null,
          gateway: { requests: usage.requests, refused: usage.refused, tokens: usage.tokens },
        }
      : {}),
  }
}
