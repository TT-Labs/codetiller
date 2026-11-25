import type { Preflight } from './items.js'
import type { WorkEvent, WorkItem, WorkRun } from './model.js'
import { verificationVerdict } from './verify.js'

/** Everything the factory recorded about one task. */
export interface TaskFacts {
  item: WorkItem
  runs: WorkRun[]
  /** model of the task's last run; undefined = it has not run */
  model?: string
  events: WorkEvent[]
  preflight?: Preflight
  /** what the second reader's readings of this task cost */
  reviewCost?: number
  pr?: { number: number; url: string }
}

/**
 * Counts over a set of tasks and the ratios the product is steered by: human
 * interventions per task, first-pass delivery, cost per delivered task. Ratios are null while
 * their denominator is zero.
 */
export interface GroupMetrics {
  tasks: number
  /** an agent ran at least once */
  ran: number
  /** verified work reached the human: a PR exists (only verified branches are pushed), or the last verification passed */
  delivered: number
  /** the human took it: PR merged or task accepted */
  accepted: number
  /** delivered by a single run without any intervention */
  firstPass: number
  /** human messages after work started: answers to questions and review feedback */
  interventions: number
  runs: number
  /** runs and preflights of every task in the group, wasted ones included */
  cost_usd: number
  agent_s: number
  interventionsPerTask: number | null
  firstPassRate: number | null
  costPerDelivered: number | null
  costPerAccepted: number | null
}

/**
 * Does verification predict acceptance: what the human decided about work that reached them
 * verified on a pull request. Only decided PRs say anything; open ones are pending.
 */
export interface ReviewOutcomes {
  /** PRs the factory opened (every one passed verification first) */
  prs: number
  /** merged without the human asking for anything after the PR opened */
  acceptedAsIs: number
  /** merged after at least one message from the human */
  acceptedAfterChanges: number
  /** closed without merge */
  rejected: number
  pending: number
  /** accepted as is / decided; null until a PR has been decided */
  asIsRate: number | null
}

export interface FactoryMetrics {
  total: GroupMetrics
  review: ReviewOutcomes
  /** how far tasks got; each stage counts the tasks that reached it */
  funnel: { stage: string; tasks: number }[]
  preflight: Record<string, number>
  /** verdicts of every verification the factory ran */
  verification: { pass: number; fail: number; error: number }
  byRepo: ({ key: string } & GroupMetrics)[]
  byConfig: ({ key: string } & GroupMetrics)[]
  /** tasks that ran, under the model of their last run */
  byModel: ({ key: string } & GroupMetrics)[]
  /** tasks marked as experiments: in none of the figures above */
  experiments: number
}

const ratio = (n: number, d: number) => (d ? n / d : null)

const lastVerdict = (t: TaskFacts) =>
  verificationVerdict(
    t.events.findLast((e) => e.kind === 'verification' && e.actor === 'factory')?.text ?? null,
  )

const delivered = (t: TaskFacts) => Boolean(t.pr) || lastVerdict(t) === 'pass'

/** messages after the first assessment or run started; earlier ones are the task's instructions */
function interventions(t: TaskFacts): number {
  const start = t.events.find((e) => e.kind === 'run_started' || e.kind === 'preflight')
  if (!start) return 0
  // the factory's own messages to the agent (a conflict to resolve) are not a human stepping in
  return t.events.filter((e) => e.kind === 'message' && e.actor === 'human' && e.id > start.id)
    .length
}

function group(tasks: TaskFacts[]): GroupMetrics {
  const ran = tasks.filter((t) => t.runs.length > 0)
  const done = tasks.filter(delivered)
  const accepted = tasks.filter((t) => t.item.state === 'COMPLETED').length
  const sum = (f: (t: TaskFacts) => number) => tasks.reduce((s, t) => s + f(t), 0)
  const cost = sum(
    (t) =>
      t.runs.reduce((s, r) => s + (r.cost_usd ?? 0), 0) +
      (t.preflight?.cost_usd ?? 0) +
      (t.reviewCost ?? 0),
  )
  const asked = sum(interventions)
  const firstPass = done.filter((t) => t.runs.length === 1 && interventions(t) === 0).length
  return {
    tasks: tasks.length,
    ran: ran.length,
    delivered: done.length,
    accepted,
    firstPass,
    interventions: asked,
    runs: sum((t) => t.runs.length),
    cost_usd: cost,
    agent_s: sum((t) => t.runs.reduce((s, r) => s + (r.duration_s ?? 0), 0)),
    interventionsPerTask: ratio(asked, ran.length),
    firstPassRate: ratio(firstPass, done.length),
    costPerDelivered: ratio(cost, done.length),
    costPerAccepted: ratio(cost, accepted),
  }
}

function reviewOutcomes(tasks: TaskFacts[]): ReviewOutcomes {
  const out = { prs: 0, acceptedAsIs: 0, acceptedAfterChanges: 0, rejected: 0, pending: 0 }
  for (const t of tasks) {
    if (!t.pr) continue
    out.prs++
    const opened = t.events.find((e) => e.kind === 'pr')
    const asked = t.events.some(
      (e) => e.kind === 'message' && e.actor === 'human' && opened && e.id > opened.id,
    )
    if (t.item.state === 'COMPLETED') asked ? out.acceptedAfterChanges++ : out.acceptedAsIs++
    else if (t.item.state === 'CANCELLED') out.rejected++
    else out.pending++
  }
  const decided = out.acceptedAsIs + out.acceptedAfterChanges + out.rejected
  return { ...out, asIsRate: ratio(out.acceptedAsIs, decided) }
}

const by = (tasks: TaskFacts[], key: (t: TaskFacts) => string) =>
  [...new Set(tasks.map(key))]
    .sort()
    .map((k) => ({ key: k, ...group(tasks.filter((t) => key(t) === k)) }))

export function factoryMetrics(tasks: TaskFacts[], experiments = 0): FactoryMetrics {
  const count = (f: (t: TaskFacts) => boolean) => tasks.filter(f).length
  const preflight: Record<string, number> = {}
  for (const t of tasks)
    if (t.preflight) preflight[t.preflight.verdict] = (preflight[t.preflight.verdict] ?? 0) + 1
  const verification = { pass: 0, fail: 0, error: 0 }
  for (const e of tasks.flatMap((t) => t.events)) {
    if (e.kind !== 'verification') continue
    const v = verificationVerdict(e.text)
    if (v !== 'none') verification[v]++
  }
  const stopped = (t: TaskFacts) =>
    t.runs.length === 0 && ['too_large', 'unclear', 'error'].includes(t.preflight?.verdict ?? '')
  return {
    total: group(tasks),
    review: reviewOutcomes(tasks),
    funnel: [
      { stage: 'Created', tasks: tasks.length },
      {
        stage: 'Started (assessed or run)',
        tasks: count((t) => Boolean(t.preflight) || t.runs.length > 0),
      },
      { stage: 'Stopped by preflight', tasks: count(stopped) },
      { stage: 'Agent ran', tasks: count((t) => t.runs.length > 0) },
      { stage: 'Delivered (verified)', tasks: count(delivered) },
      { stage: 'Pull request opened', tasks: count((t) => Boolean(t.pr)) },
      { stage: 'Accepted', tasks: count((t) => t.item.state === 'COMPLETED') },
    ],
    preflight,
    verification,
    byRepo: by(tasks, (t) => t.item.repo),
    byConfig: by(tasks, (t) => t.item.config),
    byModel: by(
      tasks.filter((t) => t.runs.length > 0),
      (t) => t.model ?? 'unknown',
    ),
    experiments,
  }
}
