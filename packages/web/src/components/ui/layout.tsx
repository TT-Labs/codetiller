import { clsx } from 'clsx'
import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { ChevronRight, ExternalLink } from './icons'

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={clsx('rounded-lg border border-line bg-surface shadow-xs', className)}>
      {children}
    </div>
  )
}

export type Crumb = { label: ReactNode; to?: string }

export function PageHeader({
  crumbs,
  title,
  badge,
  description,
  meta,
  actions,
}: {
  crumbs?: Crumb[]
  title: ReactNode
  badge?: ReactNode
  description?: ReactNode
  meta?: ReactNode
  actions?: ReactNode
}) {
  return (
    <header className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        {crumbs ? (
          <nav aria-label="Breadcrumb" className="mb-2">
            <ol className="flex flex-wrap items-center gap-1 text-13 text-fg-subtle">
              {crumbs.map((c, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: static trail
                <li key={i} className="flex min-w-0 items-center gap-1">
                  {i > 0 ? <ChevronRight className="size-3.5 shrink-0 opacity-60" /> : null}
                  {c.to ? (
                    <Link to={c.to} className="truncate hover:text-fg hover:underline">
                      {c.label}
                    </Link>
                  ) : (
                    <span className="truncate text-fg-muted">{c.label}</span>
                  )}
                </li>
              ))}
            </ol>
          </nav>
        ) : null}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h1 className="text-balance font-semibold text-fg text-xl tracking-tight">{title}</h1>
          {badge}
        </div>
        {description ? <p className="mt-1 text-fg-muted text-sm">{description}</p> : null}
        {meta ? <div className="mt-3">{meta}</div> : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  )
}

export type MetaItem = { label?: string; value: ReactNode; mono?: boolean }

/** inline key-value list for page metadata (repo, branch, model, …) */
export function MetaList({ items }: { items: (MetaItem | false | null | undefined | '')[] }) {
  return (
    <dl className="flex flex-wrap gap-x-5 gap-y-1.5 text-13">
      {items
        .filter((it): it is MetaItem => !!it)
        .map((item, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static list
          <div key={i} className="flex min-w-0 items-baseline gap-1.5">
            {item.label ? <dt className="shrink-0 text-fg-subtle">{item.label}</dt> : null}
            <dd className={clsx('min-w-0 break-words text-fg', item.mono && 'font-mono text-xs')}>
              {item.value}
            </dd>
          </div>
        ))}
    </dl>
  )
}

export function Section({
  title,
  count,
  hint,
  actions,
  className,
  children,
}: {
  title: ReactNode
  count?: number
  hint?: ReactNode
  actions?: ReactNode
  className?: string
  children: ReactNode
}) {
  return (
    <section className={clsx('space-y-3', className)}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <h2 className="font-semibold text-fg text-sm">{title}</h2>
        {count !== undefined ? (
          <span className="rounded-full bg-subtle px-1.5 font-medium text-fg-muted text-xs tabular-nums ring-1 ring-line ring-inset">
            {count}
          </span>
        ) : null}
        {hint ? <span className="text-13 text-fg-subtle">{hint}</span> : null}
        {actions ? <div className="ml-auto">{actions}</div> : null}
      </div>
      {children}
    </section>
  )
}

export function StatGrid({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={clsx('grid grid-cols-[repeat(auto-fit,minmax(10rem,1fr))] gap-3', className)}>
      {children}
    </div>
  )
}

export function Stat({
  label,
  value,
  hint,
}: {
  label: string
  value: ReactNode
  hint?: ReactNode
}) {
  return (
    <div className="min-w-0 rounded-lg border border-line bg-surface px-4 py-3 shadow-xs">
      <div className="font-medium text-fg-subtle text-xs first-letter:uppercase">{label}</div>
      <div className="mt-1 font-semibold text-fg text-lg tabular-nums tracking-tight">{value}</div>
      {hint ? <div className="mt-0.5 text-fg-subtle text-xs">{hint}</div> : null}
    </div>
  )
}

/** external link with the standard ↗ affordance */
export function ExternalA({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 text-accent-text hover:underline"
    >
      {children}
      <ExternalLink className="size-3 shrink-0" />
    </a>
  )
}
