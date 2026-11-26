import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse } from 'yaml'
import { z } from 'zod'

export interface AuditRun {
  outcome: string | null
  /** fail_to_pass check of the run, when it was verified */
  f2p?: { total: number; failed: number }
  /** files the agent's patch touches */
  files: string[]
}

/**
 * What a task can tell: `saturated` (always solved) and `unsolved` (never) carry no rerun noise and
 * move only if a config changes them; `discriminating` tasks differ between runs.
 */
export type Resolution = 'saturated' | 'unsolved' | 'discriminating' | 'unknown'

export interface TaskAudit {
  id: string
  runs: number
  successes: number
  resolution: Resolution
  /** median share of fail_to_pass cases passing in the runs that did not succeed */
  partial: number | null
  /** source files (no tests, no docs) the reference fix changes */
  fixFiles: string[]
  /** share of runs whose patch touches every fix file */
  located: number | null
  /** fix files no run ever touched */
  untouched: string[]
}

/** fewer runs than this say nothing about a task */
export const AUDIT_MIN_RUNS = 4

const NOT_SOURCE =
  /(^|\/)(tests?|__tests__|docs?|\.changeset)\/|\.(test|spec)(-d)?\.[a-z]+$|\.mdx?$/

/** Files of a fix an agent would have to change: no tests, docs or changesets. */
export const sourceFiles = (files: string[]) => files.filter((f) => !NOT_SOURCE.test(f))

const median = (xs: number[]) => {
  const s = [...xs].sort((x, y) => x - y)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? (s[m] ?? 0) : ((s[m - 1] ?? 0) + (s[m] ?? 0)) / 2
}

/** Evidence for curation, from runs already made: no agent, no LLM. */
export function auditTask(id: string, runs: AuditRun[], fixFiles: string[]): TaskAudit {
  const successes = runs.filter((r) => r.outcome === 'success').length
  const partial = runs
    .filter((r) => r.outcome !== 'success' && r.f2p && r.f2p.total > 0)
    .map((r) => 1 - (r.f2p?.failed ?? 0) / (r.f2p?.total ?? 1))
  const touched = new Set(runs.flatMap((r) => r.files))
  return {
    id,
    runs: runs.length,
    successes,
    resolution:
      runs.length < AUDIT_MIN_RUNS
        ? 'unknown'
        : successes === 0
          ? 'unsolved'
          : successes === runs.length
            ? 'saturated'
            : 'discriminating',
    partial: partial.length ? median(partial) : null,
    fixFiles,
    located:
      runs.length && fixFiles.length
        ? runs.filter((r) => fixFiles.every((f) => r.files.includes(f))).length / runs.length
        : null,
    untouched: fixFiles.filter((f) => !touched.has(f)),
  }
}

const LabelsSchema = z.object({
  /** task id → why the hidden tests cannot be satisfied from the issue text */
  underspecified: z.record(z.string(), z.string()).default({}),
})

export type Labels = z.infer<typeof LabelsSchema>

/** `datasets/<name>/labels.yaml`: hand-curated task labels; absent file = no labels. */
export async function loadLabels(datasetDir: string): Promise<Labels> {
  const raw = await readFile(join(datasetDir, 'labels.yaml'), 'utf8').catch(() => null)
  return LabelsSchema.parse(raw === null ? {} : (parse(raw) ?? {}))
}
