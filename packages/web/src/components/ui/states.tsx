import { clsx } from 'clsx'
import type { ReactNode } from 'react'
import { AlertCircle, Info, Spinner } from './icons'

export function Loading({ what, className }: { what: string; className?: string }) {
  return (
    <div
      role="status"
      className={clsx('flex items-center gap-2 py-6 text-13 text-fg-subtle', className)}
    >
      <Spinner className="size-4" />
      Loading {what}…
    </div>
  )
}

export function ErrorBox({ error, className }: { error: unknown; className?: string }) {
  return (
    <div
      role="alert"
      className={clsx(
        'flex items-start gap-2 rounded-md border border-danger-line bg-danger-soft px-3 py-2 text-13 text-danger',
        className,
      )}
    >
      <AlertCircle className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 whitespace-pre-wrap break-words">
        {error instanceof Error ? error.message : String(error)}
      </div>
    </div>
  )
}

/** neutral one-line feedback, e.g. the result of an import */
export function Notice({ children }: { children: ReactNode }) {
  return (
    <div
      role="status"
      className="flex items-start gap-2 rounded-md border border-line bg-surface px-3 py-2 text-13 text-fg-muted"
    >
      <Info className="mt-0.5 size-4 shrink-0 text-fg-subtle" />
      <div className="min-w-0">{children}</div>
    </div>
  )
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-lg border border-line-strong border-dashed px-6 py-10 text-center">
      <p className="font-medium text-fg text-sm">{title}</p>
      {children ? <div className="mt-1 text-13 text-fg-muted">{children}</div> : null}
    </div>
  )
}

/** inline code in prose */
export function Code({ children }: { children: ReactNode }) {
  return (
    <code className="rounded border border-line bg-subtle px-1 py-px font-mono text-[0.85em] text-fg">
      {children}
    </code>
  )
}

export function CodeBlock({
  children,
  muted,
  className,
}: {
  children: ReactNode
  muted?: boolean
  className?: string
}) {
  return (
    <pre
      className={clsx(
        'max-h-[70vh] overflow-auto rounded-md border border-line bg-code px-3 py-2.5 font-mono text-xs leading-5',
        muted ? 'text-fg-muted' : 'text-fg',
        className,
      )}
    >
      {children}
    </pre>
  )
}
