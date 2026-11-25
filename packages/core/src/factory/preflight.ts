import { parse } from 'yaml'
import { z } from 'zod'

/** tiller.yaml `factory.preflight`: the gate is these numbers, not the agent's opinion. */
export const PreflightLimitsSchema = z.object({
  enabled: z.boolean().default(true),
  /** more files than this to create or change = too large */
  max_files: z.number().int().positive().default(10),
  /** more domain concepts than this = too large */
  max_concepts: z.number().int().positive().default(3),
  /**
   * How far an estimate may exceed a limit and still pass, as a share of the limit (0.2 = a limit
   * of 10 files tolerates 12). An estimate is not exact, and a task two files over is not worth
   * splitting: the split costs more than the overrun.
   */
  tolerance: z.number().min(0).max(1).default(0.2),
})

export type PreflightLimits = z.infer<typeof PreflightLimitsSchema>

/** Limits a narrower level sets for itself; what it leaves out comes from the level above. */
export const PreflightOverrideSchema = z
  .object({
    enabled: z.boolean().optional(),
    max_files: z.number().int().positive().optional(),
    max_concepts: z.number().int().positive().optional(),
    tolerance: z.number().min(0).max(1).optional(),
  })
  .strict()

export type PreflightOverride = z.infer<typeof PreflightOverrideSchema>

/** `.factory/factory.yaml` in a repository: what its maintainers set for the factory. */
export const REPO_FACTORY_FILE = '.factory/factory.yaml'
const RepoFactorySchema = z.object({ preflight: PreflightOverrideSchema.optional() })

/** where the limits a task was gated with came from: the most specific level that set any */
export type LimitsSource = 'repository' | 'project' | 'default'

export interface ResolvedLimits extends PreflightLimits {
  source: LimitsSource
}

/**
 * How big a task may be differs per repository: a limit that fits a small service stops routine
 * work in a monorepo. Most specific wins, field by field: the repository's own
 * `.factory/factory.yaml` (read from git at the task's base commit), then the project entry in
 * tiller.yaml, then the factory default.
 */
export function resolveLimits(
  base: PreflightLimits,
  project?: PreflightOverride,
  repoFile?: string,
): ResolvedLimits {
  let repo: PreflightOverride | undefined
  if (repoFile !== undefined) {
    try {
      repo = RepoFactorySchema.parse(parse(repoFile) ?? {}).preflight
    } catch (e) {
      throw new Error(
        `${REPO_FACTORY_FILE}: ${(e as Error).message.replace(/\s+/g, ' ').slice(0, 300)}`,
      )
    }
  }
  const set = (o?: PreflightOverride) =>
    o !== undefined && Object.values(o).some((v) => v !== undefined)
  return {
    enabled: repo?.enabled ?? project?.enabled ?? base.enabled,
    max_files: repo?.max_files ?? project?.max_files ?? base.max_files,
    max_concepts: repo?.max_concepts ?? project?.max_concepts ?? base.max_concepts,
    tolerance: repo?.tolerance ?? project?.tolerance ?? base.tolerance,
    source: set(repo) ? 'repository' : set(project) ? 'project' : 'default',
  }
}

/** flatten whatever shape the agent gave one list entry into its text */
const text = (v: unknown): string =>
  typeof v === 'string'
    ? v
    : Array.isArray(v)
      ? v.map(text).filter(Boolean).join('; ')
      : v && typeof v === 'object'
        ? Object.values(v).map(text).filter(Boolean).join(' — ')
        : v == null
          ? ''
          : String(v)

// agents structure list entries on their own (`{question, options}`, `{path, reason}`): a shape
// slip in one entry must not cost the whole assessment
const texts = z
  .array(z.unknown())
  .default([])
  .transform((xs) => xs.map(text).filter(Boolean))

/** What the read-only agent reports (prompts/factory/preflight.md); estimates, never a verdict. */
export const PreflightReportSchema = z.object({
  summary: z.string().default(''),
  files: texts,
  concepts: texts,
  dependencies: texts,
  risks: texts,
  questions: texts,
  subtasks: z.array(z.object({ title: z.string().min(1), body: z.string() })).default([]),
})

export type PreflightReport = z.infer<typeof PreflightReportSchema>

/**
 * `pass` lets the write run start. `too_large`, `unclear` and `error` (the assessment itself
 * failed: a gate that cannot answer stays closed) stop at the human gate; enqueueing again runs
 * the task anyway. `skipped` = the human queued it without the assessment.
 */
export type PreflightVerdict = 'pass' | 'too_large' | 'unclear' | 'error' | 'skipped'

const FENCE = /```json\s*\n([\s\S]*?)```/g

/** The report is the last fenced JSON block of the agent's final message. */
export function parsePreflight(finalText: string | undefined): PreflightReport {
  const blocks = [...(finalText ?? '').matchAll(FENCE)]
  const raw = blocks.at(-1)?.[1]
  if (!raw) throw new Error('no JSON block in the preflight answer')
  return PreflightReportSchema.parse(JSON.parse(raw))
}

/**
 * The factory decides from the estimates, so the threshold can later be calibrated
 * against real outcomes. Size wins over questions: a decomposition changes what there is to ask.
 */
export function gate(r: PreflightReport, l: PreflightLimits): 'pass' | 'too_large' | 'unclear' {
  const most = tolerated(l)
  if (r.files.length > most.files || r.concepts.length > most.concepts) return 'too_large'
  return r.questions.length > 0 ? 'unclear' : 'pass'
}

/** The largest estimates that still pass: each limit plus its tolerance, rounded down. */
export function tolerated(l: Pick<PreflightLimits, 'max_files' | 'max_concepts' | 'tolerance'>) {
  const up = (limit: number) => Math.floor(limit * (1 + l.tolerance) + 1e-9)
  return { files: up(l.max_files), concepts: up(l.max_concepts) }
}

const HEAD: Record<'pass' | 'too_large' | 'unclear', string> = {
  pass: 'Preflight passed',
  too_large: 'Preflight: too large for one run',
  unclear: 'Preflight: needs answers first',
}

const numbered = (xs: string[]) => xs.map((x, i) => `${i + 1}. ${x}`).join('\n')

// the count is in the headline; a 45-line list would bury the proposed split below it
const MAX_LISTED = 12
const listed = (files: string[]) =>
  [
    ...files.slice(0, MAX_LISTED).map((f) => `- ${f}`),
    ...(files.length > MAX_LISTED ? [`- … and ${files.length - MAX_LISTED} more`] : []),
  ].join('\n')

/** Timeline text: the verdict with its numbers, then what the human needs to decide. */
export function renderPreflight(
  r: PreflightReport,
  verdict: 'pass' | 'too_large' | 'unclear',
  l: PreflightLimits & { source?: LimitsSource },
): string {
  const from =
    l.source === 'repository'
      ? ` · limits set by the repository (${REPO_FACTORY_FILE})`
      : l.source === 'project'
        ? ' · limits set for this project (tiller.yaml)'
        : ''
  const most = tolerated(l)
  // say it when a limit was exceeded and let through, so the pass is not mistaken for "under the limit"
  const limit = (n: number, max: number, top: number) =>
    n > max && n <= top ? `limit ${max}, within tolerance up to ${top}` : `limit ${max}`
  const parts = [
    `${HEAD[verdict]} · ${r.files.length} files (${limit(r.files.length, l.max_files, most.files)}) · ${r.concepts.length} concepts (${limit(r.concepts.length, l.max_concepts, most.concepts)})${from}`,
    r.summary,
  ]
  if (r.concepts.length) parts.push(`Concepts: ${r.concepts.join(', ')}`)
  if (r.files.length) parts.push(`Files:\n${listed(r.files)}`)
  if (r.dependencies.length) parts.push(`New dependencies: ${r.dependencies.join(', ')}`)
  if (r.risks.length) parts.push(`Risks:\n${r.risks.map((x) => `- ${x}`).join('\n')}`)
  if (r.questions.length) parts.push(`Questions:\n${numbered(r.questions)}`)
  if (verdict === 'too_large' && r.subtasks.length)
    parts.push(`Proposed split:\n${numbered(r.subtasks.map((s) => s.title))}`)
  if (verdict === 'too_large')
    parts.push(
      r.subtasks.length
        ? 'Next: split into these tasks, enqueue again to run it as one anyway, or cancel.'
        : 'Next: enqueue again to run it as one anyway, or cancel.',
    )
  if (verdict === 'unclear') parts.push('Next: enqueue with your answers, or cancel.')
  return parts.filter(Boolean).join('\n\n')
}
