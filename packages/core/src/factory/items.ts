import type { RepoProfile } from '../dataset/task.js'
import type { Store } from '../store/store.js'
import type { CiCheck, CiStatus } from './forge.js'
import type { Actor, WorkEvent, WorkEventKind, WorkItem, WorkRun, WorkState } from './model.js'
import type { PreflightReport, PreflightVerdict, ResolvedLimits } from './preflight.js'
import type { ReviewReport, ReviewVerdict } from './review.js'

export type NewWorkItem = Omit<
  WorkItem,
  'id' | 'branch' | 'state' | 'session_id' | 'created_at' | 'updated_at'
>

export interface Preflight {
  verdict: PreflightVerdict
  /** the agent's estimates; null when the preflight failed or was skipped */
  report: PreflightReport | null
  /** the limits this task was gated with (they differ per repository); absent on older records */
  limits?: ResolvedLimits | null
  /** artifacts dir of the assessment run */
  run_id: string | null
  cost_usd: number | null
  turns: number | null
  duration_s: number | null
}

/** `behind`: the default branch moved on since the task branched or last merged it; `conflict`: it no longer merges */
export type PrSyncState = 'current' | 'behind' | 'conflict'

export interface StoredCi {
  item_id: string
  /** the commit CI speaks about */
  head: string
  state: CiStatus['state']
  failing: CiCheck[]
  total: number
  /** the commit whose failure was last handed to the agent */
  sent_head: string | null
  attempts: number
  checked_at: string
}

export interface RepoEntry {
  /** GitHub owner/name */
  repo: string
  /** profile proposed at onboarding; null = the repository carries its own */
  profile: RepoProfile | null
  /** configs/<config>.yaml for its tasks */
  config: string
  /** issues with this label are imported; null = no intake */
  label: string | null
  /** the last baseline check: did the profile install and report */
  checked: { at: string; head: string; ok: boolean; summary: string } | null
  added_at: string
}

export interface StoredReview {
  run_id: string
  item_id: string
  /** the commit that was read */
  head: string
  verdict: ReviewVerdict
  report: ReviewReport | null
  cost_usd: number | null
  turns: number | null
  duration_s: number | null
  created_at: string
}

export interface WorkOrder {
  /** the task that must be merged (or cancelled) before this one starts; null = none */
  after_id: string | null
  /** the task that was split */
  parent_id: string
  position: number
  total: number
}

const now = () => new Date().toISOString()

/** Persistence: work items, their runs and the human/agent timeline (shares tiller.db). */
export class WorkItems {
  constructor(readonly store: Store) {}

  private get db() {
    return this.store.db
  }

  create(item: NewWorkItem): WorkItem {
    const id = this.nextId()
    const at = now()
    this.db
      .prepare(
        `INSERT INTO work_items (id, title, body, repo, dataset, config, base_commit, branch, state,
           session_id, source, external_url, created_at, updated_at)
         VALUES (@id, @title, @body, @repo, @dataset, @config, @base_commit, @branch, 'IMPORTED',
           NULL, @source, @external_url, @at, @at)`,
      )
      .run({ ...item, id, branch: `tiller/${id.toLowerCase()}`, at })
    this.event(id, 'human', 'created', null)
    return this.get(id) as WorkItem
  }

  private nextId(): string {
    const row = this.db
      .prepare(
        `SELECT MAX(CAST(substr(id, 3) AS INTEGER)) AS n FROM work_items WHERE id LIKE 'T-%'`,
      )
      .get() as { n: number | null }
    return `T-${(row.n ?? 0) + 1}`
  }

  get(id: string): WorkItem | undefined {
    return this.db.prepare('SELECT * FROM work_items WHERE id = ?').get(id) as WorkItem | undefined
  }

  /** Intake dedupe: the item imported from this tracker issue, if any. */
  byExternalUrl(url: string): WorkItem | undefined {
    return this.db.prepare('SELECT * FROM work_items WHERE external_url = ?').get(url) as
      | WorkItem
      | undefined
  }

  list(): WorkItem[] {
    return this.db.prepare('SELECT * FROM work_items ORDER BY created_at DESC').all() as WorkItem[]
  }

  /** Atomic compare-and-set: false when the item is no longer in one of `from`. */
  transition(id: string, from: readonly WorkState[], to: WorkState): boolean {
    const marks = from.map(() => '?').join(', ')
    const r = this.db
      .prepare(
        `UPDATE work_items SET state = ?, updated_at = ? WHERE id = ? AND state IN (${marks})`,
      )
      .run(to, now(), id, ...from)
    return r.changes === 1
  }

  /** A task that has not started yet moves to a newer base (the default branch moved on). */
  setBase(id: string, commit: string) {
    this.db
      .prepare('UPDATE work_items SET base_commit = ?, updated_at = ? WHERE id = ?')
      .run(commit, now(), id)
  }

  setSession(id: string, sessionId: string) {
    this.db
      .prepare('UPDATE work_items SET session_id = ?, updated_at = ? WHERE id = ?')
      .run(sessionId, now(), id)
  }

  queued(): WorkItem[] {
    return this.db
      .prepare(`SELECT * FROM work_items WHERE state = 'QUEUED' ORDER BY updated_at`)
      .all() as WorkItem[]
  }

  event(itemId: string, actor: Actor, kind: WorkEventKind, text: string | null, runId?: string) {
    this.db
      .prepare(
        'INSERT INTO work_events (item_id, at, actor, kind, text, run_id) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(itemId, now(), actor, kind, text, runId ?? null)
  }

  events(itemId: string): WorkEvent[] {
    return this.db
      .prepare('SELECT * FROM work_events WHERE item_id = ? ORDER BY id')
      .all(itemId) as WorkEvent[]
  }

  /** Human messages since the last run started: the next run's prompt. */
  pendingMessages(itemId: string): string[] {
    return this.pendingMessageEvents(itemId).map((r) => r.text)
  }

  /** The same messages with their event ids (run manifest: which messages a run carried). */
  pendingMessageEvents(itemId: string): { id: number; text: string }[] {
    return this.db
      .prepare(
        `SELECT id, text FROM work_events WHERE item_id = ? AND kind = 'message' AND id > COALESCE(
           (SELECT MAX(id) FROM work_events WHERE item_id = ? AND kind = 'run_started'), 0)
         ORDER BY id`,
      )
      .all(itemId, itemId) as { id: number; text: string }[]
  }

  startRun(run: Pick<WorkRun, 'id' | 'item_id' | 'config_id' | 'session_id'>): WorkRun {
    const seq =
      (
        this.db
          .prepare('SELECT COUNT(*) AS n FROM work_runs WHERE item_id = ?')
          .get(run.item_id) as { n: number }
      ).n + 1
    this.db
      .prepare(
        `INSERT INTO work_runs (id, item_id, seq, config_id, session_id, started_at)
         VALUES (@id, @item_id, @seq, @config_id, @session_id, @started_at)`,
      )
      .run({ ...run, seq, started_at: now() })
    return this.run(run.id) as WorkRun
  }

  finishRun(
    id: string,
    r: Pick<
      WorkRun,
      | 'session_id'
      | 'duration_s'
      | 'cost_usd'
      | 'turns'
      | 'agent_exit'
      | 'signal'
      | 'commit_sha'
      | 'diff_files'
      | 'diff_lines'
    >,
  ) {
    this.db
      .prepare(
        `UPDATE work_runs SET finished_at = @finished_at, session_id = @session_id,
           duration_s = @duration_s, cost_usd = @cost_usd, turns = @turns, agent_exit = @agent_exit,
           signal = @signal, commit_sha = @commit_sha, diff_files = @diff_files,
           diff_lines = @diff_lines
         WHERE id = @id`,
      )
      .run({ ...r, id, finished_at: now() })
  }

  run(id: string): WorkRun | undefined {
    return this.db.prepare('SELECT * FROM work_runs WHERE id = ?').get(id) as WorkRun | undefined
  }

  runs(itemId: string): WorkRun[] {
    return this.db
      .prepare('SELECT * FROM work_runs WHERE item_id = ? ORDER BY seq')
      .all(itemId) as WorkRun[]
  }

  pr(itemId: string): { number: number; url: string } | undefined {
    return this.db.prepare('SELECT number, url FROM work_prs WHERE item_id = ?').get(itemId) as
      | { number: number; url: string }
      | undefined
  }

  setPr(itemId: string, pr: { number: number; url: string }) {
    this.db
      .prepare(
        'INSERT OR REPLACE INTO work_prs (item_id, number, url, created_at) VALUES (?, ?, ?, ?)',
      )
      .run(itemId, pr.number, pr.url, now())
  }

  /** How the task's PR stands against the default branch (last sync); undefined = not checked yet. */
  prState(itemId: string): { sync: PrSyncState; checked_at: string } | undefined {
    return this.db
      .prepare('SELECT sync, checked_at FROM work_pr_state WHERE item_id = ?')
      .get(itemId) as { sync: PrSyncState; checked_at: string } | undefined
  }

  setPrState(itemId: string, sync: PrSyncState) {
    this.db
      .prepare('INSERT OR REPLACE INTO work_pr_state (item_id, sync, checked_at) VALUES (?, ?, ?)')
      .run(itemId, sync, now())
  }

  /** Where a part of a split stands in its series, and the part it waits for (null = the first). */
  order(itemId: string): WorkOrder | undefined {
    return this.db
      .prepare('SELECT after_id, parent_id, position, total FROM work_order WHERE item_id = ?')
      .get(itemId) as WorkOrder | undefined
  }

  setOrder(itemId: string, order: WorkOrder) {
    this.db
      .prepare(
        'INSERT OR REPLACE INTO work_order (item_id, after_id, parent_id, position, total) VALUES (?, ?, ?, ?, ?)',
      )
      .run(itemId, order.after_id, order.parent_id, order.position, order.total)
  }

  /** the task no longer waits for the one before it; its place in the series stays */
  clearAfter(itemId: string) {
    this.db.prepare('UPDATE work_order SET after_id = NULL WHERE item_id = ?').run(itemId)
  }

  /** Tasks run to try the factory itself: left out of the metrics. */
  experiments(): Set<string> {
    const rows = this.db.prepare('SELECT item_id FROM work_experiments').all() as {
      item_id: string
    }[]
    return new Set(rows.map((r) => r.item_id))
  }

  setExperiment(itemId: string, on: boolean) {
    if (on)
      this.db
        .prepare('INSERT OR IGNORE INTO work_experiments (item_id, at) VALUES (?, ?)')
        .run(itemId, now())
    else this.db.prepare('DELETE FROM work_experiments WHERE item_id = ?').run(itemId)
  }

  /** The second reader's latest reading of the task's change; undefined = none yet. */
  review(itemId: string): StoredReview | undefined {
    const row = this.db
      .prepare(
        'SELECT * FROM work_reviews WHERE item_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
      )
      .get(itemId) as (Omit<StoredReview, 'report'> & { report: string | null }) | undefined
    return row && { ...row, report: row.report ? (JSON.parse(row.report) as ReviewReport) : null }
  }

  addReview(r: Omit<StoredReview, 'created_at'>) {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO work_reviews
           (run_id, item_id, head, verdict, report, cost_usd, turns, duration_s, created_at)
         VALUES (@run_id, @item_id, @head, @verdict, @report, @cost_usd, @turns, @duration_s, @created_at)`,
      )
      .run({ ...r, report: r.report ? JSON.stringify(r.report) : null, created_at: now() })
  }

  /** what every reading of the task cost so far */
  reviewCost(itemId: string): number {
    const row = this.db
      .prepare('SELECT COALESCE(SUM(cost_usd), 0) AS usd FROM work_reviews WHERE item_id = ?')
      .get(itemId) as { usd: number }
    return row.usd
  }

  /** The repository's CI on the task's PR, as last seen; undefined = never looked at. */
  ci(itemId: string): StoredCi | undefined {
    const row = this.db.prepare('SELECT * FROM work_ci WHERE item_id = ?').get(itemId) as
      | (Omit<StoredCi, 'failing'> & { failing: string })
      | undefined
    return row && { ...row, failing: JSON.parse(row.failing) as CiCheck[] }
  }

  /** what CI says now; what was already handed to the agent stays */
  setCi(itemId: string, ci: Pick<StoredCi, 'head' | 'state' | 'failing' | 'total'>) {
    this.db
      .prepare(
        `INSERT INTO work_ci (item_id, head, state, failing, total, checked_at)
         VALUES (@item_id, @head, @state, @failing, @total, @at)
         ON CONFLICT(item_id) DO UPDATE SET head = @head, state = @state, failing = @failing, total = @total, checked_at = @at`,
      )
      .run({ item_id: itemId, ...ci, failing: JSON.stringify(ci.failing), at: now() })
  }

  /** the failure of this commit went to the agent */
  ciSent(itemId: string, head: string) {
    this.db
      .prepare('UPDATE work_ci SET sent_head = ?, attempts = attempts + 1 WHERE item_id = ?')
      .run(head, itemId)
  }

  /** A repository added by onboarding; undefined = not added (it may still be in tiller.yaml). */
  repo(repo: string): RepoEntry | undefined {
    const row = this.db.prepare('SELECT * FROM repos WHERE repo = ?').get(repo) as
      | (Omit<RepoEntry, 'profile' | 'checked'> & {
          profile: string | null
          checked: string | null
        })
      | undefined
    return (
      row && {
        ...row,
        profile: row.profile ? (JSON.parse(row.profile) as RepoProfile) : null,
        checked: row.checked ? (JSON.parse(row.checked) as RepoEntry['checked']) : null,
      }
    )
  }

  repos(): RepoEntry[] {
    const rows = this.db.prepare('SELECT repo FROM repos ORDER BY repo').all() as { repo: string }[]
    return rows.map((r) => this.repo(r.repo) as RepoEntry)
  }

  setRepo(r: Omit<RepoEntry, 'added_at'>) {
    this.db
      .prepare(
        `INSERT INTO repos (repo, profile, config, label, checked, added_at)
         VALUES (@repo, @profile, @config, @label, @checked, @at)
         ON CONFLICT(repo) DO UPDATE SET profile = @profile, config = @config, label = @label, checked = @checked`,
      )
      .run({
        repo: r.repo,
        profile: r.profile ? JSON.stringify(r.profile) : null,
        config: r.config,
        label: r.label,
        checked: r.checked ? JSON.stringify(r.checked) : null,
        at: now(),
      })
  }

  removeRepo(repo: string) {
    this.db.prepare('DELETE FROM repos WHERE repo = ?').run(repo)
  }

  /** A factory setting changed from the UI; undefined = never set. */
  setting(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined
    return row?.value
  }

  /** null clears the setting */
  setSetting(key: string, value: string | null) {
    if (value === null) this.db.prepare('DELETE FROM settings WHERE key = ?').run(key)
    else
      this.db
        .prepare('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)')
        .run(key, value, now())
  }

  /** The model a human chose for this task; undefined = the default applies. */
  model(itemId: string): string | undefined {
    const row = this.db.prepare('SELECT model FROM work_models WHERE item_id = ?').get(itemId) as
      | { model: string }
      | undefined
    return row?.model
  }

  /** null = back to the default */
  setModel(itemId: string, model: string | null) {
    if (model === null) this.db.prepare('DELETE FROM work_models WHERE item_id = ?').run(itemId)
    else
      this.db
        .prepare('INSERT OR REPLACE INTO work_models (item_id, model, updated_at) VALUES (?, ?, ?)')
        .run(itemId, model, now())
  }

  /** Open items that have a PR, with it: what the PR sync watches. */
  withPr(): { item: WorkItem; pr: { number: number; url: string } }[] {
    const rows = this.db
      .prepare(
        `SELECT i.*, p.number AS pr_number, p.url AS pr_url FROM work_items i
         JOIN work_prs p ON p.item_id = i.id
         WHERE i.state NOT IN ('COMPLETED', 'CANCELLED') ORDER BY i.created_at`,
      )
      .all() as (WorkItem & { pr_number: number; pr_url: string })[]
    return rows.map(({ pr_number, pr_url, ...item }) => ({
      item,
      pr: { number: pr_number, url: pr_url },
    }))
  }

  /** Was this PR comment already handed to the agent? */
  feedbackSeen(itemId: string, source: string, externalId: number): boolean {
    return Boolean(
      this.db
        .prepare('SELECT 1 FROM work_feedback WHERE item_id = ? AND source = ? AND external_id = ?')
        .get(itemId, source, externalId),
    )
  }

  recordFeedback(itemId: string, source: string, externalId: number) {
    this.db
      .prepare('INSERT INTO work_feedback (item_id, source, external_id, at) VALUES (?, ?, ?, ?)')
      .run(itemId, source, externalId, now())
  }

  preflight(itemId: string): (Preflight & { created_at: string }) | undefined {
    const row = this.db.prepare('SELECT * FROM work_preflights WHERE item_id = ?').get(itemId) as
      | (Omit<Preflight, 'report'> & { report: string | null; created_at: string })
      | undefined
    if (!row) return undefined
    // the column holds `{ report, limits }`; records from before per-repository limits hold the bare report
    const stored = row.report ? (JSON.parse(row.report) as Record<string, unknown>) : null
    const wrapped = stored !== null && ('limits' in stored || 'report' in stored)
    return {
      ...row,
      report: (wrapped ? stored.report : stored) as PreflightReport | null,
      limits: wrapped ? ((stored.limits as ResolvedLimits | undefined) ?? null) : null,
    }
  }

  setPreflight(itemId: string, p: Preflight) {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO work_preflights
           (item_id, run_id, verdict, report, cost_usd, turns, duration_s, created_at)
         VALUES (@item_id, @run_id, @verdict, @report, @cost_usd, @turns, @duration_s, @created_at)`,
      )
      .run({
        run_id: p.run_id,
        verdict: p.verdict,
        cost_usd: p.cost_usd,
        turns: p.turns,
        duration_s: p.duration_s,
        item_id: itemId,
        report:
          p.report || p.limits
            ? JSON.stringify({ report: p.report, limits: p.limits ?? null })
            : null,
        created_at: now(),
      })
  }

  /** Per-item totals for list views: write runs, and what they and the preflight cost. */
  totals(): Map<string, { runs: number; cost_usd: number }> {
    const rows = this.db
      .prepare(
        `SELECT item_id, SUM(runs) AS runs, SUM(cost_usd) AS cost_usd FROM (
           SELECT item_id, COUNT(*) AS runs, COALESCE(SUM(cost_usd), 0) AS cost_usd
           FROM work_runs GROUP BY item_id
           UNION ALL
           SELECT item_id, 0 AS runs, COALESCE(cost_usd, 0) AS cost_usd FROM work_preflights
           UNION ALL
           SELECT item_id, 0 AS runs, COALESCE(cost_usd, 0) AS cost_usd FROM work_reviews
         ) GROUP BY item_id`,
      )
      .all() as { item_id: string; runs: number; cost_usd: number }[]
    return new Map(rows.map((r) => [r.item_id, { runs: r.runs, cost_usd: r.cost_usd }]))
  }

  /** Runs interrupted by a factory restart can't be resumed mid-flight: mark them failed. */
  recoverInterrupted(): string[] {
    const stuck = this.db
      .prepare(`SELECT id FROM work_items WHERE state IN ('RUNNING', 'PREFLIGHT')`)
      .all() as { id: string }[]
    for (const { id } of stuck) {
      this.transition(id, ['RUNNING', 'PREFLIGHT'], 'FAILED')
      this.event(id, 'factory', 'state', 'factory restarted during a run; enqueue again to retry')
    }
    return stuck.map((s) => s.id)
  }
}
