'use client'

import clsx from 'clsx'
import { useTranslations } from 'next-intl'
import { useEffect, useRef } from 'react'
import { Link, usePathname } from '@/i18n/navigation'
import type { NavEntry } from '@/lib/docs'

/** The pages of the docs, grouped; the current one is marked. */
export function SidebarNav({ nav }: { nav: NavEntry[] }) {
  const t = useTranslations('ui.docs')
  const pathname = usePathname()
  return (
    <nav aria-label={t('sidebar')}>
      <ul className="space-y-7">
        {nav.map((group) => (
          <li key={group.group}>
            <p className="label text-ink-3">{t(`groups.${group.group}`)}</p>
            <ul className="mt-2.5 border-l border-rule">
              {group.pages.map((page) => {
                const current = pathname === page.href
                return (
                  <li key={page.slug}>
                    <Link
                      href={page.href}
                      aria-current={current ? 'page' : undefined}
                      className={clsx(
                        '-ml-px block border-l py-1.5 pl-4 text-[0.9375rem] transition-colors',
                        current
                          ? 'border-signal font-[600] text-ink'
                          : 'border-transparent text-ink-2 hover:border-rule-strong hover:text-ink',
                      )}
                    >
                      {page.title}
                    </Link>
                  </li>
                )
              })}
            </ul>
          </li>
        ))}
      </ul>
    </nav>
  )
}

/** Below `lg` the sidebar is a disclosure above the page; a new page closes it. */
export function MobileSidebar({ nav }: { nav: NavEntry[] }) {
  const t = useTranslations('ui.docs')
  const pathname = usePathname()
  const details = useRef<HTMLDetailsElement>(null)
  const current = nav.flatMap((g) => g.pages).find((p) => p.href === pathname)

  // biome-ignore lint/correctness/useExhaustiveDependencies: closes on navigation
  useEffect(() => {
    if (details.current) details.current.open = false
  }, [pathname])

  return (
    <details ref={details} className="reveal group border-b border-rule lg:hidden">
      <summary className="pad flex h-12 items-center gap-3 text-[0.9375rem]">
        <span className="label text-ink-3">{t('menu')}</span>
        <span className="min-w-0 truncate font-[560]">{current?.title}</span>
        <span
          aria-hidden="true"
          className="ml-auto font-mono text-ink-3 transition-transform group-open:rotate-45"
        >
          +
        </span>
      </summary>
      <div className="pad border-t border-rule pt-6 pb-8">
        <SidebarNav nav={nav} />
      </div>
    </details>
  )
}
