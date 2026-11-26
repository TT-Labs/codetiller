import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { loadConfig } from '../config/config.js'
import { repoSkill } from '../context/resolve.js'
import { loadSkill } from '../context/skills.js'
import { git } from '../workspace/git.js'
import { exists, FactoryBase, NO_PREFLIGHT } from './base.js'
import { Delivery } from './delivery.js'
import type { CreateWorkItem, FactoryDeps } from './deps.js'
import type { WorkItems } from './items.js'
import { checkManifest, type ManifestCheck, type RunManifest, readManifest } from './manifest.js'
import { type FactoryMetrics, factoryMetrics } from './metrics.js'
import { CLOSABLE, QUEUEABLE, type WorkItem } from './model.js'
import { onboardRepo } from './onboarding.js'
import { Runs } from './runs.js'
import { Sync } from './sync.js'

const NAME = /^[a-z0-9][a-z0-9._-]{0,80}$/
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/

/**
 * Control plane, local: work items, human-built queue, one ephemeral container per run,
 * persistent workspace + agent session per item. The agent never gets tracker/forge credentials;
 * the factory commits its changes after each run (from a git dir the agent can't reach), verifies
 * the commit in a fresh container, opens the draft PR and carries review feedback from the PR back
 * to the agent.
 *
 * This class is the queue and what a human does with a task; the work is in its parts: `Runs`
 * (one run), `Delivery` (verify, second reader, push), `Sync` (tracker and forge).
 */
export class Factory {
  private timer: NodeJS.Timeout | undefined
  private intakeTimer: NodeJS.Timeout | undefined
  /** only a started worker (ui server, `tiller task run`) executes; other processes just queue */
  private working = false
  readonly items: WorkItems
  private readonly base: FactoryBase
  private readonly runs: Runs
  private readonly sync: Sync
  private readonly delivery: Delivery

  constructor(private readonly deps: FactoryDeps) {
    this.items = deps.items
    this.base = new FactoryBase(deps)
    this.base.kick = () => this.kick()
    this.delivery = new Delivery(this.base)
    this.runs = new Runs(this.base, this.delivery)
    this.sync = new Sync(this.base, this.delivery, (input) => this.create(input))
  }

  get canRun() {
    return Boolean(this.deps.env)
  }

  get canImport() {
    return Boolean(this.deps.tracker && this.base.projects().length)
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
      intake: this.sync.lastIntake ?? null,
      sync: this.sync.lastSync ?? null,
      projects: this.base.projects().map((p) => ({ repo: p.repo, label: p.label })),
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
      throw new Error(`no manifest for ${runId} (older runs have none)`)
    })
    const { workspaces, sandbox } = this.deps
    const nothing = () => null
    const checks = await checkManifest(manifest, {
      hasCommit: (repo, commit) =>
        git(workspaces.repoCache(repo), 'cat-file', '-e', `${commit}^{commit}`).then(
          () => true,
          () => false,
        ),
      factorySkill: (ref) => loadSkill(this.base.skillDirs(), ref).then((s) => s.body, nothing),
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

  /** the gate's limits, for showing an assessment against them; undefined = preflight off */
  get preflightLimits() {
    return this.deps.preflight?.enabled ? this.deps.preflight : undefined
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
      ...this.base.modelSettings(),
      canRun: this.canRun,
      canImport: this.canImport,
      projects: this.base.projects().map((p) => ({ repo: p.repo, label: p.label })),
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
    await loadConfig(await this.base.configPath(input.config))
    if (input.model) this.base.checkModel(input.model)
    const cache = await this.deps.workspaces.ensureRepo(input.repo, [])
    await this.deps.workspaces.fetch(input.repo)
    const ref = input.ref ? `origin/${input.ref}` : 'origin/HEAD'
    const base = (await git(cache, 'rev-parse', '--verify', `${ref}^{commit}`)).trim()
    // a task without a sandbox to run in is refused here, not when its first run starts
    await this.base.profileOf(input.repo, base, input.dataset)
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
    const item = this.base.mustGet(id)
    if (!QUEUEABLE.includes(item.state)) throw new Error(`can't enqueue a ${item.state} task`)
    if (opts.model !== undefined) this.base.setModel(id, opts.model)
    if (opts.outOfOrder && this.waitsFor(id)) {
      const before = this.items.order(id)?.after_id
      this.items.clearAfter(id)
      this.items.event(id, 'human', 'state', `starts without waiting for ${before}`)
    }
    const text = message?.trim()
    if (text) this.items.event(id, 'human', 'message', text)
    if (!this.items.transition(id, QUEUEABLE, 'QUEUED')) throw new Error('task changed, retry')
    if (opts.skipPreflight && this.base.wantsPreflight(id)) {
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
    return this.base.mustGet(id)
  }

  /**
   * Human approves the split the preflight proposed (the factory never creates tasks
   * on its own). The parts become tasks, not queued; the original is cancelled.
   */
  split(id: string): WorkItem[] {
    const item = this.base.mustGet(id)
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
      throw new Error(`can't move ${this.base.mustGet(id).state} task to ${to}`)
    this.items.event(id, 'human', 'state', to)
    // a part queued behind this one may start now
    this.kick()
    return this.base.mustGet(id)
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
    const item = this.base.mustGet(id)
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

  /** Whole change so far: base commit → branch head. */
  async diff(id: string): Promise<string> {
    const item = this.base.mustGet(id)
    const repo = this.base.repo(id)
    if (!(await repo.exists())) return ''
    return repo.diff(item.base_commit, 'HEAD')
  }

  /**
   * Daemon mode: drain the human-built queue in the background (polls for items queued by other
   * processes), poll the tracker for newly labelled issues and the forge for PR feedback.
   */
  start(pollMs = 2000, intakeMs = 60_000) {
    for (const id of this.items.recoverInterrupted())
      this.base.log(`${id}: interrupted run → FAILED`)
    this.working = true
    this.timer = setInterval(() => this.kick(), pollMs)
    this.kick()
    // tracker and forge polling share one timer: new labelled issues in, PR feedback in
    const poll = () => {
      if (this.canImport) void this.importIssues().catch((e: Error) => this.base.log(e.message))
      if (this.canSync) void this.syncPrs().catch((e: Error) => this.base.log(e.message))
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
    while (this.base.active.size && Date.now() < end) await new Promise((r) => setTimeout(r, 50))
    return this.base.active.size === 0
  }

  /** Start queued runs up to maxConcurrent. Never creates work: only executes what a human queued. */
  kick() {
    if (!this.canRun || !this.working) return
    const max = this.deps.maxConcurrent ?? 2
    for (const item of this.items.queued()) {
      if (this.base.active.size >= max) return
      if (this.base.active.has(item.id)) continue
      // queued behind the part before it: stays queued until that one is merged
      if (this.waitsFor(item.id)) continue
      this.base.active.add(item.id)
      this.execute(item.id)
        .catch((e: Error) => this.base.log(`${item.id}: ${e.message}`))
        .finally(() => {
          this.base.active.delete(item.id)
          this.kick()
        })
    }
  }

  /** Run until the queue is empty (CLI foreground mode). One worker process at a time. */
  async drain() {
    for (const id of this.items.recoverInterrupted())
      this.base.log(`${id}: interrupted run → FAILED`)
    this.working = true
    this.kick()
    while (this.base.active.size > 0) await new Promise((r) => setTimeout(r, 500))
    this.working = false
  }

  /** Head of the task's branch in its trusted git dir. */
  async head(id: string): Promise<string> {
    const repo = this.base.repo(id)
    if (!(await repo.exists())) throw new Error('the task has not run yet: there is no branch')
    return repo.head()
  }

  // ---- parts: what the API, the CLI and the UI call, done elsewhere ---------------------------

  modelSettings() {
    return this.base.modelSettings()
  }

  setDefaultModel(model: string | null) {
    return this.base.setDefaultModel(model)
  }

  setModel(id: string, model: string | null) {
    return this.base.setModel(id, model)
  }

  modelChoice(itemId: string, configModel: string) {
    return this.base.modelChoice(itemId, configModel)
  }

  modelOf(id: string) {
    return this.base.modelOf(id)
  }

  workspaceDir(id: string) {
    return this.base.workspaceDir(id)
  }

  profileOf(repo: string, commit: string, dataset: string) {
    return this.base.profileOf(repo, commit, dataset)
  }

  projects() {
    return this.base.projects()
  }

  importIssues() {
    return this.sync.importIssues()
  }

  syncPrs() {
    return this.sync.syncPrs()
  }

  fixCi(id: string, by: 'human' | 'factory') {
    return this.sync.fixCi(id, by)
  }

  update(id: string) {
    return this.sync.update(id)
  }

  verifyAgain(id: string, opts: { acceptRemoved?: boolean; acceptChecks?: boolean } = {}) {
    return this.sync.verifyAgain(id, opts)
  }

  execute(id: string) {
    return this.runs.execute(id)
  }

  readChange(item: WorkItem, base: string, head: string, opts: { messages?: boolean } = {}) {
    return this.delivery.readChange(item, base, head, opts)
  }

  onboard(
    repo: string,
    opts: { config: string; label?: string | null; check?: boolean; log?: (m: string) => void },
  ) {
    return onboardRepo(this.base, repo, opts)
  }
}
