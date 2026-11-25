/**
 * A work item (shown as "task") outlives its agent runs. Runs never start on their own:
 * a human enqueues every run; a `/tiller …` comment on the task's PR counts
 * as the human doing so.
 */
export const WORK_STATES = [
  'IMPORTED', // created, not queued
  'QUEUED', // human asked for a run
  'PREFLIGHT', // read-only assessment before the first write run
  'RUNNING',
  'WAITING_FOR_HUMAN', // agent asked a question
  'REVIEW', // agent says done, nothing pushed (no forge, or verification failed): human reviews locally
  'PR_OPEN', // verified branch is on the PR; human reviews there
  'COMPLETED',
  'FAILED', // last run errored / timed out; human may retry
  'CANCELLED',
] as const
export type WorkState = (typeof WORK_STATES)[number]

/** States from which a human may (re)queue a run, optionally with a message. */
export const QUEUEABLE: readonly WorkState[] = [
  'IMPORTED',
  'WAITING_FOR_HUMAN',
  'REVIEW',
  'PR_OPEN',
  'FAILED',
]
export const CLOSABLE: readonly WorkState[] = [
  'IMPORTED',
  'QUEUED',
  'WAITING_FOR_HUMAN',
  'REVIEW',
  'PR_OPEN',
  'FAILED',
]

export interface WorkItem {
  id: string
  title: string
  body: string
  /** GitHub owner/name */
  repo: string
  /** datasets/<name>/profile.yaml = sandbox image + deps install */
  dataset: string
  /** configs/<name>.yaml = harness, model, skills, limits */
  config: string
  base_commit: string
  branch: string
  state: WorkState
  session_id: string | null
  source: string
  external_url: string | null
  created_at: string
  updated_at: string
}

export interface WorkRun {
  id: string
  item_id: string
  seq: number
  config_id: string
  session_id: string | null
  started_at: string
  finished_at: string | null
  duration_s: number | null
  cost_usd: number | null
  turns: number | null
  agent_exit: string | null
  signal: AgentSignal | null
  commit_sha: string | null
  diff_files: number | null
  diff_lines: number | null
}

export type Actor = 'human' | 'agent' | 'factory'
export type WorkEventKind =
  | 'created'
  | 'enqueued'
  | 'message' // human → agent (answer, review feedback)
  | 'run_started'
  | 'run_finished'
  | 'question' // agent → human
  | 'summary' // agent's done summary
  | 'preflight' // assessment before the first run: estimates, verdict, proposed split
  | 'verification' // factory's test verdict on the agent's commit
  | 'review' // second reader: what a read-only agent found in the verified change (advisory)
  | 'pr' // draft PR opened / branch pushed / PR merged or closed
  | 'state'

export interface WorkEvent {
  id: number
  item_id: string
  at: string
  actor: Actor
  kind: WorkEventKind
  text: string | null
  run_id: string | null
}

export type AgentSignal = 'done' | 'needs_human' | 'none'

const SIGNAL = /^\s*TILLER:\s*(DONE|NEEDS_HUMAN)\s*$/m

/** Agent ends its final message with `TILLER: DONE` or `TILLER: NEEDS_HUMAN` (prompts/factory). */
export function parseSignal(finalText: string | undefined): { signal: AgentSignal; text: string } {
  const text = finalText?.trim() ?? ''
  const all = [...text.matchAll(new RegExp(SIGNAL, 'gm'))]
  const last = all.at(-1)
  if (!last || last.index === undefined) return { signal: 'none', text }
  const message = (text.slice(0, last.index) + text.slice(last.index + last[0].length)).trim()
  return { signal: last[1] === 'DONE' ? 'done' : 'needs_human', text: message }
}
