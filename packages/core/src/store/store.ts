import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import type { Config } from '../config/config.js'
import type { Task } from '../dataset/task.js'
import type { CheckResult } from '../score/score.js'
import { sha256 } from '../util/hash.js'

import { type Migrated, migrate } from './migrate.js'

export interface BenchmarkRecord {
  id: string
  name: string | null
  dataset: string
  split: string | null
  repeats: number
  started_at: string | null
  finished_at: string | null
  config_id: string
  config_name: string | null
  harness: string
  model: string
  skills: string[]
  runs: number
  successes: number
  cost_usd: number
}

export interface RunRecord {
  id: string
  task_id: string
  config_id: string
  benchmark_id: string | null
  repeat: number
  started_at: string
  duration_s: number | null
  cost_usd: number | null
  cost_source: string | null
  input_tokens: number | null
  output_tokens: number | null
  turns: number | null
  agent_exit: string | null
  diff_files: number | null
  diff_lines: number | null
  outcome: string | null
  score: number | null
}

export interface CheckRecord {
  run_id: string
  name: string
  passed: boolean
  total: number | null
  failed: number | null
  duration_s: number | null
}

export interface ConfigRecord {
  id: string
  name: string | null
  harness: string
  harness_version: string | null
  model: string
  skills: string[]
  prompt_template_hash: string
  limits: Record<string, number>
  created_at: string
}

export class Store {
  readonly db: Database.Database
  /** schema version found and reached when this store was opened */
  readonly migrated: Migrated

  constructor(
    dbPath: string,
    readonly artifactsDir: string,
  ) {
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
    this.migrated = migrate(this.db, dbPath)
  }

  async runDir(runId: string): Promise<string> {
    const dir = join(this.artifactsDir, runId)
    await mkdir(join(dir, 'checks'), { recursive: true })
    return dir
  }

  upsertTask(task: Task, dataset: string) {
    this.db
      .prepare(
        `INSERT INTO tasks (id, dataset, repo, base_commit, tags, difficulty, spec_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET base_commit=excluded.base_commit, tags=excluded.tags,
           difficulty=excluded.difficulty, spec_hash=excluded.spec_hash`,
      )
      .run(
        task.id,
        dataset,
        task.repo,
        task.base_commit,
        JSON.stringify(task.tags),
        task.difficulty ?? null,
        task.spec_hash,
      )
  }

  upsertConfig(id: string, config: Config, promptTemplate: string) {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO configs (id, name, harness, model, skills, prompt_template_hash, limits, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        config.name,
        config.harness,
        config.model,
        JSON.stringify(config.skills),
        sha256(promptTemplate),
        JSON.stringify(config.limits),
        new Date().toISOString(),
      )
  }

  insertRun(run: Record<string, unknown> & { id: string }, checks: CheckResult[]) {
    const cols = Object.keys(run)
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO runs (${cols.map((c) => `"${c}"`).join(',')}) VALUES (${cols.map((c) => `@${c}`).join(',')})`,
        )
        .run(run)
      const ins = this.db.prepare(
        'INSERT INTO checks (run_id, name, passed, total, failed, duration_s) VALUES (?, ?, ?, ?, ?, ?)',
      )
      for (const c of checks)
        ins.run(
          run.id,
          c.name,
          c.passed ? 1 : 0,
          c.total ?? null,
          c.failed ?? null,
          c.duration_s ?? null,
        )
    })
    tx()
  }

  createBenchmark(b: {
    id: string
    name: string
    dataset: string
    config_id: string
    split: string
    repeats: number
  }) {
    this.db
      .prepare(
        'INSERT INTO benchmarks (id, name, dataset, config_id, split, repeats, started_at) VALUES (@id, @name, @dataset, @config_id, @split, @repeats, @started_at)',
      )
      .run({ ...b, started_at: new Date().toISOString() })
  }

  finishBenchmark(id: string) {
    this.db
      .prepare('UPDATE benchmarks SET finished_at = ? WHERE id = ?')
      .run(new Date().toISOString(), id)
  }

  /** by id, else latest benchmark with that name */
  findBenchmark(nameOrId: string): { id: string; name: string } | undefined {
    return this.db
      .prepare(
        'SELECT id, name FROM benchmarks WHERE id = ? OR name = ? ORDER BY started_at DESC LIMIT 1',
      )
      .get(nameOrId, nameOrId) as { id: string; name: string } | undefined
  }

  benchmarkRuns(benchmarkId: string) {
    return this.db
      .prepare('SELECT task_id, outcome, cost_usd, duration_s FROM runs WHERE benchmark_id = ?')
      .all(benchmarkId) as {
      task_id: string
      outcome: string
      cost_usd: number | null
      duration_s: number | null
    }[]
  }

  benchmarkSkills(benchmarkId: string): string[] {
    const r = this.db
      .prepare(
        'SELECT c.skills FROM benchmarks b JOIN configs c ON c.id = b.config_id WHERE b.id = ?',
      )
      .get(benchmarkId) as { skills: string } | undefined
    return r ? (JSON.parse(r.skills) as string[]) : []
  }

  failedRuns(benchmarkId: string) {
    return this.db
      .prepare(
        "SELECT id, task_id FROM runs WHERE benchmark_id = ? AND outcome != 'success' ORDER BY task_id",
      )
      .all(benchmarkId) as { id: string; task_id: string }[]
  }

  // --- read side (dashboard / API) ---

  /** benchmarks with config and aggregates, newest first */
  listBenchmarks(): BenchmarkRecord[] {
    return (
      this.db
        .prepare(
          `SELECT b.id, b.name, b.dataset, b.split, b.repeats, b.started_at, b.finished_at,
                  c.id AS config_id, c.name AS config_name, c.harness, c.model, c.skills,
                  COUNT(r.id) AS runs,
                  COALESCE(SUM(r.outcome = 'success'), 0) AS successes,
                  COALESCE(SUM(r.cost_usd), 0) AS cost_usd
           FROM benchmarks b JOIN configs c ON c.id = b.config_id
           LEFT JOIN runs r ON r.benchmark_id = b.id
           GROUP BY b.id ORDER BY b.started_at DESC`,
        )
        .all() as (Omit<BenchmarkRecord, 'skills'> & { skills: string })[]
    ).map((b) => ({ ...b, skills: JSON.parse(b.skills) as string[] }))
  }

  getBenchmark(id: string): BenchmarkRecord | undefined {
    return this.listBenchmarks().find((b) => b.id === id)
  }

  runsOf(benchmarkId: string): RunRecord[] {
    return this.db
      .prepare('SELECT * FROM runs WHERE benchmark_id = ? ORDER BY task_id, repeat')
      .all(benchmarkId) as RunRecord[]
  }

  getRun(id: string): RunRecord | undefined {
    return this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as RunRecord | undefined
  }

  runChecks(runId: string): CheckRecord[] {
    return (
      this.db.prepare('SELECT * FROM checks WHERE run_id = ? ORDER BY name').all(runId) as (Omit<
        CheckRecord,
        'passed'
      > & { passed: number })[]
    ).map((c) => ({ ...c, passed: c.passed === 1 }))
  }

  /** every run of a dataset's tasks with model and fail_to_pass check (curation evidence) */
  datasetRuns(dataset: string) {
    return this.db
      .prepare(
        `SELECT r.id, r.task_id, r.outcome, c.model, k.total AS f2p_total, k.failed AS f2p_failed
         FROM runs r JOIN tasks t ON t.id = r.task_id JOIN configs c ON c.id = r.config_id
         LEFT JOIN checks k ON k.run_id = r.id AND k.name = 'fail_to_pass'
         WHERE t.dataset = ? ORDER BY r.task_id, r.started_at`,
      )
      .all(dataset) as {
      id: string
      task_id: string
      outcome: string | null
      model: string
      f2p_total: number | null
      f2p_failed: number | null
    }[]
  }

  /** benchmarks of a dataset that have runs, oldest first */
  datasetBenchmarks(dataset: string): BenchmarkRecord[] {
    return this.listBenchmarks()
      .filter((b) => b.dataset === dataset && b.runs > 0)
      .reverse()
  }

  taskDataset(taskId: string): string | undefined {
    const r = this.db.prepare('SELECT dataset FROM tasks WHERE id = ?').get(taskId) as
      | { dataset: string }
      | undefined
    return r?.dataset
  }

  getConfig(id: string): ConfigRecord | undefined {
    const c = this.db.prepare('SELECT * FROM configs WHERE id = ?').get(id) as
      | (Omit<ConfigRecord, 'skills' | 'limits'> & { skills: string; limits: string })
      | undefined
    return c && { ...c, skills: JSON.parse(c.skills), limits: JSON.parse(c.limits) }
  }

  close() {
    this.db.close()
  }
}
