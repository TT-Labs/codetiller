import { z } from 'zod'

/**
 * The second reader. After a change passed verification, a read-only agent reads it
 * against the task and reports what tests cannot say: code that works on the checks instead of
 * the behaviour, and what a maintainer would not merge although the tests pass. Its findings are
 * shown to the human, never acted on: it is an agent reading agent-written text.
 */
const FindingSchema = z.object({
  /** `verification` = works on the outcome of the checks; `quality` = a maintainer would ask for a change */
  kind: z.enum(['verification', 'quality']).catch('quality'),
  /** `change` = the reader would not approve without it; `note` = worth a look, not a blocker */
  weight: z.enum(['change', 'note']).catch('change'),
  file: z.string().default(''),
  line: z.number().int().nonnegative().optional().catch(undefined),
  title: z.string().min(1),
  detail: z.string().default(''),
})

export const ReviewReportSchema = z.object({
  summary: z.string().default(''),
  findings: z.array(FindingSchema).default([]),
})

export type ReviewFinding = z.infer<typeof FindingSchema>
export type ReviewReport = z.infer<typeof ReviewReportSchema>
/**
 * `concerns` = at least one finding the reader would not approve with; `notes` = only remarks;
 * `error` = the reader itself failed: nothing is known, and nothing is held back because of it.
 */
export type ReviewVerdict = 'ok' | 'notes' | 'concerns' | 'error'

const FENCE = /```json\s*\n([\s\S]*?)```/g

/** The report is the last fenced JSON block of the reader's final message. */
export function parseReview(finalText: string | undefined): ReviewReport {
  const blocks = [...(finalText ?? '').matchAll(FENCE)]
  const raw = blocks.at(-1)?.[1]
  if (!raw) throw new Error("no JSON block in the second reader's answer")
  return ReviewReportSchema.parse(JSON.parse(raw))
}

// a finding about the checks themselves is never a mere remark, whatever the reader called it
const blocking = (f: ReviewFinding) => f.weight === 'change' || f.kind === 'verification'

export const reviewVerdict = (r: ReviewReport): ReviewVerdict =>
  r.findings.some(blocking) ? 'concerns' : r.findings.length ? 'notes' : 'ok'

const where = (f: ReviewFinding) => (f.file ? `${f.file}${f.line ? `:${f.line}` : ''}` : '')
const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** For the timeline and the PR: the verdict line, then one entry per finding, concerns first. */
export function renderReview(r: ReviewReport): string {
  if (!r.findings.length) return `second reader: no concerns${r.summary ? `\n\n${r.summary}` : ''}`
  const concerns = r.findings.filter(blocking)
  const notes = r.findings.filter((f) => !blocking(f))
  const head = [
    ...(concerns.length ? [count(concerns.length, 'concern', 'concerns')] : ['no concerns']),
    ...(notes.length ? [count(notes.length, 'note', 'notes')] : []),
  ].join(', ')
  const line = (f: ReviewFinding) => {
    const at = where(f)
    const tag = blocking(f) ? f.kind : 'note'
    return `- [${tag}] ${at ? `\`${at}\` ` : ''}${f.title}${f.detail ? `: ${f.detail}` : ''}`
  }
  return [
    `second reader: ${head}`,
    ...(r.summary ? ['', r.summary] : []),
    '',
    ...concerns.map(line),
    ...notes.map(line),
  ].join('\n')
}

/** the diff goes into the prompt; past this size the reader is told to read the files instead */
export const MAX_DIFF_CHARS = 80_000

export function diffForPrompt(diff: string): string {
  if (diff.length <= MAX_DIFF_CHARS) return diff
  return `${diff.slice(0, MAX_DIFF_CHARS)}\n… (diff cut here: ${diff.length - MAX_DIFF_CHARS} more characters; read the files in /workspace for the rest)`
}
