import { clsx } from 'clsx'
import type { ReactNode } from 'react'
import {
  type TaskDetail,
  useFixCi,
  useSetExperiment,
  useUpdateTask,
  useVerifyAgain,
} from '../../api'
import { Markdown } from '../../components/Markdown'
import { Badge, type Tone } from '../../components/ui/Badge'
import { Button } from '../../components/ui/Button'
import { Card, ExternalA } from '../../components/ui/layout'
import { ErrorBox } from '../../components/ui/states'
import { duration, usd, when } from '../../format'
import { verdictOf } from './Preflight'

// keyed by string: a state added on the server renders as plain text
const CI: Record<string, { label: string; tone: Tone }> = {
  passed: { label: 'passed', tone: 'success' },
  failed: { label: 'failed', tone: 'danger' },
  pending: { label: 'running', tone: 'neutral' },
  none: { label: 'no checks', tone: 'neutral' },
}

// keyed by string: a verdict added on the server renders as plain text
const READER: Record<string, { label: string; tone: Tone }> = {
  ok: { label: 'no concerns', tone: 'success' },
  notes: { label: 'notes', tone: 'neutral' },
  concerns: { label: 'concerns', tone: 'warning' },
  error: { label: 'failed', tone: 'neutral' },
}

const VERIFICATION: Record<string, { label: string; tone: Tone }> = {
  pass: { label: 'passed', tone: 'success' },
  fail: { label: 'failed', tone: 'danger' },
  error: { label: 'no report', tone: 'danger' },
  none: { label: 'not run', tone: 'neutral' },
}

/** What the task is waiting for, in one sentence: the question every visit starts with. */
function waitingFor(data: TaskDetail): string {
  const { item, pr, preflight, verification, runs } = data
  switch (item.state) {
    case 'IMPORTED':
      if (data.order?.waitsFor)
        return `Not started. It builds on ${data.order.waitsFor.id}, the part before it: enqueue it now and it starts when that one is merged.`
      return 'Not started. Enqueue a run to start the agent.'
    case 'QUEUED':
      if (data.order?.waitsFor)
        return `Queued. Starts when ${data.order.waitsFor.id}, the part before it, is merged.`
      return data.canRun
        ? 'Queued: waiting for the worker to pick it up.'
        : 'Queued, but no worker can run it: the model key is missing.'
    case 'PREFLIGHT':
      return 'A read-only agent is assessing the task before the first run.'
    case 'RUNNING':
      return `The agent is working (run ${runs.length}).`
    case 'WAITING_FOR_HUMAN':
      if (runs.length === 0 && preflight)
        return preflight.verdict === 'too_large'
          ? 'Stopped before the first run: the preflight estimates it is too large for one run. Split it, run it anyway, or cancel.'
          : preflight.verdict === 'unclear'
            ? 'Stopped before the first run: the preflight has questions. Answer them to start.'
            : 'Stopped before the first run: the preflight failed. Run without it, or cancel.'
      return 'The agent asked a question and waits for your answer.'
    case 'PR_OPEN':
      if (data.prState?.sync === 'conflict')
        return 'The pull request conflicts with the default branch. Update the task: the agent resolves the conflicts and the result is verified again.'
      return 'Verified changes are on the pull request. Review it there; merging completes the task.'
    case 'REVIEW':
      return pr
        ? 'The agent is done, but its last changes were not pushed to the pull request: verification did not pass.'
        : verification?.status === 'pass'
          ? 'The agent is done and verification passed. Review the changes, then accept or request changes.'
          : 'The agent is done. Review the changes, then accept or request changes.'
    case 'FAILED':
      return 'The last run failed. Retry, or cancel.'
    case 'COMPLETED':
      return pr ? 'Completed: the pull request was merged or the task was accepted.' : 'Completed.'
    case 'CANCELLED':
      return 'Cancelled.'
    default:
      return `State: ${String(item.state).toLowerCase().replaceAll('_', ' ')}.`
  }
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="font-medium text-fg-subtle text-xs">{label}</dt>
      <dd className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-13 text-fg">
        {children}
      </dd>
    </div>
  )
}

/**
 * The review surface: what the task waits for, the evidence (verification, PR, preflight) and the
 * agent's latest word, before any scrolling. The timeline below is the record, not the answer.
 */
// keyed by string: a state added on the server renders as plain text
const PR_SYNC: Record<string, { label: string; tone: Tone }> = {
  behind: { label: 'behind the default branch', tone: 'warning' },
  conflict: { label: 'conflicts with the default branch', tone: 'danger' },
}
const MODEL_SOURCE: Record<string, string> = {
  task: 'chosen for this task',
  default: 'factory default',
  config: 'from the agent config',
}
// states in which the branch can be verified again without an agent run
const VERIFIABLE = ['REVIEW', 'PR_OPEN', 'FAILED']

/** tests or files named by the verification, under what they mean */
function Named({
  title,
  tone,
  items,
  children,
}: {
  title: string
  tone: 'danger' | 'warning'
  items: string[]
  children?: ReactNode
}) {
  if (!items.length) return null
  return (
    <div className="border-line border-t px-4 py-3">
      <div className="mb-1 flex flex-wrap items-center gap-x-3 gap-y-1">
        <span
          className={clsx(
            'font-medium text-xs',
            tone === 'danger' ? 'text-danger' : 'text-warning',
          )}
        >
          {title}
        </span>
        {children}
      </div>
      <ul className="space-y-0.5 font-mono text-fg-muted text-xs">
        {items.map((f) => (
          <li key={f} className="break-all">
            {f}
          </li>
        ))}
      </ul>
    </div>
  )
}

// a branch exists and no run is in flight
const UPDATABLE = ['WAITING_FOR_HUMAN', 'REVIEW', 'PR_OPEN', 'FAILED']

export function StatusBlock({ data }: { data: TaskDetail }) {
  const { runs, pr, verification, preflight } = data
  const update = useUpdateTask(data.item.id)
  const stale = pr && data.prState ? PR_SYNC[data.prState.sync] : undefined
  const cost =
    runs.reduce((s, r) => s + (r.cost_usd ?? 0), 0) +
    (preflight?.cost_usd ?? 0) +
    (data.reviewCost ?? 0)
  const reading = data.review
  const findings = reading?.report?.findings ?? []
  // a finding about the checks is never a mere note, whatever the reader called it
  const blocks = (f: (typeof findings)[number]) =>
    f.weight === 'change' || f.kind === 'verification'
  const time = runs.reduce((s, r) => s + (r.duration_s ?? 0), 0)
  const messages = data.events.filter((e) => e.kind === 'message').length
  const last = runs.at(-1)
  // the agent's latest word: a summary when it finished, its question when it waits
  const latest = data.events.findLast((e) => e.kind === 'summary' || e.kind === 'question')
  const v = VERIFICATION[verification?.status ?? 'none'] ?? VERIFICATION.none
  const verify = useVerifyAgain(data.item.id)
  const experiment = useSetExperiment(data.item.id)
  const fixCi = useFixCi(data.item.id)
  const ci = pr ? data.ci : null
  // first line is the verdict; the lists under it arrive parsed
  const verdictLine = (verification?.text ?? '').split('\n')[0]
  const canVerify = VERIFIABLE.includes(data.item.state)
  return (
    <Card>
      <div className="px-4 pt-4 pb-3">
        <p className="max-w-prose font-medium text-fg leading-relaxed">{waitingFor(data)}</p>
      </div>
      <dl className="grid grid-cols-[repeat(auto-fit,minmax(11rem,1fr))] gap-x-6 gap-y-3 border-line border-t px-4 py-3">
        <Fact label="Verification">
          {v ? <Badge tone={v.tone}>{v.label}</Badge> : null}
          {verification?.sensitive.length ? <Badge tone="warning">checks changed</Badge> : null}
          {verification ? (
            <span className="text-fg-muted">
              {verdictLine?.replace(/^verification (passed|failed|error): /, '')}
            </span>
          ) : null}
          {verification && canVerify ? (
            <Button
              className="h-7 px-2"
              disabled={verify.isPending}
              title="Run the suite on the branch again, without an agent run; a branch that passes is pushed."
              onClick={() => verify.mutate({})}
            >
              {verify.isPending ? 'Verifying…' : 'Verify again'}
            </Button>
          ) : null}
        </Fact>
        <Fact label="Pull request">
          {pr ? (
            <ExternalA href={pr.url}>#{pr.number}</ExternalA>
          ) : (
            <span className="text-fg-subtle">none</span>
          )}
          {stale ? <Badge tone={stale.tone}>{stale.label}</Badge> : null}
          {stale && UPDATABLE.includes(data.item.state) ? (
            <Button
              className="h-7 px-2"
              disabled={update.isPending}
              title="Merge the default branch into the task. No conflicts: verified and pushed without an agent run. Conflicts: the agent resolves them in its next run."
              onClick={() => update.mutate()}
            >
              {update.isPending ? 'Updating…' : 'Update'}
            </Button>
          ) : null}
        </Fact>
        {ci ? (
          <Fact label="CI of the repository">
            <Badge tone={CI[ci.state]?.tone ?? 'neutral'}>{CI[ci.state]?.label ?? ci.state}</Badge>
            {ci.failing.length ? (
              <span className="text-fg-muted">{ci.failing.map((c) => c.name).join(', ')}</span>
            ) : null}
            {ci.state === 'failed' && ['PR_OPEN', 'REVIEW'].includes(data.item.state) ? (
              <Button
                className="h-7 px-2"
                disabled={fixCi.isPending || ci.sent_head === ci.head}
                title="The failing checks and the end of their logs become the agent's next message. Verification passed on this commit: CI checks something it does not."
                onClick={() => fixCi.mutate()}
              >
                {ci.sent_head === ci.head ? 'Sent to the agent' : 'Send to the agent'}
              </Button>
            ) : null}
          </Fact>
        ) : null}
        {reading ? (
          <Fact label="Second reader">
            <Badge tone={READER[reading.verdict]?.tone ?? 'neutral'}>
              {READER[reading.verdict]?.label ?? reading.verdict}
            </Badge>
            {findings.length ? (
              <span className="text-fg-muted tabular-nums">
                {findings.filter(blocks).length} to change ·{' '}
                {findings.filter((f) => !blocks(f)).length === 1
                  ? '1 note'
                  : `${findings.filter((f) => !blocks(f)).length} notes`}
              </span>
            ) : null}
          </Fact>
        ) : null}
        {preflight ? (
          <Fact label="Preflight">
            <Badge tone={verdictOf(preflight.verdict).tone}>
              {verdictOf(preflight.verdict).label}
            </Badge>
            {preflight.report ? (
              <span className="text-fg-muted tabular-nums">
                {preflight.report.files.length} files · {preflight.report.concepts.length} concepts
              </span>
            ) : null}
          </Fact>
        ) : null}
        <Fact label="Last run changed">
          {last ? (
            <span className="tabular-nums">
              {last.diff_files ?? 0} files · {last.diff_lines ?? 0} lines
            </span>
          ) : (
            <span className="text-fg-subtle">no run yet</span>
          )}
        </Fact>
        {data.model ? (
          <Fact label="Model of the next run">
            <span className="break-all">{data.model.model}</span>
            <span className="text-fg-muted">
              {MODEL_SOURCE[data.model.source] ?? data.model.source}
            </span>
          </Fact>
        ) : null}
        <Fact label="Metrics">
          <span className={data.experiment ? 'text-warning' : undefined}>
            {data.experiment ? 'experiment: left out' : 'counted'}
          </span>
          <Button
            className="h-7 px-2"
            disabled={experiment.isPending}
            title="An experiment is a task run to try the factory itself. It is left out of the Metrics page."
            onClick={() => experiment.mutate(!data.experiment)}
          >
            {data.experiment ? 'Count it' : 'Mark as experiment'}
          </Button>
        </Fact>
        <Fact label="Effort">
          <span className="tabular-nums">
            {runs.length} {runs.length === 1 ? 'run' : 'runs'} · {usd(cost)} · {duration(time)}
          </span>
          <span className="text-fg-muted tabular-nums">
            · {messages} human {messages === 1 ? 'message' : 'messages'}
          </span>
        </Fact>
      </dl>
      {update.error ? (
        <div className="border-line border-t px-4 py-3">
          <ErrorBox error={update.error} />
        </div>
      ) : null}
      {fixCi.error ? (
        <div className="border-line border-t px-4 py-3">
          <ErrorBox error={fixCi.error} />
        </div>
      ) : null}
      {verify.error ? (
        <div className="border-line border-t px-4 py-3">
          <ErrorBox error={verify.error} />
        </div>
      ) : null}
      <Named title="Newly failing tests" tone="danger" items={verification?.failing ?? []} />
      <Named
        title="Tests that no longer run (they passed before this change)"
        tone="danger"
        items={verification?.removed ?? []}
      >
        {canVerify ? (
          <Button
            className="h-7 px-2"
            disabled={verify.isPending}
            title="Your call, not the agent's: these tests may go. The branch is verified again and pushed when it passes."
            onClick={() => {
              if (confirm('Accept that these tests no longer run and verify the branch again?'))
                verify.mutate({ acceptRemoved: true })
            }}
          >
            Accept removed tests
          </Button>
        ) : null}
      </Named>
      <Named
        title="No longer run, not counted as a failure (replaced in the same file, or accepted)"
        tone="warning"
        items={verification?.gone ?? []}
      />
      <Named
        title="Failed checks (type check, lint, build: they passed before this change)"
        tone="danger"
        items={verification?.checks ?? []}
      />
      <Named
        title="Fails with the checks as they were before this change"
        tone="danger"
        items={verification?.baseChecks ?? []}
      />
      <Named
        title="This change modifies how it is checked"
        tone="warning"
        items={verification?.sensitive ?? []}
      >
        {canVerify &&
        verification?.status === 'fail' &&
        /with the checks as they were/.test(verdictLine ?? '') ? (
          <Button
            className="h-7 px-2"
            disabled={verify.isPending}
            title="Your call, not the agent's: the changed test configuration is right. The branch is verified again with it alone and pushed when it passes."
            onClick={() => {
              if (confirm('Accept these changed check files and verify the branch again?'))
                verify.mutate({ acceptChecks: true })
            }}
          >
            Accept changed checks
          </Button>
        ) : null}
      </Named>
      {findings.length ? (
        <div className="border-line border-t px-4 py-3">
          <div className="mb-1.5 flex flex-wrap items-baseline gap-x-2">
            <span className="font-medium text-fg text-xs">Second reader</span>
            <span className="text-fg-subtle text-xs">
              a read-only agent read the verified change; its word is advice, not a check
            </span>
          </div>
          <ul className="space-y-1.5">
            {[...findings.filter(blocks), ...findings.filter((f) => !blocks(f))].map((f) => (
              <li key={`${f.file}:${f.line ?? ''}:${f.title}`} className="text-13 leading-relaxed">
                <Badge tone={blocks(f) ? 'warning' : 'neutral'}>
                  {blocks(f) ? f.kind : 'note'}
                </Badge>{' '}
                <span className="font-medium text-fg">{f.title}</span>
                {f.file ? (
                  <span className="ml-1.5 break-all font-mono text-fg-subtle text-xs">
                    {f.file}
                    {f.line ? `:${f.line}` : ''}
                  </span>
                ) : null}
                {f.detail ? <p className="text-fg-muted">{f.detail}</p> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {latest?.text ? (
        <div className="border-line border-t px-4 py-3">
          <div className="mb-1.5 flex items-baseline gap-2">
            <span className="font-semibold text-11 text-fg-muted uppercase tracking-wider">
              {latest.kind === 'question' ? 'The agent asks' : 'Latest from the agent'}
            </span>
            <span className="text-fg-subtle text-xs tabular-nums">{when(latest.at)}</span>
          </div>
          <Markdown>{latest.text}</Markdown>
        </div>
      ) : null}
    </Card>
  )
}
