import clsx from 'clsx'
import type { ReactNode } from 'react'
import { Link } from '@/i18n/navigation'

const base =
  'group inline-flex h-11 items-center justify-center gap-2 rounded-sm px-5 text-[0.9375rem] font-[560] tracking-[-0.005em] whitespace-nowrap transition-colors duration-150'

const variants = {
  // ink on paper; the accent is the hover, so it stays rare on the page
  primary: 'bg-ink text-bg hover:bg-signal hover:text-on-signal',
  secondary: 'border border-rule-strong text-ink hover:border-ink',
  // on the accent-coloured block
  inverse: 'bg-[#14130f] text-[#f5f3ee] hover:bg-black',
  inverseSecondary: 'border border-black/40 text-[#14130f] hover:border-black',
} as const

interface Props {
  href: string
  variant?: keyof typeof variants
  className?: string
  children: ReactNode
}

/** A link that looks like a button: internal addresses go through the locale-aware router. */
export function ButtonLink({ href, variant = 'primary', className, children }: Props) {
  const cls = clsx(base, variants[variant], className)
  if (href.startsWith('mailto:'))
    return (
      <a href={href} className={cls}>
        {children}
      </a>
    )
  if (/^https?:/.test(href))
    return (
      <a href={href} className={cls} target="_blank" rel="noreferrer">
        {children}
      </a>
    )
  return (
    <Link href={href} className={cls}>
      {children}
    </Link>
  )
}
