import { clsx } from 'clsx'
import { type FormEvent, useId, useState } from 'react'
import { useNavigate } from 'react-router'
import {
  type TaskDetail,
  type TaskState,
  useEnqueue,
  useSetTaskModel,
  useSplitTask,
} from '../../api'
import { Button } from '../../components/ui/Button'
import { Select, Textarea } from '../../components/ui/form'
import { AlertCircle } from '../../components/ui/icons'
import { ErrorBox } from '../../components/ui/states'

interface Mode {
  label: string
  placeholder: string
  button: string
  attention?: boolean
  /** the run cannot start without a message */
  needsText?: boolean
}

/** What the composer does in each state: every send = human message + enqueue a run. */
const COMPOSER: Partial<Record<TaskState, Mode>> = {
  IMPORTED: {
    label: 'Start the agent',
    placeholder: 'Optional extra instructions…',
    button: 'Enqueue run',
  },
  WAITING_FOR_HUMAN: {
    label: 'The agent is waiting for your answer',
    placeholder: 'Your answer ("yes" accepts its recommendations)…',
    button: 'Answer & continue',
    attention: true,
    needsText: true,
  },
  REVIEW: {
    label: 'Review the result',
    placeholder: 'Requested changes for the agent…',
    button: 'Request changes',
    attention: true,
  },
  PR_OPEN: {
    label: 'Review the pull request',
    placeholder: 'Requested changes for the agent (or comment `/tiller …` on the PR)…',
    button: 'Request changes',
  },
  FAILED: {
    label: 'Last run failed',
    placeholder: 'Optional note for the retry…',
    button: 'Retry',
  },
}

/** The human gate after a preflight that did not pass: what was found decides what is asked. */
const GATE: Record<string, Mode> = {
  too_large: {
    label: 'Preflight: too large for one run',
    placeholder: 'Optional instructions if you run it as one task anyway…',
    button: 'Run as one task anyway',
    attention: true,
  },
  unclear: {
    label: 'Preflight needs answers before the run',
    placeholder: 'Your answers to the questions…',
    button: 'Answer & start',
    attention: true,
    needsText: true,
  },
  error: {
    label: 'Preflight failed',
    placeholder: 'Optional extra instructions…',
    button: 'Run without it',
    attention: true,
  },
}

export function Composer({ data }: { data: TaskDetail }) {
  const { item, preflight } = data
  const enqueue = useEnqueue(item.id)
  const split = useSplitTask(item.id)
  const setModel = useSetTaskModel(item.id)
  const navigate = useNavigate()
  const [text, setText] = useState('')
  const [skipPreflight, setSkipPreflight] = useState(false)
  const labelId = useId()
  const modelId = useId()
  // waiting before any run = stopped by the preflight, not by a question from a run
  const gated = item.state === 'WAITING_FOR_HUMAN' && data.runs.length === 0 && preflight
  const mode = (gated ? GATE[preflight.verdict] : undefined) ?? COMPOSER[item.state]
  if (!mode) return null
  const parts = gated ? (preflight.report?.subtasks.length ?? 0) : 0
  const assessFirst = item.state === 'IMPORTED' && data.preflightLimits && !preflight
  const submit = (e: FormEvent) => {
    e.preventDefault()
    enqueue.mutate(
      { message: text, skipPreflight: assessFirst ? skipPreflight : undefined },
      { onSuccess: () => setText('') },
    )
  }
  const busy = enqueue.isPending || split.isPending
  return (
    <form
      onSubmit={submit}
      className={clsx(
        'rounded-lg border bg-surface shadow-xs',
        mode.attention ? 'border-warning-line' : 'border-line',
      )}
    >
      <div className="flex items-center gap-2 px-4 pt-3">
        {mode.attention ? (
          <span aria-hidden="true" className="size-2 rounded-full bg-warning" />
        ) : null}
        <span id={labelId} className="font-semibold text-fg text-sm">
          {mode.label}
        </span>
      </div>
      <div className="px-4 py-3">
        <Textarea
          aria-labelledby={labelId}
          rows={3}
          value={text}
          placeholder={mode.placeholder}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit(e)
          }}
        />
      </div>
      <div className="flex flex-wrap items-center gap-3 px-4 pb-3">
        {parts > 0 ? (
          <Button
            variant="primary"
            disabled={busy}
            onClick={() => {
              if (
                confirm(
                  `Create ${parts} tasks from the proposed split and cancel ${item.id}? Nothing is queued.`,
                )
              )
                split.mutate(undefined, { onSuccess: () => navigate('/') })
            }}
          >
            Split into {parts} tasks
          </Button>
        ) : null}
        <Button
          type="submit"
          variant={parts > 0 ? 'secondary' : 'primary'}
          disabled={busy || (mode.needsText && !text.trim())}
        >
          {mode.button}
        </Button>
        {assessFirst ? (
          <label className="inline-flex items-center gap-1.5 text-13 text-fg-muted">
            <input
              type="checkbox"
              checked={skipPreflight}
              onChange={(e) => setSkipPreflight(e.target.checked)}
            />
            Skip preflight
          </label>
        ) : null}
        {data.model && data.models.length ? (
          <div className="inline-flex items-center gap-1.5 text-13 text-fg-muted">
            <span id={modelId}>Model</span>
            <Select
              aria-labelledby={modelId}
              className="h-7 text-13"
              title="The model of this task's next runs. Earlier runs keep the model they used; the agent's session carries over."
              value={data.model.chosen ?? ''}
              disabled={setModel.isPending}
              onChange={(e) => setModel.mutate(e.target.value || null)}
            >
              <option value="">Default ({data.model.fallback})</option>
              {data.models.map((m) => (
                <option key={m}>{m}</option>
              ))}
              {data.model.chosen && !data.models.includes(data.model.chosen) ? (
                <option value={data.model.chosen}>{data.model.chosen} (no longer offered)</option>
              ) : null}
            </Select>
          </div>
        ) : null}
        {data.canRun ? (
          <span className="text-fg-subtle text-xs">
            <kbd className="rounded border border-line bg-subtle px-1 font-sans">⌘↵</kbd> to send
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5 text-danger text-xs">
            <AlertCircle className="size-3.5" />
            no ANTHROPIC_API_KEY: runs stay queued
          </span>
        )}
        {enqueue.error ? <ErrorBox error={enqueue.error} className="w-full" /> : null}
        {setModel.error ? <ErrorBox error={setModel.error} className="w-full" /> : null}
        {split.error ? <ErrorBox error={split.error} className="w-full" /> : null}
      </div>
    </form>
  )
}
