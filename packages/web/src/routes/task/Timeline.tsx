import { clsx } from 'clsx'
import { type ReactNode, useState } from 'react'
import {
  LIVE_STATES,
  type RunFile,
  type TaskDetail,
  type TaskEvent,
  type TaskRun,
  useTaskRunFile,
  useTaskRunTranscript,
} from '../../api'
import { Diff } from '../../components/Diff'
import { Markdown } from '../../components/Markdown'
import { Transcript } from '../../components/Transcript'
import { Badge } from '../../components/ui/Badge'
import {
  Check,
  ChevronRight,
  FileText,
  Info,
  Question,
  Terminal,
  User,
} from '../../components/ui/icons'
import { CodeBlock, ErrorBox, Loading } from '../../components/ui/states'
import { Tabs } from '../../components/ui/Tabs'
import { duration, stripAnsi, usd, when } from '../../format'
import { PreflightCard, verdictOf } from './Preflight'

type Tone = 'neutral' | 'accent' | 'success' | 'warning'

const MARKER: Record<Tone, string> = {
  neutral: 'border-line-strong bg-surface text-fg-subtle',
  accent: 'border-accent-line bg-accent-soft text-accent-text',
  success: 'border-success-line bg-success-soft text-success',
  warning: 'border-warning-line bg-warning-soft text-warning',
}

/** one entry on the rail: an icon marker on the left, content on the right */
function Item({
  icon,
  tone = 'neutral',
  children,
}: {
  icon: ReactNode
  tone?: Tone
  children: ReactNode
}) {
  return (
    <li className="relative pl-10">
      <span
        className={clsx(
          'absolute top-2 left-0 grid size-7 place-items-center rounded-full border',
          MARKER[tone],
        )}
      >
        {icon}
      </span>
      {children}
    </li>
  )
}

const LINK = /(https?:\/\/[^\s<>"')\]]+)/g

/** event text with its URLs clickable (PR and issue links the factory writes into the record) */
function Linked({ text }: { text: string }) {
  const seen = new Map<string, number>()
  return text.split(LINK).map((part) => {
    if (!part.startsWith('http')) return part
    // the same URL twice in one line still needs distinct keys
    const nth = (seen.get(part) ?? 0) + 1
    seen.set(part, nth)
    return (
      <a
        key={`${part}#${nth}`}
        href={part}
        target="_blank"
        rel="noreferrer"
        className="text-accent-text hover:underline"
      >
        {part}
      </a>
    )
  })
}

export function Timeline({ data }: { data: TaskDetail }) {
  const runs = new Map(data.runs.map((r) => [r.id, r]))
  return (
    <ol className="relative flex max-w-5xl flex-col gap-3 before:absolute before:top-4 before:bottom-4 before:left-3.5 before:w-px before:bg-line-strong">
      <Item icon={<FileText className="size-3.5" />}>
        <Bubble who="task">
          {data.item.body ? (
            <Markdown>{data.item.body}</Markdown>
          ) : (
            <span className="text-fg-subtle">(no description)</span>
          )}
        </Bubble>
      </Item>
      {data.events.map((e) => (
        <TimelineEvent
          key={e.id}
          e={e}
          run={e.run_id ? runs.get(e.run_id) : undefined}
          taskId={data.item.id}
          live={LIVE_STATES.includes(data.item.state)}
          data={data}
        />
      ))}
    </ol>
  )
}

function TimelineEvent({
  e,
  run,
  taskId,
  live,
  data,
}: {
  e: TaskEvent
  run?: TaskRun
  taskId: string
  live: boolean
  data: TaskDetail
}) {
  const time = when(e.at)
  // the assessment's own event carries the full report; other preflight notes (skipped) are lines
  if (e.kind === 'preflight' && data.preflight?.run_id && data.preflight.run_id === e.run_id) {
    const tone = verdictOf(data.preflight.verdict).tone
    return (
      <Item icon={<Info className="size-3.5" />} tone={tone === 'danger' ? 'warning' : tone}>
        <PreflightCard
          preflight={data.preflight}
          limits={data.preflight.limits ?? data.preflightLimits}
          taskId={taskId}
          time={time}
        />
        {data.preflight.report ? null : (
          <p className="mt-1.5 whitespace-pre-wrap break-words text-13 text-fg-muted">{e.text}</p>
        )}
      </Item>
    )
  }
  switch (e.kind) {
    case 'message':
      return (
        <Item icon={<User className="size-3.5" />}>
          <Bubble who="you" time={time} className="bg-subtle">
            <Markdown>{e.text ?? ''}</Markdown>
          </Bubble>
        </Item>
      )
    case 'question':
      return (
        <Item icon={<Question className="size-3.5" />} tone="warning">
          <Bubble who="agent asks" time={time} className="border-warning-line">
            <Markdown>{e.text ?? ''}</Markdown>
          </Bubble>
        </Item>
      )
    case 'summary':
      return (
        <Item icon={<Check className="size-3.5" />} tone="success">
          {/* collapsed: the latest summary is in the status block, earlier ones are history */}
          <details className="group rounded-lg border border-success-line bg-surface">
            <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-2.5 [&::-webkit-details-marker]:hidden">
              <ChevronRight className="size-4 shrink-0 text-fg-subtle transition-transform group-open:rotate-90" />
              <span className="font-semibold text-11 text-fg-muted uppercase tracking-wider">
                agent done
              </span>
              <span className="min-w-0 flex-1 truncate text-13 text-fg-muted">
                {firstLine(e.text)}
              </span>
              <span className="shrink-0 text-fg-subtle text-xs tabular-nums">{time}</span>
            </summary>
            <div className="border-line border-t px-4 py-3">
              <Markdown>{e.text ?? ''}</Markdown>
            </div>
          </details>
        </Item>
      )
    case 'run_started':
      return run ? (
        <Item icon={<Terminal className="size-3.5" />} tone="accent">
          <RunCard run={run} taskId={taskId} live={live && run.finished_at === null} time={time} />
        </Item>
      ) : null
    case 'run_finished':
      return null // shown on the run card
    default:
      return (
        <li className="relative flex min-h-6 items-baseline gap-2 pl-10 text-fg-subtle text-xs">
          <span
            aria-hidden="true"
            className="absolute top-1 left-2 size-2 rounded-full border-2 border-canvas bg-line-strong box-content"
          />
          <span className="shrink-0 tabular-nums">{time}</span>
          <span className="min-w-0 break-words">
            <span className="font-medium text-fg-muted">{e.kind}</span>
            {e.text ? (
              <>
                {' · '}
                <Linked text={e.text} />
              </>
            ) : null}
          </span>
        </li>
      )
  }
}

/** first prose line of a markdown text, markers stripped, for a one-line preview */
const firstLine = (text: string | null) =>
  (text ?? '')
    .split('\n')
    .map((l) =>
      l
        .replace(/^[#>*\-\s]+/, '')
        .replaceAll('**', '')
        .trim(),
    )
    .find(Boolean) ?? ''

function Bubble({
  who,
  time,
  className,
  children,
}: {
  who: string
  time?: string
  className?: string
  children: ReactNode
}) {
  return (
    <div className={clsx('rounded-lg border border-line bg-surface px-4 py-3', className)}>
      <div className="mb-1.5 flex items-baseline gap-2 text-xs">
        <span className="font-semibold text-fg-muted uppercase tracking-wider text-11">{who}</span>
        {time ? <span className="text-fg-subtle tabular-nums">{time}</span> : null}
      </div>
      <div className="min-w-0 break-words text-fg leading-relaxed">{children}</div>
    </div>
  )
}

function RunCard({
  run,
  taskId,
  live,
  time,
}: {
  run: TaskRun
  taskId: string
  live: boolean
  time: string
}) {
  const [open, setOpen] = useState(live)
  const running = run.finished_at === null
  return (
    <div className="overflow-hidden rounded-lg border border-line bg-surface shadow-xs">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-left transition-colors hover:bg-hover"
      >
        <ChevronRight
          className={clsx(
            'size-4 shrink-0 text-fg-subtle transition-transform',
            open && 'rotate-90',
          )}
        />
        <span className="font-semibold text-fg text-sm">Run {run.seq}</span>
        {running ? (
          <Badge tone="accent" dot pulse>
            running…
          </Badge>
        ) : (
          <Badge
            tone={run.agent_exit === 'ok' ? 'success' : run.agent_exit ? 'warning' : 'neutral'}
          >
            {run.agent_exit ?? '—'}
          </Badge>
        )}
        {running ? null : (
          <span className="text-fg-muted text-xs tabular-nums">
            {run.model ? `${run.model} · ` : ''}
            {usd(run.cost_usd)} · {run.turns ?? '?'} turns · {duration(run.duration_s)} ·{' '}
            {run.diff_files ?? 0} files
          </span>
        )}
        {run.session_id && run.seq > 1 ? <Badge>resumed session</Badge> : null}
        <span className="ml-auto text-fg-subtle text-xs tabular-nums">{time}</span>
      </button>
      {open ? <RunDetails taskId={taskId} run={run} live={live} /> : null}
    </div>
  )
}

type RunView = 'conversation' | RunFile

// order a reviewer reads in: what it did, what changed, did it hold; then the inputs
const RUN_VIEWS: { id: RunView; label: string }[] = [
  { id: 'conversation', label: 'Conversation' },
  { id: 'diff', label: 'Changes' },
  { id: 'verify', label: 'Verification' },
  { id: 'manifest', label: 'Manifest' },
  { id: 'prompt', label: 'Prompt' },
  { id: 'context', label: 'Context' },
  { id: 'stderr', label: 'stderr' },
]

/** One run's evidence: the conversation and the artifacts the factory kept for it. */
function RunDetails({ taskId, run, live }: { taskId: string; run: TaskRun; live: boolean }) {
  const [view, setView] = useState<RunView>('conversation')
  return (
    <div className="border-line border-t">
      <div className="bg-subtle px-4 pt-1">
        <Tabs<RunView>
          label={`Run ${run.seq} views`}
          value={view}
          onChange={setView}
          tabs={RUN_VIEWS.map((v) => ({
            ...v,
            // `files` is absent when the server is older than this page (a `tiller ui` that was
            // not restarted after an update): show the conversation rather than crash
            hidden: v.id !== 'conversation' && !(run.files ?? []).includes(v.id),
          }))}
        />
      </div>
      {view === 'conversation' ? (
        <RunConversation taskId={taskId} runId={run.id} live={live} />
      ) : (
        <RunFileView taskId={taskId} runId={run.id} file={view} />
      )}
    </div>
  )
}

function RunFileView({ taskId, runId, file }: { taskId: string; runId: string; file: RunFile }) {
  const { data, error, isLoading } = useTaskRunFile(taskId, runId, file)
  return (
    <div className="bg-canvas px-4 py-3">
      {isLoading ? (
        <Loading what={file} className="py-2" />
      ) : error || !data ? (
        <ErrorBox error={error ?? 'missing'} />
      ) : file === 'diff' ? (
        <Diff text={data.text} />
      ) : (
        <CodeBlock className="max-h-[60vh]">{stripAnsi(data.text)}</CodeBlock>
      )}
    </div>
  )
}

function RunConversation({
  taskId,
  runId,
  live,
}: {
  taskId: string
  runId: string
  live: boolean
}) {
  const { data, error, isLoading } = useTaskRunTranscript(taskId, runId, live)
  return (
    <div className="bg-canvas px-4 py-3">
      {isLoading ? (
        <Loading what="conversation" className="py-2" />
      ) : error || !data ? (
        <ErrorBox error={error ?? 'missing'} />
      ) : !data.events.length ? (
        <p className="text-13 text-fg-subtle">waiting for the agent…</p>
      ) : (
        <Transcript events={data.events} />
      )}
    </div>
  )
}
