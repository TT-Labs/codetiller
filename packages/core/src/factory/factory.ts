import { randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import type { AgentResult } from '../agents/agent.js'
import { adapterFor } from '../agents/index.js'
import { type Config, configHash, loadConfig } from '../config/config.js'
import { renderContext } from '../context/context.js'
import { overlayContext } from '../context/overlay.js'
import {
  REPO_SKILLS_DIR,
  type ResolvedSkill,
  repoSkill,
  resolveSkills,
} from '../context/resolve.js'
import { contextFileFor, loadSkill } from '../context/skills.js'
import { type RepoProfile, RepoProfileSchema } from '../dataset/task.js'
import { ensureDeps } from '../sandbox/deps.js'
import {
  type GatewayUsage,
  type ModelAccess,
  type ModelGateway,
  modelAccess,
  runAccounted,
} from '../sandbox/gateway.js'
import { type Prices, priceFor } from '../sandbox/prices.js'
import type { Sandbox } from '../sandbox/sandbox.js'
import { missingCommands } from '../transcript/missing.js'
import { sha256 } from '../util/hash.js'
import { runCheck, runTests } from '../verify/tests.js'
import { diffStats, type GitWorkspaces, git } from '../workspace/git.js'
import { detectProfile } from './detect.js'
import { feedbackMessage } from './feedback.js'
import type { CiCheck, CiStatus, Forge, PrComment } from './forge.js'
import { forgeSafe } from './forge-text.js'
import type { Preflight, PrSyncState, WorkItems } from './items.js'
import {
  checkManifest,
  type ManifestCheck,
  type RunManifest,
  readManifest,
  writeManifest,
} from './manifest.js'
import { type FactoryMetrics, factoryMetrics } from './metrics.js'
import { CLOSABLE, parseSignal, QUEUEABLE, type WorkItem, type WorkRun } from './model.js'
import {
  type Onboarding,
  onboardingOk,
  type ProfileSource,
  repoSandbox,
  type SuiteCheck,
} from './onboard.js'
import {
  gate,
  type PreflightLimits,
  parsePreflight,
  REPO_FACTORY_FILE,
  type ResolvedLimits,
  renderPreflight,
  resolveLimits,
  tolerated,
} from './preflight.js'
import { TaskRepo } from './repo.js'
import {
  diffForPrompt,
  parseReview,
  type ReviewReport,
  type ReviewVerdict,
  renderReview,
  reviewVerdict,
} from './review.js'
import type { Project, Tracker } from './tracker.js'
import {
  acceptChecks,
  acceptRemoved,
  type Verification,
  verificationSummary,
  verificationVerdict,
  verifyCommit,
} from './verify.js'

export interface FactoryDeps {
  items: WorkItems
  sandbox: Sandbox
  workspaces: GitWorkspaces
  /** working dir holding datasets/, configs/, skills/, prompts/ */
  root: string
  /**
   * What ships with the factory: `configs/`, `prompts/factory/` and `skills/` are read from here when the
   * working dir has no file of that name, so an installation starts with an empty one and keeps
   * only what it changed.
   */
  defaults?: string
  /** model credentials; undefined = factory can't run agents. With a gateway they never enter an agent container */
  env?: Record<string, string>
  /** Agents reach the model through this and nothing else; without it they get `env` and the open network */
  gateway?: ModelGateway
  /** models a human may choose in place of a config's own (tiller.yaml `factory.models`) */
  models?: string[]
  /** model prices the gateway budgets with; default: the built-in list */
  prices?: Prices
  /** forge credentials stay here, on the host; undefined = no push / PR, human reviews locally */
  forge?: Forge
  /** intake: issues labelled for the factory in `projects` become IMPORTED work items */
  tracker?: Tracker
  projects?: Project[]
  /** read-only assessment before a task's first run; undefined / disabled = runs start directly */
  preflight?: PreflightLimits
  /** factory skills (`name@N`) every task gets, before the repository's and the config's */
  skills?: string[]
  /** second reader: a read-only agent reads every change that passed verification (advisory) */
  review?: { enabled: boolean }
  /**
   * When the repository's CI fails on a task's PR: `ask` (default) = shown, a human sends it to
   * the agent; `auto` = the factory does, at most `max_attempts` times per task; `off` = not read.
   */
  ci?: { fix: 'ask' | 'auto' | 'off'; max_attempts: number }
  maxConcurrent?: number
  log?: (m: string) => void
}

/** Result of one intake pass: new items, plus per-project errors (a bad token, a missing repo). */
export interface Intake {
  created: WorkItem[]
  errors: string[]
}

/** Result of one PR sync pass: item ids queued by a PR comment, closed with their PR, and errors. */
export interface PrSync {
  queued: string[]
  closed: string[]
  errors: string[]
}

export interface CreateWorkItem {
  title: string
  body: string
  repo: string
  dataset: string
  config: string
  /** git ref to branch from; default: remote default branch */
  ref?: string
  /** tracker the item came from (default: manual) */
  source?: string
  external_url?: string
  /** run this task on this model instead of the default */
  model?: string
}

/** Which model a task's next run uses and where that comes from. */
export interface ModelChoice {
  model: string
  /** `task` = chosen for this task; `default` = the factory's default model; `config` = the task's config file */
  source: 'task' | 'default' | 'config'
}

/** settings key: the model tasks run on unless one is chosen for the task */
const DEFAULT_MODEL = 'default_model'
const NAME = /^[a-z0-9][a-z0-9._-]{0,80}$/
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/
// the assessment reads, it does not build: a fraction of a write run's budget
const PREFLIGHT_RUN = { max_turns: 30, timeout_s: 600 }
const exists = (p: string) =>
  access(p).then(
    () => true,
    () => false,
  )

/**
 * Control plane, local: work items, human-built queue, one ephemeral container per run,
 * persistent workspace + agent session per item. The agent never gets tracker/forge credentials;
 * the factory commits its changes after each run (from a git dir the agent can't reach), verifies
 * the commit in a fresh container, opens the draft PR and carries review feedback from the PR back
 * to the agent.
 */
export class Factory {
  private readonly active = new Set<string>()
  private timer: NodeJS.Timeout | undefined
  private intakeTimer: NodeJS.Timeout | undefined
  private importing: Promise<Intake> | undefined
  private syncing: Promise<PrSync> | undefined
  /** when the tracker / forge was last polled and what went wrong (for the status view) */
  private lastIntake: { at: string; errors: string[] } | undefined
  private lastSync: { at: string; errors: string[] } | undefined
  /** only a started worker (ui server, `tiller task run`) executes; other processes just queue */
  private working = false
  readonly items: WorkItems

  constructor(private readonly deps: FactoryDeps) {
    this.items = deps.items
  }

  get canRun() {
    return Boolean(this.deps.env)
  }

  get canImport() {
    return Boolean(this.deps.tracker && this.projects().length)
  }

  get canSync() {
    return Boolean(this.deps.forge)
  }

  /** Is this process doing the work, and can it reach the model and GitHub? */
  status() {
    const states = this.items.list().map((i) => i.state)
    const count = (s: WorkItem['state']) => states.filter((x) => x === s).length
    return {
      /** a worker in this process executes queued runs */
      worker: this.working,
      canRun: this.canRun,
      canImport: this.canImport,
      canSync: this.canSync,
      queued: count('QUEUED'),
      running: count('RUNNING') + count('PREFLIGHT'),
      intake: this.lastIntake ?? null,
      sync: this.lastSync ?? null,
      projects: this.projects().map((p) => ({ repo: p.repo, label: p.label })),
    }
  }

  /**
   * The manifest of a run (or preflight) and whether its inputs can still be
   * rebuilt unchanged: commits in the repo cache, skill files, the image, the stored prompt.
   */
  async checkRun(runId: string): Promise<{ manifest: RunManifest; checks: ManifestCheck[] }> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId)) throw new Error('bad run id')
    const dir = join(this.items.store.artifactsDir, runId)
    const manifest = await readManifest(dir).catch(() => {
      throw new Error(`no manifest for ${runId} (runs before B6 have none)`)
    })
    const { workspaces, sandbox, root } = this.deps
    const nothing = () => null
    const checks = await checkManifest(manifest, {
      hasCommit: (repo, commit) =>
        git(workspaces.repoCache(repo), 'cat-file', '-e', `${commit}^{commit}`).then(
          () => true,
          () => false,
        ),
      factorySkill: (ref) => loadSkill(join(root, 'skills'), ref).then((s) => s.body, nothing),
      repoSkill: (repo, commit, path) =>
        git(workspaces.repoCache(repo), 'show', `${commit}:${path}`).then(
          (text) => repoSkill({ path, text }).body,
          nothing,
        ),
      imageId: async (image) => (await sandbox.imageId?.(image)) ?? null,
      prompt: () => readFile(join(dir, 'prompt.md'), 'utf8').catch(nothing),
    })
    return { manifest, checks }
  }

  /** Delivery, interventions and cost over every task the factory has seen. */
  metrics(): FactoryMetrics {
    const store = this.items.store
    const experiments = this.items.experiments()
    const all = this.items.list()
    return factoryMetrics(
      all
        .filter((item) => !experiments.has(item.id))
        .map((item) => {
          const runs = this.items.runs(item.id)
          return {
            item,
            runs,
            // a task counts under the model of its last run
            model: store.getConfig(runs.at(-1)?.config_id ?? '')?.model,
            events: this.items.events(item.id),
            preflight: this.items.preflight(item.id),
            reviewCost: this.items.reviewCost(item.id),
            pr: this.items.pr(item.id),
          }
        }),
      // tasks marked as experiments are in no figure; how many there are is said
      all.length - all.filter((item) => !experiments.has(item.id)).length,
    )
  }

  /** Models a human may choose from (tiller.yaml `factory.models`), and the default if one is set. */
  modelSettings(): { models: string[]; default_model: string | null } {
    return {
      models: this.deps.models ?? [],
      default_model: this.items.setting(DEFAULT_MODEL) ?? null,
    }
  }

  /** A model outside the offered list is refused here, before anything is queued. */
  private checkModel(model: string) {
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
  private async configFor(item: WorkItem): Promise<Config> {
    const config = await loadConfig(await this.configPath(item.config))
    const { model, source } = this.modelChoice(item.id, config.model)
    // a choice made earlier must still be on offer when the run starts
    if (source !== 'config') this.checkModel(model)
    return { ...config, model }
  }

  /** the gate's limits, for showing an assessment against them; undefined = preflight off */
  get preflightLimits() {
    return this.deps.preflight?.enabled ? this.deps.preflight : undefined
  }

  private log(m: string) {
    this.deps.log?.(m)
  }

  /** Options for a "new task" form: datasets with a sandbox profile, and configs. */
  async options() {
    const { readdir } = await import('node:fs/promises')
    const datasets: string[] = []
    for (const d of await readdir(join(this.deps.root, 'datasets')).catch(() => [])) {
      if (await exists(join(this.deps.root, 'datasets', d, 'profile.yaml'))) datasets.push(d)
    }
    const dirs = [this.deps.root, ...(this.deps.defaults ? [this.deps.defaults] : [])]
    const found = await Promise.all(dirs.map((d) => readdir(join(d, 'configs')).catch(() => [])))
    const configs = [
      ...new Set(
        found
          .flat()
          .filter((f) => f.endsWith('.yaml'))
          .map((f) => f.replace(/\.yaml$/, '')),
      ),
    ]
    return {
      datasets: datasets.sort(),
      configs: configs.sort(),
      ...this.modelSettings(),
      canRun: this.canRun,
      canImport: this.canImport,
      projects: this.projects().map((p) => ({ repo: p.repo, label: p.label })),
    }
  }

  async create(input: CreateWorkItem): Promise<WorkItem> {
    const title = input.title.trim()
    if (!title) throw new Error('title is required')
    if (!REPO.test(input.repo)) throw new Error('repo must be owner/name')
    // no dataset: the profile comes from the repository itself or from its onboarding
    if ((input.dataset && !NAME.test(input.dataset)) || !NAME.test(input.config))
      throw new Error('bad dataset/config')
    if (input.ref && !REF.test(input.ref)) throw new Error('bad ref')
    await loadConfig(await this.configPath(input.config))
    if (input.model) this.checkModel(input.model)
    const cache = await this.deps.workspaces.ensureRepo(input.repo, [])
    await this.deps.workspaces.fetch(input.repo)
    const ref = input.ref ? `origin/${input.ref}` : 'origin/HEAD'
    const base = (await git(cache, 'rev-parse', '--verify', `${ref}^{commit}`)).trim()
    // a task without a sandbox to run in is refused here, not when its first run starts
    await this.profileOf(input.repo, base, input.dataset)
    const item = this.items.create({
      title,
      body: input.body.trim(),
      repo: input.repo,
      dataset: input.dataset,
      config: input.config,
      base_commit: base,
      source: input.source ?? 'manual',
      external_url: input.external_url ?? null,
    })
    if (input.model) this.items.setModel(item.id, input.model)
    return item
  }

  /**
   * Intake: labelled tracker issues become IMPORTED items, once each. Importing never
   * queues a run: a human does that. One failing project doesn't block the others.
   */
  importIssues(): Promise<Intake> {
    this.importing ??= this.doImport().finally(() => {
      this.importing = undefined
    })
    return this.importing
  }

  private async doImport(): Promise<Intake> {
    const { tracker } = this.deps
    const projects = this.projects()
    if (!tracker || !projects.length)
      throw new Error(
        'no tracker configured (a token, and a repository added with `tiller repo add`)',
      )
    const created: WorkItem[] = []
    const errors: string[] = []
    for (const p of projects) {
      try {
        for (const issue of await tracker.ready(p.repo, p.label)) {
          if (this.items.byExternalUrl(issue.url)) continue
          const item = await this.create({
            title: issue.title,
            body: issue.body,
            repo: p.repo,
            dataset: p.profile,
            config: p.config,
            source: 'github',
            external_url: issue.url,
          })
          this.log(`${item.id}: imported ${p.repo}#${issue.number}`)
          created.push(item)
        }
      } catch (e) {
        errors.push(`${p.repo}: ${(e as Error).message}`)
        this.log(`intake ${p.repo}: ${(e as Error).message}`)
      }
    }
    this.lastIntake = { at: new Date().toISOString(), errors }
    return { created, errors }
  }

  /**
   * PR feedback. A `/tiller …` comment from a maintainer on a task's PR is the human
   * queuing a run with that message, each comment once. A merged PR completes the task, a closed
   * one cancels it. One failing PR doesn't block the others.
   */
  syncPrs(): Promise<PrSync> {
    this.syncing ??= this.doSync().finally(() => {
      this.syncing = undefined
    })
    return this.syncing
  }

  private async doSync(): Promise<PrSync> {
    const { forge } = this.deps
    if (!forge) throw new Error('no forge configured (TILLER_GITHUB_TOKEN)')
    const out: PrSync = { queued: [], closed: [], errors: [] }
    const heads = new Map<string, string>()
    for (const { item, pr } of this.items.withPr()) {
      // a running item is picked up on the next pass: its comments stay unseen until then
      if (item.state === 'RUNNING') continue
      try {
        const status = await forge.status(item.repo, pr.number)
        if (status.state === 'closed') {
          const to = status.merged ? 'COMPLETED' : 'CANCELLED'
          if (this.items.transition(item.id, CLOSABLE, to)) {
            const what = status.merged ? 'merged' : 'closed without merge'
            this.items.event(item.id, 'factory', 'pr', `PR #${pr.number} ${what} → ${to}`)
            this.log(`${item.id}: PR #${pr.number} ${what}`)
            out.closed.push(item.id)
            // a part queued behind this one may start now
            this.kick()
          }
          continue
        }
        // behind = the default branch is no longer the commit this branch started from or last
        // merged; conflict = the forge can no longer merge it
        // a failed fetch must not keep the human's comments from being read
        const head = await this.defaultHead(item.repo, heads).catch(() => undefined)
        const before = this.items.prState(item.id)?.sync
        const sync: PrSyncState | undefined = status.conflict
          ? 'conflict'
          : head === undefined
            ? undefined
            : head !== item.base_commit
              ? 'behind'
              : 'current'
        if (sync) this.items.setPrState(item.id, sync)
        if (sync === 'conflict' && before !== 'conflict')
          this.items.event(
            item.id,
            'factory',
            'pr',
            `PR #${pr.number} conflicts with the default branch: update the task to resolve it`,
          )
        // what the repository's own CI says about the commit on the PR; a failure can go back
        // to the agent (on its own with `ci.fix: auto`, else when a human asks)
        const failed = await this.syncCi(item, pr.number, status.head)
        if (failed && (this.deps.ci?.fix ?? 'ask') === 'auto') {
          const sent = await this.fixCi(item.id, 'factory').catch((e: Error) => {
            this.log(`${item.id}: CI failure not sent to the agent: ${e.message}`)
            return false
          })
          if (sent) {
            if (!out.queued.includes(item.id)) out.queued.push(item.id)
            continue
          }
        }
        for (const comment of await forge.comments(item.repo, pr.number)) {
          const message = feedbackMessage(comment)
          if (!message || this.items.feedbackSeen(item.id, comment.source, comment.id)) continue
          // `/tiller ci`: hand the failing CI checks to the agent
          if (/^(fix\s+)?ci\b[.!]?\s*(—.*)?$/is.test(message)) {
            this.items.recordFeedback(item.id, comment.source, comment.id)
            await forge.acknowledge(item.repo, comment).catch(() => {})
            await this.fixCi(item.id, 'human')
            this.log(`${item.id}: /tiller ci from ${comment.author}`)
            if (!out.queued.includes(item.id)) out.queued.push(item.id)
            break
          }
          // `/tiller update`: bring the default branch in, resolve what collides
          if (/^update\b[.!]?\s*(—.*)?$/is.test(message)) {
            this.items.recordFeedback(item.id, comment.source, comment.id)
            await forge.acknowledge(item.repo, comment).catch(() => {})
            const { result } = await this.update(item.id)
            this.log(`${item.id}: /tiller update from ${comment.author} → ${result}`)
            if (result !== 'current' && !out.queued.includes(item.id)) out.queued.push(item.id)
            break
          }
          if (!this.takeFeedback(item.id, comment, message)) break
          this.log(`${item.id}: /tiller from ${comment.author} on PR #${pr.number}`)
          if (!out.queued.includes(item.id)) out.queued.push(item.id)
          // best effort: the run is queued whether or not the reaction lands
          await forge.acknowledge(item.repo, comment).catch(() => {})
        }
      } catch (e) {
        out.errors.push(`${item.id}: ${(e as Error).message}`)
        this.log(`pr sync ${item.id}: ${(e as Error).message}`)
      }
    }
    if (out.queued.length) this.kick()
    this.lastSync = { at: new Date().toISOString(), errors: out.errors }
    return out
  }

  /** set when the forge token turned out to lack permission to read CI: not asked again */
  private ciUnreadable: string | undefined

  /**
   * Read the repository's CI for the commit on the PR and remember it; a change goes on the
   * timeline. True when CI failed on a commit whose failure has not been handed to the agent.
   */
  private async syncCi(item: WorkItem, number: number, head: string | undefined): Promise<boolean> {
    const { forge } = this.deps
    if (!forge?.ci || !head || this.deps.ci?.fix === 'off' || this.ciUnreadable) return false
    let ci: CiStatus
    try {
      ci = await forge.ci(item.repo, head)
    } catch (e) {
      // A token without permission to read CI must not stop the rest of the sync (the PR's
      // comments are read right after this): said once, then CI is left alone in this process.
      if (/not readable with this token/.test((e as Error).message)) {
        this.ciUnreadable = (e as Error).message
        this.log(
          `CI is not followed: the GitHub token may not read check runs or commit statuses (it needs Checks: read and Commit statuses: read; Actions: read for job logs)`,
        )
      } else this.log(`${item.id}: CI not read: ${(e as Error).message}`)
      return false
    }
    const before = this.items.ci(item.id)
    this.items.setCi(item.id, { head, ...ci })
    if (before?.head !== head || before.state !== ci.state) {
      const at = head.slice(0, 7)
      if (ci.state === 'failed')
        this.items.event(
          item.id,
          'factory',
          'pr',
          `CI failed on PR #${number} at ${at}: ${ci.failing.map((c) => c.name).join(', ')}`,
        )
      else if (ci.state === 'passed')
        this.items.event(item.id, 'factory', 'pr', `CI passed on PR #${number} at ${at}`)
    }
    return ci.state === 'failed' && this.items.ci(item.id)?.sent_head !== head
  }

  /**
   * Hand the failing CI checks of the task's PR to the agent: their names and the end of their
   * logs become its next message, and a run is queued. The factory's own verification passed on
   * that commit, so CI checks something verification does not (lint, types, build). Asked for by
   * a human (button, CLI, `/tiller ci`), or by the factory itself with `ci.fix: auto`, which is
   * capped: a loop of agent and CI must end with a human. Returns false when there is nothing to send.
   */
  async fixCi(id: string, by: 'human' | 'factory'): Promise<boolean> {
    const item = this.mustGet(id)
    const { forge } = this.deps
    const ci = this.items.ci(id)
    if (ci?.state !== 'failed') {
      if (by === 'human') throw new Error('CI has not failed on this task (sync first?)')
      return false
    }
    const max = this.deps.ci?.max_attempts ?? 2
    if (by === 'factory' && ci.attempts >= max) {
      if (ci.sent_head !== ci.head) {
        // said once per commit: the cap was reached, a human decides from here
        this.items.ciSent(id, ci.head)
        this.items.event(
          id,
          'factory',
          'state',
          `CI still fails after ${ci.attempts} automatic attempt(s): not sent to the agent again`,
        )
      }
      return false
    }
    // only what the factory pushed: commits someone else added are not the agent's to guess at
    const repo = this.repo(id)
    if ((await repo.exists()) && (await repo.head()) !== ci.head)
      throw new Error('the pull request is at a commit the factory did not push')
    const logs = await Promise.all(
      ci.failing.slice(0, 5).map(async (check) => ({
        check,
        log: (await forge?.ciLog?.(item.repo, check).catch(() => null)) ?? null,
      })),
    )
    if (!this.items.transition(id, ['PR_OPEN', 'REVIEW'], 'QUEUED'))
      throw new Error(`can't queue a ${item.state} task`)
    this.items.ciSent(id, ci.head)
    this.items.event(id, 'factory', 'message', ciMessage(ci.head, logs))
    this.items.event(id, by, 'enqueued', 'CI failed on the pull request')
    this.kick()
    return true
  }

  /**
   * Head of the repo's default branch, fetched once per pass. Uses the repo cache a task's first
   * run created; without one there is nothing to compare, and this is not the place to clone.
   */
  private async defaultHead(repo: string, seen = new Map<string, string>()): Promise<string> {
    const known = seen.get(repo)
    if (known) return known
    const cache = this.deps.workspaces.repoCache(repo)
    if (!(await exists(cache))) throw new Error(`no local copy of ${repo} yet`)
    await this.deps.workspaces.fetch(repo)
    const head = (await git(cache, 'rev-parse', '--verify', 'origin/HEAD^{commit}')).trim()
    seen.set(repo, head)
    return head
  }

  /**
   * Bring the default branch into a task whose base moved (a human asks for it: button, CLI or
   * `/tiller update`). The factory merges with its own git. No collision: verify and push, no
   * agent involved. Collision: the files keep their conflict markers and the agent resolves them
   * in its next run, which then goes through verification like any other. `done` settles when
   * the factory's own part (verify and push of a clean merge) is over.
   */
  async update(
    id: string,
  ): Promise<{ result: 'current' | 'merged' | 'conflict'; done: Promise<void> }> {
    const item = this.mustGet(id)
    const repo = this.repo(id)
    if (!(await repo.exists()))
      throw new Error('the task has not run yet: there is nothing to update')
    const head = await this.defaultHead(item.repo)
    if (head === item.base_commit) {
      this.items.setPrState(id, 'current')
      return { result: 'current', done: Promise.resolve() }
    }
    if (!this.items.transition(id, UPDATABLE, 'RUNNING'))
      throw new Error(`can't update a ${item.state} task`)
    const from = `${item.base_commit.slice(0, 8)} → ${head.slice(0, 8)}`
    try {
      // anything left uncommitted in the workspace would make git refuse the merge
      await repo.commitAll(`tiller: ${id} before update`)
      await repo.fetch(this.deps.workspaces.repoCache(item.repo), head)
      const merged = await repo.merge(head, `tiller: ${id} update from the default branch`)
      // from here the branch is measured against the new base: diff, verification baseline, PR state
      this.items.setBase(id, head)
      await rm(join(repo.holder, 'baseline.json'), { force: true })
      if ('conflicts' in merged) {
        const files = merged.conflicts
        this.items.event(
          id,
          'factory',
          'state',
          `update ${from}: ${files.length} file(s) conflict; queued for the agent`,
        )
        this.items.event(id, 'factory', 'message', conflictMessage(head, files))
        this.items.transition(id, ['RUNNING'], 'QUEUED')
        this.items.event(id, 'human', 'enqueued', 'update from the default branch')
        this.kick()
        return { result: 'conflict', done: Promise.resolve() }
      }
      this.items.event(id, 'factory', 'state', `update ${from}: merged without conflicts`)
    } catch (e) {
      this.items.transition(id, ['RUNNING'], 'FAILED')
      this.items.event(
        id,
        'factory',
        'state',
        `update failed: ${(e as Error).message.slice(0, 500)}`,
      )
      throw e
    }
    // verify and push in the background of this process; the task shows as running meanwhile
    this.active.add(id)
    const done = this.publishUpdate(this.mustGet(id), head)
      .catch((e: Error) => {
        this.items.transition(id, ['RUNNING'], 'FAILED')
        this.items.event(id, 'factory', 'state', `update failed: ${e.message.slice(0, 500)}`)
        this.log(`${id}: update failed: ${e.message}`)
      })
      .finally(() => this.active.delete(id))
    return { result: 'merged', done }
  }

  /** A clean merge of the default branch: verify the result, push it, tell the PR. No agent run. */
  private async publishUpdate(item: WorkItem, base: string) {
    const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)
    const dir = await this.items.store.runDir(
      `${item.id}-update-${stamp}-${randomUUID().slice(0, 6)}`,
    )
    const what = `update to ${base.slice(0, 8)}`
    const d = await this.deliver(item, { label: what, dir }, '', (m) =>
      this.log(`${item.id}: ${m}`),
    )
    // merged cleanly as text but the tests say otherwise: that is a conflict too, and the human
    // asked for an updated task, so it goes to the agent like one
    const broken = !d.pushed && verificationVerdict(d.note) === 'fail'
    if (broken) {
      this.items.event(item.id, 'factory', 'message', brokenMergeMessage(base, d.note))
      this.items.transition(item.id, ['RUNNING'], 'QUEUED')
      this.items.event(item.id, 'human', 'enqueued', 'update from the default branch')
      this.kick()
    } else this.items.transition(item.id, ['RUNNING'], d.pushed ? 'PR_OPEN' : 'REVIEW')
    if (d.pushed) this.items.setPrState(item.id, 'current')
    const pr = this.items.pr(item.id)
    const next = broken
      ? 'The agent is queued to make the change work on the new default branch.'
      : 'Comment `/tiller <instructions>` to have the agent look at it.'
    if (pr && this.deps.forge) {
      const body = d.pushed
        ? `**Updated from the default branch** (${base.slice(0, 7)}): merged without conflicts.\n\n${checks(d)}`
        : `**Update from the default branch (${base.slice(0, 7)}) merged without conflicts but was not pushed.**\n\n${checks(d)}\n\n${next}`
      await this.deps.forge
        .comment(item.repo, pr.number, `${body}\n\n— codetiller · ${item.id}`)
        .catch((e: Error) =>
          this.items.event(
            item.id,
            'factory',
            'pr',
            `PR comment failed: ${e.message.slice(0, 300)}`,
          ),
        )
    }
    this.log(`${item.id}: ${what} → ${this.mustGet(item.id).state}`)
  }

  /**
   * A human asks for the branch to be verified again, without an agent run: after a flaky suite,
   * or to accept tests the change removed. With `acceptRemoved` the tests the last verification
   * found removed stop failing this task's verification; that is a human's call, never the
   * agent's. A verified branch is pushed as after a run. `done` settles when that is over.
   */
  async verifyAgain(
    id: string,
    opts: { acceptRemoved?: boolean; acceptChecks?: boolean } = {},
  ): Promise<{ accepted: string[]; done: Promise<void> }> {
    const item = this.mustGet(id)
    const repo = this.repo(id)
    if (!(await repo.exists())) throw new Error('the task has not run yet: nothing to verify')
    if (!this.items.transition(id, VERIFIABLE, 'RUNNING'))
      throw new Error(`can't verify a ${item.state} task`)
    let accepted: string[] = []
    try {
      if (opts.acceptRemoved) {
        accepted = await acceptRemoved(repo.holder)
        if (!accepted.length) throw new Error('the last verification found no removed tests')
        const names = accepted.slice(0, 10).map((t) => `- ${t}`)
        const more = accepted.length > 10 ? [`- … ${accepted.length - 10} more`] : []
        const head = `accepted: ${accepted.length} test(s) that no longer run may go`
        this.items.event(id, 'human', 'verification', [head, ...names, ...more].join('\n'))
      }
      if (opts.acceptChecks) {
        // the changed test configuration is fine by a human: no second run with the old one
        const files = await acceptChecks(repo.holder)
        if (!files.length) throw new Error('the last verification named no changed check files')
        accepted = [...accepted, ...files]
        const head = `accepted: ${files.length} changed file(s) that decide how the change is checked`
        this.items.event(
          id,
          'human',
          'verification',
          [head, ...files.slice(0, 20).map((f) => `- ${f}`)].join('\n'),
        )
      }
    } catch (e) {
      this.items.transition(id, ['RUNNING'], item.state)
      throw e
    }
    this.active.add(id)
    const done = (async () => {
      const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)
      const dir = await this.items.store.runDir(`${id}-verify-${stamp}-${randomUUID().slice(0, 6)}`)
      const d = await this.deliver(item, { label: 'verified branch', dir }, '', (m) =>
        this.log(`${id}: ${m}`),
      )
      this.items.transition(id, ['RUNNING'], d.pushed ? 'PR_OPEN' : 'REVIEW')
      const pr = this.items.pr(id)
      if (pr)
        await this.reply(
          item,
          pr.number,
          `**Verified again${accepted.length ? `, ${accepted.length} removed test(s) accepted by a human` : ''}.**${d.pushed ? '' : ' Nothing pushed.'}\n\n${checks(d)}\n\n— codetiller · ${id}`,
          undefined,
        )
      this.log(`${id}: verified again → ${this.mustGet(id).state}`)
    })()
      .catch((e: Error) => {
        this.items.transition(id, ['RUNNING'], 'FAILED')
        this.items.event(
          id,
          'factory',
          'state',
          `verification failed to run: ${e.message.slice(0, 500)}`,
        )
      })
      .finally(() => this.active.delete(id))
    return { accepted, done }
  }

  /**
   * Record one PR comment as the human's message and queue the item, atomically. false when the
   * item can't take it now (a run started meanwhile): the comment stays unseen for the next pass.
   */
  private takeFeedback(id: string, comment: PrComment, message: string): boolean {
    return this.items.store.db.transaction(() => {
      const state = this.mustGet(id).state
      if (state !== 'QUEUED') {
        if (!this.items.transition(id, QUEUEABLE, 'QUEUED')) return false
      }
      this.items.recordFeedback(id, comment.source, comment.id)
      this.items.event(id, 'human', 'message', message)
      // an already queued run simply gets one more message
      if (state !== 'QUEUED')
        this.items.event(id, 'human', 'enqueued', `PR comment by ${comment.author}`)
      return true
    })()
  }

  /**
   * Human queues a run, optionally with a message (answer, review feedback, extra instructions).
   * `skipPreflight`: start the first run without the assessment.
   */
  enqueue(
    id: string,
    message?: string,
    /**
     * `model`: run on this model from now on (null = back to the default); omitted = no change.
     * `outOfOrder`: a part of a split starts without waiting for the part before it.
     */
    opts: { skipPreflight?: boolean; model?: string | null; outOfOrder?: boolean } = {},
  ) {
    const item = this.mustGet(id)
    if (!QUEUEABLE.includes(item.state)) throw new Error(`can't enqueue a ${item.state} task`)
    if (opts.model !== undefined) this.setModel(id, opts.model)
    if (opts.outOfOrder && this.waitsFor(id)) {
      const before = this.items.order(id)?.after_id
      this.items.clearAfter(id)
      this.items.event(id, 'human', 'state', `starts without waiting for ${before}`)
    }
    const text = message?.trim()
    if (text) this.items.event(id, 'human', 'message', text)
    if (!this.items.transition(id, QUEUEABLE, 'QUEUED')) throw new Error('task changed, retry')
    if (opts.skipPreflight && this.wantsPreflight(id)) {
      this.items.setPreflight(id, { ...NO_PREFLIGHT, verdict: 'skipped' })
      this.items.event(id, 'human', 'preflight', 'skipped: run without the assessment')
    }
    const waits = this.waitsFor(id)
    this.items.event(
      id,
      'human',
      'enqueued',
      waits ? `starts when ${waits.id} (the part before it) is merged` : null,
    )
    this.kick()
    return this.mustGet(id)
  }

  /** A task is assessed once, before its first write run. */
  private wantsPreflight(id: string) {
    return Boolean(
      this.deps.preflight?.enabled && !this.items.preflight(id) && this.items.runs(id).length === 0,
    )
  }

  /**
   * Human approves the split the preflight proposed (the factory never creates tasks
   * on its own). The parts become tasks, not queued; the original is cancelled.
   */
  split(id: string): WorkItem[] {
    const item = this.mustGet(id)
    const parts = this.items.preflight(id)?.report?.subtasks ?? []
    if (parts.length === 0) throw new Error('the preflight proposed no split for this task')
    if (this.items.runs(id).length > 0) throw new Error("can't split a task that already ran")
    return this.items.store.db.transaction(() => {
      if (!this.items.transition(id, CLOSABLE, 'CANCELLED'))
        throw new Error(`can't split a ${item.state} task`)
      const created = parts.map((part, i) => {
        const context = [
          `Context: part ${i + 1} of ${parts.length} of "${item.title}" (${item.id}).`,
          i > 0 ? 'The earlier parts are expected to be merged before this one starts.' : '',
          item.external_url ? `Original issue: ${item.external_url}` : '',
        ]
        const child = this.items.create({
          title: part.title,
          body: `${part.body.trim()}\n\n${context.filter(Boolean).join(' ')}`,
          repo: item.repo,
          dataset: item.dataset,
          config: item.config,
          base_commit: item.base_commit,
          source: 'split',
          // the parts must not each close the original issue with their PR
          external_url: null,
        })
        this.items.event(child.id, 'factory', 'state', `part ${i + 1} of ${item.id}`)
        return child
      })
      // each part builds on the one before it: it starts only when that one is merged
      created.forEach((child, i) => {
        this.items.setOrder(child.id, {
          after_id: created[i - 1]?.id ?? null,
          parent_id: item.id,
          position: i + 1,
          total: created.length,
        })
      })
      this.items.event(id, 'human', 'state', `split into ${created.map((c) => c.id).join(', ')}`)
      return created
    })()
  }

  complete(id: string) {
    return this.close(id, 'COMPLETED')
  }

  cancel(id: string) {
    return this.close(id, 'CANCELLED')
  }

  private close(id: string, to: 'COMPLETED' | 'CANCELLED') {
    if (!this.items.transition(id, CLOSABLE, to))
      throw new Error(`can't move ${this.mustGet(id).state} task to ${to}`)
    this.items.event(id, 'human', 'state', to)
    // a part queued behind this one may start now
    this.kick()
    return this.mustGet(id)
  }

  /**
   * The task this one waits for: the part before it in a split, until that part is merged or
   * cancelled. Only the start waits; once a task has run, its follow-up runs are its own.
   */
  waitsFor(id: string): WorkItem | undefined {
    const after = this.items.order(id)?.after_id
    if (!after || this.items.runs(id).length > 0) return undefined
    const before = this.items.get(after)
    return before && !['COMPLETED', 'CANCELLED'].includes(before.state) ? before : undefined
  }

  /** What the task page shows of a split: place in the series, and what it waits for. */
  orderOf(id: string) {
    const order = this.items.order(id)
    if (!order) return null
    const waits = this.waitsFor(id)
    return {
      parent: order.parent_id,
      position: order.position,
      total: order.total,
      after: order.after_id,
      waitsFor: waits ? { id: waits.id, state: waits.state } : null,
    }
  }

  /** Tasks run to try the factory itself are left out of the metrics. */
  setExperiment(id: string, on: boolean) {
    const item = this.mustGet(id)
    if (this.items.experiments().has(id) === on) return item
    this.items.setExperiment(id, on)
    this.items.event(
      id,
      'human',
      'state',
      on ? 'marked as an experiment: left out of the metrics' : 'no longer an experiment',
    )
    return item
  }

  workspaceDir(id: string) {
    return join(this.deps.workspaces.cacheDir, 'work', `task-${id}`)
  }

  /** Trusted git for the item: its git dir is never mounted into a container. */
  private repo(id: string) {
    return new TaskRepo(
      join(this.deps.workspaces.cacheDir, 'work', `task-${id}.repo`),
      this.workspaceDir(id),
    )
  }

  private stateDir(id: string) {
    return join(this.deps.workspaces.cacheDir, 'work', `task-${id}.state`)
  }

  /** Whole change so far: base commit → branch head. */
  async diff(id: string): Promise<string> {
    const item = this.mustGet(id)
    const repo = this.repo(id)
    if (!(await repo.exists())) return ''
    return repo.diff(item.base_commit, 'HEAD')
  }

  // ---- worker -------------------------------------------------------------------------------

  /**
   * Daemon mode: drain the human-built queue in the background (polls for items queued by other
   * processes), poll the tracker for newly labelled issues and the forge for PR feedback.
   */
  start(pollMs = 2000, intakeMs = 60_000) {
    for (const id of this.items.recoverInterrupted()) this.log(`${id}: interrupted run → FAILED`)
    this.working = true
    this.timer = setInterval(() => this.kick(), pollMs)
    this.kick()
    // tracker and forge polling share one timer: new labelled issues in, PR feedback in
    const poll = () => {
      if (this.canImport) void this.importIssues().catch((e: Error) => this.log(e.message))
      if (this.canSync) void this.syncPrs().catch((e: Error) => this.log(e.message))
    }
    if (this.canImport || this.canSync) {
      this.intakeTimer = setInterval(poll, intakeMs)
      poll()
    }
  }

  stop() {
    this.working = false
    clearInterval(this.timer)
    clearInterval(this.intakeTimer)
  }

  /**
   * Resolves when no run is in flight, or after `timeout_ms`. A factory that is shutting down
   * ends its containers and then waits here, so each run records how it ended before the
   * database is closed.
   */
  async idle(timeout_ms = 15_000) {
    const end = Date.now() + timeout_ms
    while (this.active.size && Date.now() < end) await new Promise((r) => setTimeout(r, 50))
    return this.active.size === 0
  }

  /** Start queued runs up to maxConcurrent. Never creates work: only executes what a human queued. */
  kick() {
    if (!this.canRun || !this.working) return
    const max = this.deps.maxConcurrent ?? 2
    for (const item of this.items.queued()) {
      if (this.active.size >= max) return
      if (this.active.has(item.id)) continue
      // queued behind the part before it: stays queued until that one is merged
      if (this.waitsFor(item.id)) continue
      this.active.add(item.id)
      this.execute(item.id)
        .catch((e: Error) => this.log(`${item.id}: ${e.message}`))
        .finally(() => {
          this.active.delete(item.id)
          this.kick()
        })
    }
  }

  /** Run until the queue is empty (CLI foreground mode). One worker process at a time. */
  async drain() {
    for (const id of this.items.recoverInterrupted()) this.log(`${id}: interrupted run → FAILED`)
    this.working = true
    this.kick()
    while (this.active.size > 0) await new Promise((r) => setTimeout(r, 500))
    this.working = false
  }

  // ---- one run ------------------------------------------------------------------------------

  async execute(id: string) {
    const limits = this.deps.preflight
    const fail = (e: unknown) => {
      this.items.transition(id, ['PREFLIGHT', 'RUNNING'], 'FAILED')
      this.items.event(id, 'factory', 'state', `run error: ${(e as Error).message.slice(0, 500)}`)
    }
    if (limits && this.wantsPreflight(id)) {
      if (!this.items.transition(id, ['QUEUED'], 'PREFLIGHT')) return
      let go: boolean
      try {
        go = await this.preflight(this.mustGet(id), limits)
      } catch (e) {
        // not the assessment's answer but its plumbing (image, workspace): the run would hit it too
        fail(e)
        throw e
      }
      // the human gate: enqueue again (with answers / to run anyway), split, or cancel
      if (!this.items.transition(id, ['PREFLIGHT'], go ? 'RUNNING' : 'WAITING_FOR_HUMAN')) return
      if (!go) return this.log(`${id}: preflight → WAITING_FOR_HUMAN`)
    } else if (!this.items.transition(id, ['QUEUED'], 'RUNNING')) return
    try {
      await this.runAgent(this.mustGet(id))
    } catch (e) {
      fail(e)
      throw e
    }
  }

  /**
   * Persistent workspace: the first use clones + branches, later ones reuse it. A task that came
   * from the tracker or from a split starts from where the default branch is now, not where it
   * was at import: weeks may have passed, and the earlier parts of a split have been merged.
   */
  private async workspace(item: WorkItem) {
    const repo = this.repo(item.id)
    let current = item
    const made = await repo.exists()
    // A workspace only the read-only assessment has seen holds nothing of the agent's: when the
    // run starts later (a part of a split waited for the one before it), it starts from the
    // default branch as it is then.
    const untouched =
      made && this.items.runs(item.id).length === 0 && (await repo.head()) === item.base_commit
    if (!made || untouched) {
      const cache = await this.deps.workspaces.ensureRepo(item.repo, [item.base_commit])
      if (item.source === 'github' || item.source === 'split') {
        await this.deps.workspaces.fetch(item.repo)
        const head = (await git(cache, 'rev-parse', '--verify', 'origin/HEAD^{commit}')).trim()
        if (head !== item.base_commit) {
          this.items.setBase(item.id, head)
          const moved = `base moved to the current default branch: ${item.base_commit.slice(0, 8)} → ${head.slice(0, 8)}`
          this.items.event(item.id, 'factory', 'state', moved)
          current = this.mustGet(item.id)
        }
      }
      if (made && current.base_commit !== item.base_commit) await repo.dispose()
      if (!made || current.base_commit !== item.base_commit)
        await repo.init(cache, current.base_commit, current.branch)
    }
    return { ws: this.workspaceDir(item.id), repo, item: current }
  }

  /**
   * Skills of a run: factory built-ins, the repository's own, the config's. The
   * repository's are read from the git dir at the base commit: what the agent writes into
   * `.factory/skills` in its workspace never instructs its own next run.
   */
  private async skillsFor(item: WorkItem, config: Config, repo: TaskRepo) {
    return resolveSkills({
      skillsDir: [
        join(this.deps.root, 'skills'),
        ...(this.deps.defaults ? [join(this.deps.defaults, 'skills')] : []),
      ],
      builtin: this.deps.skills ?? [],
      repo: (await repo.files(item.base_commit, REPO_SKILLS_DIR)).filter((f) =>
        f.path.endsWith('.md'),
      ),
      config: config.skills,
    })
  }

  /**
   * The codetiller code doing the work (run manifest): version and git commit of this package's
   * checkout, not of the working dir, which only holds datasets and configs. Resolved once.
   */
  private checkout: Promise<RunManifest['factory']> | undefined
  private factoryInfo() {
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

  /**
   * The preflight limits for one task: the repository's `.factory/factory.yaml` at the base
   * commit (from git, like its skills), over the project entry in tiller.yaml, over the default.
   */
  private async limitsFor(
    item: WorkItem,
    repo: TaskRepo,
    defaults: PreflightLimits,
  ): Promise<ResolvedLimits> {
    const file = (await repo.files(item.base_commit, '.factory')).find(
      (f) => f.path === REPO_FACTORY_FILE,
    )
    const project = this.projects().find((p) => p.repo === item.repo)?.preflight
    return resolveLimits(defaults, project, file?.text)
  }

  /** The inputs of a run, written before the agent starts. */
  private async manifest(
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

  /**
   * Read-only assessment before the first write run; true = go on to the run. The
   * agent reports estimates, the gate is the factory's limits over them. An assessment that
   * itself fails (agent error, unreadable answer) stops at the human gate like a failed one: let
   * through, the first such task was a 32-file change the limits exist to catch.
   */
  private async preflight(queued: WorkItem, defaults: PreflightLimits): Promise<boolean> {
    const env = this.deps.env
    if (!env) throw new Error('no model credentials (ANTHROPIC_API_KEY)')
    const { sandbox, items } = this.deps
    const profile = await this.profile(queued)
    const config = await this.configFor(queued)
    const { ws, repo, item } = await this.workspace(queued)
    const limits = await this.limitsFor(item, repo, defaults)
    if (!limits.enabled) {
      items.setPreflight(item.id, { ...NO_PREFLIGHT, verdict: 'skipped', limits })
      const where = limits.source === 'repository' ? REPO_FACTORY_FILE : 'tiller.yaml'
      items.event(
        item.id,
        'factory',
        'preflight',
        `skipped: turned off for this repository (${where})`,
      )
      return true
    }
    const skills = await this.skillsFor(item, config, repo)
    const messages = items.pendingMessageEvents(item.id)
    const issue = issueText(
      item,
      messages.map((m) => m.text),
    )
    const prompt = (await this.prompt('preflight.md'))
      // the sizes that actually stop a task: limit plus tolerance
      .replaceAll('{{max_files}}', String(tolerated(limits).files))
      .replaceAll('{{max_concepts}}', String(tolerated(limits).concepts))
      .replace('{{issue}}', () => issue)
    const runId = `${item.id}-preflight-${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}-${randomUUID().slice(0, 6)}`
    const dir = await items.store.runDir(runId)
    const promptFile = join(dir, 'prompt.md')
    await writeFile(promptFile, prompt)
    this.log(`${item.id}: preflight (${config.harness} ${config.model})`)

    const assess = { ...config, limits: { ...config.limits, ...PREFLIGHT_RUN } }
    const access = await modelAccess(env, this.deps.gateway, {
      label: `${item.id} preflight`,
      config: assess,
      prices: this.deps.prices,
    })
    const overlay = await overlayContext(ws, contextFileFor(config.harness), skills)
    const manifest = await this.manifest(item, assess, skills, {
      id: runId,
      kind: 'preflight',
      seq: null,
      head: await repo.head(),
      configId: configHash(assess, prompt, skills.length ? renderContext(undefined, skills) : ''),
      image: profile.image,
      access,
      template: 'preflight.md',
      prompt,
      context: overlay.rendered,
      resumed: null,
      messages: messages.map((m) => m.id),
    })
    await writeManifest(dir, manifest)
    const transcript = createWriteStream(join(dir, 'transcript.jsonl'))
    let agent: AgentResult
    let usage: GatewayUsage | undefined
    try {
      ;({ agent, usage } = await runAccounted(access, () =>
        adapterFor(config.harness).run({
          sandbox,
          image: profile.image,
          workspace: ws,
          promptFile,
          readOnly: true,
          config: assess,
          env: access.env,
          network: access.network,
          offline: access.offline,
          onStdout: (c) => transcript.write(c),
        }),
      ))
    } finally {
      await new Promise((r) => transcript.end(r))
      await overlay.restore()
    }
    if (agent.stderr) await writeFile(join(dir, 'agent.stderr.log'), agent.stderr)
    this.noteGateway(item.id, runId, usage)
    const spent = {
      run_id: runId,
      cost_usd: agent.cost_usd,
      turns: agent.turns ?? null,
      duration_s: agent.duration_s,
    }
    let verdict: Preflight['verdict']
    let text: string
    let report: Preflight['report'] = null
    try {
      if (agent.exit !== 'ok') throw new Error(`agent ${agent.exit}`)
      report = parsePreflight(agent.finalText)
      verdict = gate(report, limits)
      text = renderPreflight(report, verdict, limits)
    } catch (e) {
      verdict = 'error'
      const why = (e as Error).message.replace(/\s+/g, ' ').slice(0, 300)
      text = `Preflight failed: ${why}\n\nNext: enqueue again to run without it, or cancel.`
    }
    items.setPreflight(item.id, { verdict, report, limits, ...spent })
    items.event(item.id, 'factory', 'preflight', text, runId)
    await writeManifest(dir, {
      ...manifest,
      result: {
        exit: agent.exit,
        signal: null,
        ...costOf(agent, usage),
        turns: agent.turns ?? null,
        duration_s: agent.duration_s,
        commit: null,
        verification: null,
      },
    })
    this.log(`${item.id}: preflight ${verdict}`)
    return verdict === 'pass'
  }

  private async runAgent(queued: WorkItem) {
    const env = this.deps.env
    if (!env) throw new Error('no model credentials (ANTHROPIC_API_KEY)')
    const { sandbox, items } = this.deps
    const store = items.store
    const profile = await this.profile(queued)
    const config = await this.configFor(queued)

    const { ws, repo, item } = await this.workspace(queued)
    const skills = await this.skillsFor(item, config, repo)
    const stateDir = this.stateDir(item.id)
    await mkdir(stateDir, { recursive: true })
    const nm = await ensureDeps(sandbox, profile, ws, item.repo, (m) =>
      this.log(`${item.id}: ${m}`),
    )

    // context pack (skills) as untracked overlay, restored before committing
    const contextFile = contextFileFor(config.harness)
    const context = skills.length ? renderContext(undefined, skills) : ''
    // symlink-safe: a `CLAUDE.md -> AGENTS.md` link is kept, an agent-planted one is never followed
    const overlay = await overlayContext(ws, contextFile, skills)
    const rendered = overlay.rendered

    const implement = await this.prompt('implement.md')
    const pending = items.pendingMessageEvents(item.id)
    const messages = pending.map((m) => m.text)
    const resume = item.session_id ?? undefined
    // The agent's last commit did not pass verification and a human sends it back: it has to
    // know what failed, whatever the human wrote. (An update or a CI failure says so itself.)
    const lastRun = items.runs(item.id).at(-1)
    const verdict = items
      .events(item.id)
      .findLast((e) => e.kind === 'verification' && e.actor === 'factory')
    const failedLast =
      verdict?.text &&
      verdict.run_id === lastRun?.id &&
      ['fail', 'error'].includes(verificationVerdict(verdict.text))
    if (resume && failedLast && !messages.some((m) => m.includes('verification')))
      messages.unshift(
        `The factory's verification of your last commit did not pass, and nothing was pushed:\n\n${verdict.text}`,
      )
    // replacer functions: `$&`, `$'` or `$$` in an issue or a message must stay literal
    const prompt = resume
      ? (await this.prompt('continue.md')).replace('{{message}}', () =>
          messages.join('\n\n---\n\n'),
        )
      : implement.replace('{{issue}}', () =>
          issueText(item, messages, items.preflight(item.id)?.report?.questions),
        )
    const configId = configHash(config, implement, context)
    store.upsertConfig(configId, config, implement)

    const runId = `${item.id}-${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}-${randomUUID().slice(0, 6)}`
    const dir = await store.runDir(runId)
    const promptFile = join(dir, 'prompt.md')
    await writeFile(promptFile, prompt)
    if (rendered) await writeFile(join(dir, 'context.md'), rendered)
    const run = items.startRun({
      id: runId,
      item_id: item.id,
      config_id: configId,
      session_id: resume ?? null,
    })
    items.event(item.id, 'factory', 'run_started', `run ${run.seq}`, runId)
    this.log(
      `${item.id}: run ${run.seq} (${config.harness} ${config.model}${resume ? ', resumed' : ''})`,
    )

    const before = await repo.head()
    const access = await modelAccess(env, this.deps.gateway, {
      label: `${item.id} run ${run.seq}`,
      config,
      prices: this.deps.prices,
    })
    const manifest = await this.manifest(item, config, skills, {
      id: runId,
      kind: 'run',
      seq: run.seq,
      head: before,
      configId,
      image: profile.image,
      access,
      template: resume ? 'continue.md' : 'implement.md',
      prompt,
      context: rendered,
      resumed: resume ?? null,
      messages: pending.map((m) => m.id),
    })
    await writeManifest(dir, manifest)
    // a PR that exists before the run hears about its outcome; the run that opens it does not
    const openPr = items.pr(item.id)
    const transcript = createWriteStream(join(dir, 'transcript.jsonl'))
    let agent: AgentResult
    let usage: GatewayUsage | undefined
    try {
      ;({ agent, usage } = await runAccounted(access, () =>
        adapterFor(config.harness).run({
          sandbox,
          image: profile.image,
          workspace: ws,
          promptFile,
          volumes: nm.volumes,
          tmpfs: nm.scratch,
          config,
          env: access.env,
          network: access.network,
          offline: access.offline,
          stateDir,
          resumeSession: resume,
          onStdout: (c) => transcript.write(c),
        }),
      ))
    } finally {
      await new Promise((r) => transcript.end(r))
      await overlay.restore()
    }
    if (agent.stderr) await writeFile(join(dir, 'agent.stderr.log'), agent.stderr)
    this.noteGateway(item.id, runId, usage)
    // a tool the image lacks costs the agent turns: surface it as a sandbox defect
    const missing = missingCommands(agent.transcript)
    if (missing.length) {
      const list = missing.map((m) => `${m.command} ×${m.count}`).join(', ')
      items.event(item.id, 'factory', 'state', `sandbox image lacks: ${list}`, runId)
    }

    // factory commits from the trusted git dir; push happens from here too
    const after = await repo.commitAll(`tiller: ${item.id} run ${run.seq}`)
    const patch = after ? await repo.diff(before, after) : ''
    await writeFile(join(dir, 'diff.patch'), patch)
    const stats = diffStats(patch)

    const session = agent.session_id ?? resume ?? null
    if (session) items.setSession(item.id, session)
    const { signal, text } = parseSignal(agent.finalText)
    items.finishRun(runId, {
      session_id: session,
      duration_s: agent.duration_s,
      cost_usd: agent.cost_usd,
      turns: agent.turns ?? null,
      agent_exit: agent.exit,
      signal,
      commit_sha: after ?? null,
      diff_files: stats.files,
      diff_lines: stats.lines,
    })
    const cost = agent.cost_usd === null ? '?' : `$${agent.cost_usd.toFixed(2)}`
    items.event(
      item.id,
      'factory',
      'run_finished',
      `run ${run.seq}: ${agent.exit} · ${cost} · ${agent.turns ?? '?'} turns · ${stats.files} files`,
      runId,
    )

    let reply: string
    if (agent.exit !== 'ok') {
      items.transition(item.id, ['RUNNING'], 'FAILED')
      const why =
        agent.exit === 'budget'
          ? `the run spent its budget of $${config.limits.budget_usd.toFixed(2)}`
          : `agent ${agent.exit}`
      items.event(item.id, 'factory', 'state', `${why}; enqueue again to retry`, runId)
      reply = `**Run ${run.seq} failed** (${why}). Comment \`/tiller\` to retry.`
    } else if (signal === 'needs_human') {
      const question = text || '(no question text)'
      items.event(item.id, 'agent', 'question', question, runId)
      items.transition(item.id, ['RUNNING'], 'WAITING_FOR_HUMAN')
      reply = `**Run ${run.seq}: the agent needs an answer.**\n\n${forgeSafe(question)}\n\nAnswer with a comment starting with \`/tiller\`.`
    } else {
      const note = signal === 'none' ? '\n\n(agent ended without a TILLER: status line)' : ''
      items.event(item.id, 'agent', 'summary', `${text || '(no summary)'}${note}`, runId)
      const d = await this.deliver(item, { run, label: `run ${run.seq}`, dir }, text, (m) =>
        this.log(`${item.id}: ${m}`),
      )
      items.transition(item.id, ['RUNNING'], d.pushed ? 'PR_OPEN' : 'REVIEW')
      reply = [
        d.pushed
          ? `**Run ${run.seq} pushed** ${(after ?? before).slice(0, 7)}.`
          : `**Run ${run.seq} finished, nothing pushed.**`,
        forgeSafe(text) || '(agent gave no summary)',
        checks(d),
        ...(d.pushed ? [] : ['Comment `/tiller <instructions>` to continue.']),
      ].join('\n\n')
    }
    await writeManifest(dir, {
      ...manifest,
      result: {
        exit: agent.exit,
        signal,
        ...costOf(agent, usage),
        turns: agent.turns ?? null,
        duration_s: agent.duration_s,
        commit: after ?? null,
        verification:
          items.events(item.id).findLast((e) => e.kind === 'verification' && e.run_id === runId)
            ?.text ?? null,
      },
    })
    if (openPr)
      await this.reply(item, openPr.number, `${reply}\n\n— codetiller · ${item.id}`, runId)
    this.log(`${item.id}: run ${run.seq} → ${this.mustGet(item.id).state}`)
  }

  /**
   * What the gateway refused of a run goes on the timeline: a refusal is either the budget doing
   * its work or the agent trying something a run has no business doing.
   */
  private noteGateway(itemId: string, runId: string, usage: GatewayUsage | undefined) {
    if (!usage?.refused) return
    const reasons = Object.entries(usage.reasons)
      .map(([why, n]) => `${why}${n > 1 ? ` ×${n}` : ''}`)
      .join('; ')
    this.items.event(
      itemId,
      'factory',
      'state',
      `model gateway refused ${usage.refused} call(s): ${reasons.slice(0, 600)}`,
      runId,
    )
  }

  /** Tell the PR what a run did. A failed comment is a timeline note, never a failed run. */
  private async reply(item: WorkItem, number: number, body: string, runId: string | undefined) {
    try {
      await this.deps.forge?.comment(item.repo, number, body)
    } catch (e) {
      const message = `PR comment failed: ${(e as Error).message.slice(0, 300)}`
      this.items.event(item.id, 'factory', 'pr', message, runId)
    }
  }

  /**
   * Second reader: a read-only agent reads the verified change against the task and
   * says what tests cannot: code that works on the checks instead of the behaviour, and what a
   * maintainer would not merge although the tests pass. Returns its word for the timeline and
   * the PR; undefined when it is off. A head already read is not read again.
   */
  private async secondRead(
    item: WorkItem,
    head: string,
    log: (m: string) => void,
  ): Promise<string | undefined> {
    const env = this.deps.env
    if (!this.deps.review?.enabled || !env) return undefined
    const { items } = this.deps
    const last = items.review(item.id)
    if (last?.head === head && last.report) return renderReview(last.report)
    const result = await this.readChange(item, item.base_commit, head)
    items.addReview({ item_id: item.id, head, ...result.stored })
    items.event(item.id, 'factory', 'review', result.text, result.stored.run_id)
    log(`second reader: ${result.stored.verdict}`)
    return result.text
  }

  /** Head of the task's branch in its trusted git dir. */
  async head(id: string): Promise<string> {
    const repo = this.repo(id)
    if (!(await repo.exists())) throw new Error('the task has not run yet: there is no branch')
    return repo.head()
  }

  /**
   * One reading of `base..head` of a task's repo, on a clean read-only export of `head`. Used
   * after verification, and on its own to try the reader on a change of the past.
   */
  async readChange(
    item: WorkItem,
    base: string,
    head: string,
    /** `messages: false`: the task text alone, without what the human said later (for trying the reader on a past state) */
    opts: { messages?: boolean } = {},
  ) {
    const env = this.deps.env
    if (!env) throw new Error('no model credentials (ANTHROPIC_API_KEY)')
    const { sandbox, items } = this.deps
    const profile = await this.profile(item)
    const config = await this.configFor(item)
    const read = { ...config, limits: { ...config.limits, ...PREFLIGHT_RUN } }
    const repo = this.repo(item.id)
    const said =
      opts.messages === false
        ? []
        : items
            .events(item.id)
            .filter((e) => e.kind === 'message' && e.actor === 'human')
            .map((e) => e.text ?? '')
    const issue = issueText(item, said)
    const diff = await repo.diff(base, head)
    const text = (await this.prompt('review.md'))
      .replace('{{issue}}', () => issue)
      .replace('{{diff}}', () => diffForPrompt(diff))
    const runId = `${item.id}-review-${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}-${randomUUID().slice(0, 6)}`
    const dir = await items.store.runDir(runId)
    const promptFile = join(dir, 'prompt.md')
    await writeFile(promptFile, text)
    await writeFile(join(dir, 'diff.patch'), diff)
    const access = await modelAccess(env, this.deps.gateway, {
      label: `${item.id} review`,
      config: read,
      prices: this.deps.prices,
    })
    const tree = await repo.exportTree(head)
    const manifest = await this.manifest(item, read, [], {
      id: runId,
      kind: 'review',
      seq: null,
      head,
      configId: configHash(read, text, ''),
      image: profile.image,
      access,
      template: 'review.md',
      prompt: text,
      context: '',
      resumed: null,
      messages: [],
    })
    await writeManifest(dir, manifest)
    const transcript = createWriteStream(join(dir, 'transcript.jsonl'))
    let agent: AgentResult
    let usage: GatewayUsage | undefined
    try {
      ;({ agent, usage } = await runAccounted(access, () =>
        adapterFor(config.harness).run({
          sandbox,
          image: profile.image,
          workspace: tree,
          promptFile,
          readOnly: true,
          config: read,
          env: access.env,
          network: access.network,
          offline: access.offline,
          onStdout: (c) => transcript.write(c),
        }),
      ))
    } finally {
      await new Promise((r) => transcript.end(r))
      await rm(tree, { recursive: true, force: true })
    }
    if (agent.stderr) await writeFile(join(dir, 'agent.stderr.log'), agent.stderr)
    let report: ReviewReport | null = null
    let verdict: ReviewVerdict
    let word: string
    try {
      if (agent.exit !== 'ok') throw new Error(`agent ${agent.exit}`)
      report = parseReview(agent.finalText)
      verdict = reviewVerdict(report)
      word = renderReview(report)
    } catch (e) {
      verdict = 'error'
      word = `second reader failed: ${(e as Error).message.replace(/\s+/g, ' ').slice(0, 300)}`
    }
    await writeManifest(dir, {
      ...manifest,
      result: {
        exit: agent.exit,
        signal: null,
        ...costOf(agent, usage),
        turns: agent.turns ?? null,
        duration_s: agent.duration_s,
        commit: null,
        verification: null,
      },
    })
    return {
      text: word,
      report,
      stored: {
        run_id: runId,
        verdict,
        report,
        cost_usd: agent.cost_usd,
        turns: agent.turns ?? null,
        duration_s: agent.duration_s,
      },
    }
  }

  /**
   * After the agent says done: verify the branch head on a clean export, then push + draft PR.
   * Nothing is pushed unless verification passed; either way a human reviews next. `pushed` = the
   * PR now shows the verified head; `note` = the verification verdict (or why there is none).
   */
  private async deliver(
    item: WorkItem,
    /** what is being delivered: an agent run, or a factory update of the branch */
    of: { run?: WorkRun; label: string; dir: string },
    summary: string,
    log: (m: string) => void,
  ): Promise<{ pushed: boolean; note: string; reading?: string }> {
    const { items, sandbox, forge } = this.deps
    const run = { id: of.run?.id }
    const dir = of.dir
    const repo = this.repo(item.id)
    const head = await repo.head()
    if (head === item.base_commit) {
      const note = 'skipped: no changes on the branch'
      items.event(item.id, 'factory', 'verification', note, run.id)
      return { pushed: false, note }
    }
    // a merge committed with its conflict markers is not something to run tests on, let alone push
    const unresolved = await repo.markers(head)
    if (unresolved.length) {
      const note = `verification failed: conflict markers remain in ${unresolved.slice(0, 10).join(', ')}`
      items.event(item.id, 'factory', 'verification', note, run.id)
      return { pushed: false, note }
    }
    let v: Verification
    try {
      const profile = await this.profile(item)
      v = await verifyCommit(
        { sandbox, profile, repo, repoName: item.repo, log },
        item.base_commit,
        head,
      )
    } catch (e) {
      const message = `verification error: ${(e as Error).message.slice(0, 500)}`
      items.event(item.id, 'factory', 'verification', message, run.id)
      return { pushed: false, note: message }
    }
    await writeFile(join(dir, 'verify.log'), v.log)
    const note = verificationSummary(v)
    items.event(item.id, 'factory', 'verification', note, run.id)
    log(`verification ${v.status}`)
    if (v.status !== 'pass') return { pushed: false, note }
    // the tests pass: a second reader says what they cannot. Its word goes to the human with
    // the change; it holds nothing back, and a reader that fails is a note, not a stop.
    const reading = await this.secondRead(item, head, log).catch((e: Error) => {
      const text = `second reader failed: ${e.message.slice(0, 300)}`
      items.event(item.id, 'factory', 'review', text, run.id)
      return text
    })
    if (!forge) return { pushed: false, note, reading }
    try {
      await repo.push(forge.remoteUrl(item.repo), item.branch, forge.gitAuth())
      const existing = items.pr(item.id)
      if (existing) {
        items.event(item.id, 'factory', 'pr', `pushed ${of.label} to ${existing.url}`, run.id)
        // a push does not bring the default branch in: the PR is current only if the task's base
        // is where that branch was last seen (no network here; the next sync looks properly)
        const seen = await git(
          this.deps.workspaces.repoCache(item.repo),
          'rev-parse',
          '--verify',
          'origin/HEAD^{commit}',
        ).then(
          (out) => out.trim(),
          () => undefined,
        )
        if (seen === item.base_commit) items.setPrState(item.id, 'current')
        return { pushed: true, note, reading }
      }
      const pr = await forge.openDraft({
        repo: item.repo,
        head: item.branch,
        title: item.title,
        body: prBody(item, summary, v, reading),
      })
      items.setPr(item.id, pr)
      items.event(item.id, 'factory', 'pr', `draft PR #${pr.number}: ${pr.url}`, run.id)
      log(`draft PR ${pr.url}`)
      return { pushed: true, note, reading }
    } catch (e) {
      const message = `push / PR failed: ${(e as Error).message.slice(0, 500)}`
      items.event(item.id, 'factory', 'pr', message, run.id)
      return { pushed: false, note: `${note}\n\n${message}`, reading }
    }
  }

  // ---- helpers ------------------------------------------------------------------------------

  private mustGet(id: string): WorkItem {
    const item = this.items.get(id)
    if (!item) throw new Error(`no task ${id}`)
    return item
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

  private async profile(item: Pick<WorkItem, 'repo' | 'base_commit' | 'dataset'>) {
    return (await this.profileOf(item.repo, item.base_commit, item.dataset)).profile
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
   * Onboarding: look at a repository, take its own sandbox profile or propose one from what is
   * in it, and check the profile by running it: dependencies installed (through the registry
   * proxy), every suite run once at the head of the default branch. The result is remembered,
   * so tasks of the repository can run before its `.factory/factory.yaml` is merged.
   */
  async onboard(
    repo: string,
    opts: { config: string; label?: string | null; check?: boolean; log?: (m: string) => void },
  ): Promise<Onboarding> {
    if (!REPO.test(repo)) throw new Error('repo must be owner/name')
    await loadConfig(await this.configPath(opts.config))
    const log = opts.log ?? (() => {})
    const { workspaces, sandbox } = this.deps
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
          `sandbox image ${profile.image} is not on this host: build it first (docker build -t ${profile.image} images/base)`,
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
    this.items.setRepo({
      repo,
      // a repository that carries its own profile needs none remembered here
      profile: own ? null : profile,
      config: opts.config,
      label: opts.label === undefined ? (this.items.repo(repo)?.label ?? 'tiller') : opts.label,
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

  /** A file of the working dir, or the one of that name the factory ships with. */
  private async own(...rel: string[]) {
    const mine = join(this.deps.root, ...rel)
    if (!this.deps.defaults || (await exists(mine))) return mine
    return join(this.deps.defaults, ...rel)
  }

  private configPath(name: string) {
    return this.own('configs', `${name}.yaml`)
  }

  private async prompt(name: string) {
    return readFile(await this.own('prompts', 'factory', name), 'utf8')
  }
}

/** Normalized task context for the agent: text only, never tracker credentials. */
function issueText(item: WorkItem, messages: string[], questions: string[] = []): string {
  // what the preflight asked, so the human's answers below make sense to the implementing agent
  const asked = questions.length
    ? `\n\n## Questions raised before the run\n\n${questions.map((q, i) => `${i + 1}. ${q}`).join('\n')}`
    : ''
  const extra = messages.length
    ? `\n\n## Additional instructions from the human\n\n${messages.join('\n\n')}`
    : ''
  return `# ${item.title}\n\n${item.body}${asked}${extra}`
}

const NO_PREFLIGHT = { report: null, run_id: null, cost_usd: null, turns: null, duration_s: null }

/** A run's cost as the manifest records it: the figure, where it is from, and the agent's own. */
function costOf(agent: AgentResult, usage: GatewayUsage | undefined) {
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

/** What the agent is told when the repository's CI failed on the commit it delivered. */
function ciMessage(head: string, logs: { check: CiCheck; log: string | null }[]): string {
  return [
    `CI failed on the pull request for the commit you delivered (${head.slice(0, 7)}). The factory's own verification passed on it, so the failing checks run something verification does not (for example lint, a type check, a build). Failing checks: ${logs.map((l) => l.check.name).join(', ')}.`,
    ...logs.map(({ check, log }) =>
      log
        ? `### ${check.name}: the end of its log\n\n\`\`\`\n${log.slice(-6000)}\n\`\`\``
        : `### ${check.name}\n\nIts log is not available here${check.url ? ` (${check.url})` : ''}. Work out from the repository's CI configuration what this check runs.`,
    ),
    'Fix what the checks complain about. Run the same commands yourself where the sandbox allows it (it has no network), then finish as usual.',
  ].join('\n\n')
}

/** What the agent is told when the factory's merge of the default branch left conflicts. */
function conflictMessage(base: string, files: string[]): string {
  return [
    `The default branch moved while this task was open. The factory merged it (${base.slice(0, 8)}) into your branch and these files have conflicts:`,
    files.map((f) => `- ${f}`).join('\n'),
    'The files contain conflict markers (`<<<<<<<`, `=======`, `>>>>>>>`). Resolve every one so that both your change and what the default branch changed keep working, then run the checks.',
    'The git repository in /workspace is a scratch copy and does not show this merge: work on the files, do not use git to resolve it. Other files changed too, because the default branch moved; that is expected.',
  ].join('\n\n')
}

/** What the agent is told when the default branch merged without conflicts but the tests now fail. */
function brokenMergeMessage(base: string, verdict: string): string {
  return [
    `The default branch moved while this task was open. The factory merged it (${base.slice(0, 8)}) into your branch. There were no textual conflicts, but verification of the merged result fails:`,
    verdict,
    'Make your change work on top of the new default branch (the code around it changed), then run the checks. The git repository in /workspace is a scratch copy and does not show this merge.',
  ].join('\n\n')
}

/** states in which a human may have the branch verified again: it exists and no run is in flight */
const VERIFIABLE: readonly WorkItem['state'][] = ['REVIEW', 'PR_OPEN', 'FAILED']

/** states from which a task's branch may be updated: it exists and no run is in flight */
const UPDATABLE: readonly WorkItem['state'][] = ['WAITING_FOR_HUMAN', 'REVIEW', 'PR_OPEN', 'FAILED']

/** The factory's checks as a PR section: the verification verdict and, if there is one, the second reader's word. */
function checks(d: { note: string; reading?: string }): string {
  // test names, paths and the reader's text all come from agents: neutralized like their other text
  return [
    `## Verification\n\n${forgeSafe(d.note)}`,
    ...(d.reading ? [`## Second reader\n\n${forgeSafe(d.reading)}`] : []),
  ].join('\n\n')
}

function prBody(item: WorkItem, summary: string, v: Verification, reading?: string): string {
  return [
    forgeSafe(summary) || '(agent gave no summary)',
    checks({ note: verificationSummary(v), reading }),
    // what the verdict is worth: the suite ran the agent's own code and tests
    "Verification ran the repository's tests on this change in a sandbox, against the tests that passed before it. It says the tests still run and pass, not that the change is right: the diff is what you review.",
    `Opened by codetiller for ${item.id}; merge is a human decision.${issueRef(item)}`,
  ].join('\n\n')
}

/** `Closes #N` for an issue of the same repo (GitHub links and closes it on merge), else a link. */
export function issueRef(item: Pick<WorkItem, 'repo' | 'external_url'>): string {
  if (!item.external_url) return ''
  const own = item.external_url.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/issues\/(\d+)$/)
  return own && own[1] === item.repo ? `\n\nCloses #${own[2]}` : `\n\nTask: ${item.external_url}`
}
