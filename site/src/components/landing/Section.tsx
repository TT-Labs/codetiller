import clsx from 'clsx'
import type { ReactNode } from 'react'
import { rich } from '@/lib/rich'

/** The small plus where a section's rule crosses the rails of the frame. */
function Cross({ className }: { className?: string }) {
  return (
    <svg
      width="9"
      height="9"
      viewBox="0 0 9 9"
      aria-hidden="true"
      className={clsx('pointer-events-none absolute z-10 hidden text-ink-3 sm:block', className)}
    >
      <path d="M4.5 0v9M0 4.5h9" stroke="currentColor" />
    </svg>
  )
}

interface SectionProps {
  id?: string
  /** `dark`: a dark band whatever the theme; `signal`: the accent band of the closing call */
  tone?: 'page' | 'dark' | 'signal'
  className?: string
  children: ReactNode
}

/** A full-width band with a rule on top; its content sits between the rails of the frame. */
export function Section({ id, tone = 'page', className, children }: SectionProps) {
  return (
    <section
      id={id}
      className={clsx(
        'border-t border-rule',
        tone === 'dark' && 'scheme-dark bg-sunk text-ink',
        tone === 'signal' && 'on-signal border-signal bg-signal text-[#14130f]',
      )}
    >
      <div className={clsx('frame relative', tone === 'signal' && 'border-black/15!')}>
        {tone !== 'signal' && (
          <>
            <Cross className="-top-[5px] -left-[5px]" />
            <Cross className="-top-[5px] -right-[5px]" />
          </>
        )}
        <div className={clsx('pad py-20 lg:py-28', className)}>{children}</div>
      </div>
    </section>
  )
}

interface HeadProps {
  n: string
  label: string
  title: string
  lead?: string
  className?: string
}

/** Number and name of the section, its statement, and a sentence or two under it. */
export function SectionHead({ n, label, title, lead, className }: HeadProps) {
  return (
    <header className={className}>
      <p className="label flex items-center gap-2.5 text-ink-3">
        <span className="text-signal-ink">{n}</span>
        <span aria-hidden="true" className="h-px w-6 bg-rule-strong" />
        {label}
      </p>
      <h2 className="heading mt-5 max-w-[19ch] text-[clamp(1.875rem,3.7vw,3.125rem)]">{title}</h2>
      {lead && (
        <p className="mt-5 max-w-[58ch] text-[1.0625rem] leading-relaxed text-ink-2">
          {rich(lead)}
        </p>
      )}
    </header>
  )
}
