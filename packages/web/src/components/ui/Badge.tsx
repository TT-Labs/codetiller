import { clsx } from 'clsx'
import type { ReactNode } from 'react'

export type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger'

const TONE: Record<Tone, string> = {
  neutral: 'bg-subtle text-fg-muted ring-line',
  accent: 'bg-accent-soft text-accent-text ring-accent-line',
  success: 'bg-success-soft text-success ring-success-line',
  warning: 'bg-warning-soft text-warning ring-warning-line',
  danger: 'bg-danger-soft text-danger ring-danger-line',
}

/** for links that look like badges (run pills) */
export const badgeClass = (tone: Tone) =>
  clsx(
    'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-px font-medium text-xs ring-1 ring-inset',
    TONE[tone],
  )

export function Badge({
  tone = 'neutral',
  dot,
  pulse,
  title,
  className,
  children,
}: {
  tone?: Tone
  dot?: boolean
  pulse?: boolean
  title?: string
  className?: string
  children: ReactNode
}) {
  return (
    <span className={clsx(badgeClass(tone), className)} title={title}>
      {dot ? (
        <span
          aria-hidden="true"
          className={clsx('size-1.5 rounded-full bg-current', pulse && 'motion-safe:animate-pulse')}
        />
      ) : null}
      {children}
    </span>
  )
}

export const outcomeTone = (outcome: string | null): Tone =>
  outcome === 'success'
    ? 'success'
    : outcome === 'fail'
      ? 'danger'
      : outcome === 'timeout' || outcome === 'error'
        ? 'warning'
        : 'neutral'

export function Outcome({ value }: { value: string | null }) {
  return <Badge tone={outcomeTone(value)}>{value ?? 'unknown'}</Badge>
}

/** fraction of successful runs, e.g. 1/2 */
export function RateCell({ successes, runs }: { successes: number; runs: number }) {
  const tone = successes === runs ? 'success' : successes === 0 ? 'danger' : 'warning'
  return (
    <Badge tone={tone} className="font-mono tabular-nums">
      {successes}/{runs}
    </Badge>
  )
}

// keyed by string, not TaskState: a state added on the server renders as a neutral badge
const TASK_STATE: Record<string, { label: string; tone: Tone }> = {
  IMPORTED: { label: 'not started', tone: 'neutral' },
  QUEUED: { label: 'queued', tone: 'accent' },
  PREFLIGHT: { label: 'preflight', tone: 'accent' },
  RUNNING: { label: 'running', tone: 'accent' },
  WAITING_FOR_HUMAN: { label: 'needs answer', tone: 'warning' },
  REVIEW: { label: 'review', tone: 'warning' },
  PR_OPEN: { label: 'PR open', tone: 'warning' },
  COMPLETED: { label: 'completed', tone: 'success' },
  FAILED: { label: 'failed', tone: 'danger' },
  CANCELLED: { label: 'cancelled', tone: 'neutral' },
}

export function TaskStateBadge({ state }: { state: string }) {
  const s = TASK_STATE[state] ?? {
    label: state.toLowerCase().replaceAll('_', ' '),
    tone: 'neutral',
  }
  return (
    <Badge tone={s.tone} dot pulse={state === 'RUNNING' || state === 'PREFLIGHT'}>
      {s.label}
    </Badge>
  )
}
