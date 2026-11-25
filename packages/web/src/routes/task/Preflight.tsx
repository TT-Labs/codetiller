import { clsx } from 'clsx'
import { type ReactNode, useState } from 'react'
import { type TaskDetail, useTaskRunTranscript } from '../../api'
import { Markdown } from '../../components/Markdown'
import { Transcript } from '../../components/Transcript'
import { Badge, type Tone } from '../../components/ui/Badge'
import { ChevronRight } from '../../components/ui/icons'
import { ErrorBox, Loading } from '../../components/ui/states'
import { duration, usd } from '../../format'

type Preflight = NonNullable<TaskDetail['preflight']>

// keyed by string: a verdict added on the server renders as a neutral badge
const VERDICT: Record<string, { label: string; tone: Tone }> = {
  pass: { label: 'passed', tone: 'success' },
  too_large: { label: 'too large', tone: 'warning' },
  unclear: { label: 'needs answers', tone: 'warning' },
  error: { label: 'failed', tone: 'danger' },
  skipped: { label: 'skipped', tone: 'neutral' },
}

export const verdictOf = (verdict: string) =>
  VERDICT[verdict] ?? { label: verdict.replaceAll('_', ' '), tone: 'neutral' as Tone }

/**
 * An estimate against its limit. A limit tolerates a small overrun (a share of itself): only an
 * estimate beyond that stopped the task.
 */
function Estimate({
  n,
  unit,
  limit,
  tolerance = 0,
}: {
  n: number
  unit: string
  limit?: number
  tolerance?: number
}) {
  const most = limit === undefined ? undefined : Math.floor(limit * (1 + tolerance) + 1e-9)
  const over = most !== undefined && n > most
  const tolerated = limit !== undefined && n > limit && !over
  return (
    <div
      className={clsx(
        'rounded-md border px-3 py-2',
        over ? 'border-warning-line bg-warning-soft' : 'border-line bg-subtle',
      )}
    >
      <div className="font-semibold text-fg text-lg tabular-nums leading-tight">
        {n} <span className="font-medium text-fg-muted text-13">{unit}</span>
      </div>
      {limit !== undefined ? (
        <div className={clsx('text-xs', over ? 'text-warning' : 'text-fg-subtle')}>
          limit {limit}
          {over ? ' · over' : tolerated ? ` · within tolerance (${most})` : ''}
        </div>
      ) : null}
    </div>
  )
}

function Part({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-x-4 gap-y-1 sm:grid-cols-[7.5rem_minmax(0,1fr)]">
      <div className="pt-0.5 font-semibold text-11 text-fg-subtle uppercase tracking-wider">
        {label}
      </div>
      <div className="min-w-0 text-fg leading-relaxed">{children}</div>
    </div>
  )
}

const Bullets = ({ items }: { items: string[] }) => (
  <ul className="list-disc space-y-1 pl-4 marker:text-fg-subtle">
    {items.map((x) => (
      <li key={x} className="break-words">
        {x}
      </li>
    ))}
  </ul>
)

/** closed by default: the headline carries the count, the list is for checking it */
function Disclosure({ summary, children }: { summary: ReactNode; children: ReactNode }) {
  return (
    <details className="group">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded text-fg hover:text-accent-text [&::-webkit-details-marker]:hidden">
        <ChevronRight className="size-3.5 shrink-0 text-fg-subtle transition-transform group-open:rotate-90" />
        {summary}
      </summary>
      <div className="mt-1.5 pl-5">{children}</div>
    </details>
  )
}

/**
 * The assessment before the first run: the factory's verdict, the agent's estimates against the
 * limits, and what the human needs to decide at the gate (questions, proposed split).
 */
export function PreflightCard({
  preflight,
  limits,
  taskId,
  time,
}: {
  preflight: Preflight
  limits: TaskDetail['preflightLimits']
  taskId: string
  time?: string
}) {
  const [showRun, setShowRun] = useState(false)
  const r = preflight.report
  const v = verdictOf(preflight.verdict)
  return (
    <div className="overflow-hidden rounded-lg border border-line bg-surface shadow-xs">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-line border-b px-4 py-2.5">
        <span className="font-semibold text-fg text-sm">Preflight</span>
        <Badge tone={v.tone}>{v.label}</Badge>
        {preflight.cost_usd !== null ? (
          <span className="text-fg-muted text-xs tabular-nums">
            {usd(preflight.cost_usd)} · {preflight.turns ?? '?'} turns ·{' '}
            {duration(preflight.duration_s)} · read-only
          </span>
        ) : null}
        {time ? <span className="ml-auto text-fg-subtle text-xs tabular-nums">{time}</span> : null}
      </div>
      {r ? (
        <div className="space-y-4 px-4 py-4">
          <div className="flex flex-wrap gap-2">
            <Estimate
              n={r.files.length}
              unit="files"
              limit={limits?.max_files}
              tolerance={limits?.tolerance ?? 0}
            />
            <Estimate
              n={r.concepts.length}
              unit="concepts"
              limit={limits?.max_concepts}
              tolerance={limits?.tolerance ?? 0}
            />
            {r.questions.length ? <Estimate n={r.questions.length} unit="questions" /> : null}
          </div>
          {r.summary ? <Markdown className="max-w-prose">{r.summary}</Markdown> : null}
          {r.questions.length ? (
            <Part label="Questions">
              <ol className="list-decimal space-y-1.5 pl-4 marker:text-fg-subtle">
                {r.questions.map((q) => (
                  <li key={q}>
                    <Markdown>{q}</Markdown>
                  </li>
                ))}
              </ol>
            </Part>
          ) : null}
          {r.subtasks.length ? (
            <Part label="Proposed split">
              <ol className="space-y-1">
                {r.subtasks.map((s, i) => (
                  <li key={s.title}>
                    <Disclosure
                      summary={
                        <span>
                          <span className="text-fg-subtle tabular-nums">{i + 1}.</span>{' '}
                          <span className="font-medium">{s.title}</span>
                        </span>
                      }
                    >
                      <Markdown className="text-13 text-fg-muted">{s.body}</Markdown>
                    </Disclosure>
                  </li>
                ))}
              </ol>
            </Part>
          ) : null}
          {r.concepts.length ? (
            <Part label="Concepts">
              <Bullets items={r.concepts} />
            </Part>
          ) : null}
          {r.files.length ? (
            <Part label="Files">
              <Disclosure summary={<span>{r.files.length} to create or change</span>}>
                <ul className="space-y-0.5 font-mono text-fg-muted text-xs">
                  {r.files.map((f) => (
                    <li key={f} className="break-all">
                      {f}
                    </li>
                  ))}
                </ul>
              </Disclosure>
            </Part>
          ) : null}
          {r.dependencies.length ? (
            <Part label="New deps">
              <Bullets items={r.dependencies} />
            </Part>
          ) : null}
          {r.risks.length ? (
            <Part label="Risks">
              <Bullets items={r.risks} />
            </Part>
          ) : null}
        </div>
      ) : null}
      {preflight.run_id ? (
        <div className="border-line border-t">
          <button
            type="button"
            onClick={() => setShowRun(!showRun)}
            aria-expanded={showRun}
            className="flex w-full items-center gap-1.5 px-4 py-2 text-left text-fg-muted text-xs transition-colors hover:bg-hover hover:text-fg"
          >
            <ChevronRight
              className={clsx('size-3.5 shrink-0 transition-transform', showRun && 'rotate-90')}
            />
            Assessment conversation
          </button>
          {showRun ? <Conversation taskId={taskId} runId={preflight.run_id} /> : null}
        </div>
      ) : null}
    </div>
  )
}

function Conversation({ taskId, runId }: { taskId: string; runId: string }) {
  const { data, error, isLoading } = useTaskRunTranscript(taskId, runId, false)
  return (
    <div className="border-line border-t bg-canvas px-4 py-3">
      {isLoading ? (
        <Loading what="conversation" className="py-2" />
      ) : error || !data ? (
        <ErrorBox error={error ?? 'missing'} />
      ) : (
        <Transcript events={data.events} />
      )}
    </div>
  )
}
