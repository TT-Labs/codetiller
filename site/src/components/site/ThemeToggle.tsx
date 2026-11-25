'use client'

import { useTranslations } from 'next-intl'
import { useEffect, useState } from 'react'
import { Monitor, Moon, Sun } from '../ui/icons'

const ORDER = ['system', 'light', 'dark'] as const
type Theme = (typeof ORDER)[number]

const ICON = { system: Monitor, light: Sun, dark: Moon }

/**
 * System → light → dark. The choice is `data-theme` on <html> (set before paint by the script in
 * the root layout) and `theme` in localStorage; "system" is the absence of both.
 */
export function ThemeToggle() {
  const t = useTranslations('ui.theme')
  const [theme, setTheme] = useState<Theme>('system')

  useEffect(() => {
    const stored = document.documentElement.dataset.theme
    if (stored === 'light' || stored === 'dark') setTheme(stored)
  }, [])

  function cycle() {
    const next = ORDER[(ORDER.indexOf(theme) + 1) % ORDER.length] ?? 'system'
    setTheme(next)
    try {
      if (next === 'system') {
        delete document.documentElement.dataset.theme
        localStorage.removeItem('theme')
      } else {
        document.documentElement.dataset.theme = next
        localStorage.setItem('theme', next)
      }
    } catch {
      // storage refused: the choice holds for this page
    }
  }

  const Icon = ICON[theme]
  const label = `${t('label')}: ${t(theme)}`
  return (
    <button
      type="button"
      onClick={cycle}
      aria-label={label}
      title={label}
      className="inline-flex size-9 items-center justify-center rounded-sm text-ink-2 transition-colors hover:bg-sunk hover:text-ink"
    >
      <Icon />
    </button>
  )
}
