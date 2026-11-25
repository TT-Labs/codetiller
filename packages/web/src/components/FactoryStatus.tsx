import { clsx } from 'clsx'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { type FactoryStatus as Status, useFactoryStatus, useSyncNow } from '../api'
import { ago } from '../format'
import { notificationsSupported } from '../notifications'
import { Button } from './ui/Button'
import { ErrorBox } from './ui/states'

type Tone = 'ok' | 'warn' | 'off'

/** one line for the header: the worst thing that is true */
function headline(s: Status): { tone: Tone; text: string } {
  if (!s.canRun) return { tone: 'warn', text: 'No model key' }
  if (!s.worker) return { tone: 'warn', text: 'Worker off' }
  const errors = (s.intake?.errors.length ?? 0) + (s.sync?.errors.length ?? 0)
  if (errors) return { tone: 'warn', text: 'GitHub sync failing' }
  if (s.running) return { tone: 'ok', text: `${s.running} running` }
  if (s.queued) return { tone: 'ok', text: `${s.queued} queued` }
  return { tone: 'ok', text: 'Factory idle' }
}

const DOT: Record<Tone, string> = {
  ok: 'bg-success',
  warn: 'bg-warning',
  off: 'bg-line-strong',
}

function Row({ label, tone, children }: { label: string; tone: Tone; children: ReactNode }) {
  return (
    <div className="flex items-start gap-2.5 py-1.5">
      <span aria-hidden="true" className={clsx('mt-1.5 size-2 shrink-0 rounded-full', DOT[tone])} />
      <div className="min-w-0">
        <div className="font-medium text-13 text-fg">{label}</div>
        <div className="break-words text-fg-muted text-xs">{children}</div>
      </div>
    </div>
  )
}

function Polled({ what, last }: { what: string; last: Status['intake'] }) {
  if (!last) return <>{what}: not polled yet</>
  return (
    <>
      {what}: {ago(last.at)}
      {last.errors.map((e) => (
        <span key={e} className="block text-danger">
          {e}
        </span>
      ))}
    </>
  )
}

/**
 * Is the factory alive: a worker in this process, model credentials, GitHub, the queue, and when
 * GitHub was last polled with what went wrong. Without this a failing sync is only in a log.
 */
export function FactoryStatus() {
  const { data, error } = useFactoryStatus()
  const sync = useSyncNow()
  const [open, setOpen] = useState(false)
  const [permission, setPermission] = useState(() =>
    notificationsSupported() ? Notification.permission : 'denied',
  )
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (
        e instanceof KeyboardEvent ? e.key === 'Escape' : !root.current?.contains(e.target as Node)
      )
        setOpen(false)
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', close)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', close)
    }
  }, [open])
  // the page is rebuilt on disk while an old server keeps running: say so instead of half-working
  if (error && !data)
    return (
      <span
        className="ml-auto inline-flex h-8 items-center gap-2 px-2.5 font-medium text-13 text-warning"
        title="The server does not know this page's API. Stop `tiller ui` and start it again."
      >
        <span aria-hidden="true" className="size-2 rounded-full bg-warning" />
        Server outdated: restart tiller ui
      </span>
    )
  if (!data) return null
  const h = headline(data)
  const github = data.canSync || data.canImport
  return (
    <div ref={root} className="relative ml-auto">
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen(!open)}
        className="inline-flex h-8 items-center gap-2 rounded-md px-2.5 font-medium text-13 text-fg-muted transition-colors hover:bg-hover hover:text-fg"
      >
        <span aria-hidden="true" className={clsx('size-2 rounded-full', DOT[h.tone])} />
        {h.text}
      </button>
      {open ? (
        <div
          role="dialog"
          aria-label="Factory status"
          className="absolute top-10 right-0 z-30 w-80 max-w-[calc(100vw-2rem)] rounded-lg border border-line bg-surface p-3 shadow-lg"
        >
          <Row label="Worker" tone={data.worker ? 'ok' : 'warn'}>
            {data.worker
              ? `runs queued tasks in this process · ${data.queued} queued · ${data.running} running`
              : 'not running here: queued tasks wait for `tiller ui`, `tiller daemon` or `tiller task run`'}
          </Row>
          <Row label="Model" tone={data.canRun ? 'ok' : 'warn'}>
            {data.canRun ? 'API key present' : 'ANTHROPIC_API_KEY not set: runs stay queued'}
          </Row>
          <Row label="GitHub" tone={github ? 'ok' : 'off'}>
            {!github
              ? 'TILLER_GITHUB_TOKEN not set: no PRs, no issue import'
              : data.projects.length
                ? data.projects.map((p) => `${p.repo} (label "${p.label}")`).join(', ')
                : 'no projects in tiller.yaml: issues are not imported'}
          </Row>
          {data.canImport ? (
            <Row label="Issue import" tone={data.intake?.errors.length ? 'warn' : 'ok'}>
              <Polled what="Last poll" last={data.intake} />
            </Row>
          ) : null}
          {data.canSync ? (
            <Row label="PR feedback" tone={data.sync?.errors.length ? 'warn' : 'ok'}>
              <Polled what="Last poll" last={data.sync} />
            </Row>
          ) : null}
          <div className="mt-2 flex flex-wrap items-center gap-2 border-line border-t pt-3">
            {github ? (
              <Button disabled={sync.isPending} onClick={() => sync.mutate(data)}>
                {sync.isPending ? 'Syncing…' : 'Sync now'}
              </Button>
            ) : null}
            {permission === 'default' ? (
              <Button
                variant="ghost"
                onClick={() => Notification.requestPermission().then(setPermission)}
              >
                Enable notifications
              </Button>
            ) : (
              <span className="text-fg-subtle text-xs">
                Notifications {permission === 'granted' ? 'on' : 'blocked in the browser'}
              </span>
            )}
          </div>
          {sync.error ? <ErrorBox error={sync.error} className="mt-2" /> : null}
        </div>
      ) : null}
    </div>
  )
}
