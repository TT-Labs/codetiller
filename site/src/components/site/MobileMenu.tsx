'use client'

import { useTranslations } from 'next-intl'
import { useEffect, useState } from 'react'
import { Link, usePathname } from '@/i18n/navigation'
import { ArrowUpRight, Close, Menu } from '../ui/icons'

interface Item {
  href: string
  label: string
}

/** The navigation below `md`: a sheet under the header. */
export function MobileMenu({ items, github }: { items: Item[]; github: string | null }) {
  const t = useTranslations('ui.nav')
  const pathname = usePathname()
  const [open, setOpen] = useState(false)

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new page closes the sheet
  useEffect(() => setOpen(false), [pathname])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.documentElement.style.overflow = 'hidden'
    window.addEventListener('keydown', onKey)
    return () => {
      document.documentElement.style.overflow = ''
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className="md:hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls="mobile-menu"
        aria-label={open ? t('closeMenu') : t('openMenu')}
        className="inline-flex size-9 items-center justify-center rounded-sm text-ink transition-colors hover:bg-sunk"
      >
        {open ? <Close /> : <Menu />}
      </button>
      <div
        id="mobile-menu"
        hidden={!open}
        className="fixed inset-x-0 top-14 bottom-0 z-40 overflow-y-auto border-t border-rule bg-bg"
      >
        <nav aria-label={t('label')} className="pad py-4">
          <ul>
            {items.map((item, i) => (
              <li key={item.href} className="border-b border-rule">
                <Link
                  href={item.href}
                  onClick={() => setOpen(false)}
                  className="flex items-baseline gap-4 py-5"
                >
                  <span className="label text-ink-3">{String(i + 1).padStart(2, '0')}</span>
                  <span className="heading text-2xl">{item.label}</span>
                </Link>
              </li>
            ))}
            {github && (
              <li>
                <a
                  href={github}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-2 py-5 text-ink-2"
                >
                  {t('github')}
                  <ArrowUpRight />
                </a>
              </li>
            )}
          </ul>
        </nav>
      </div>
    </div>
  )
}
