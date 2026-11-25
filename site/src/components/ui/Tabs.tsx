'use client'

import clsx from 'clsx'
import { type KeyboardEvent, type ReactNode, useId, useRef, useState } from 'react'

interface Tab {
  id: string
  label: string
  /** rendered on the server and handed over; all panels stay in the page, one is shown */
  content: ReactNode
}

/** Tabs by the ARIA pattern: arrow keys move between tabs, Home and End jump. */
export function Tabs({ tabs, label }: { tabs: Tab[]; label: string }) {
  const base = useId()
  const [active, setActive] = useState(tabs[0]?.id)
  const buttons = useRef<(HTMLButtonElement | null)[]>([])

  function onKeyDown(e: KeyboardEvent, i: number) {
    const to =
      e.key === 'ArrowRight'
        ? (i + 1) % tabs.length
        : e.key === 'ArrowLeft'
          ? (i - 1 + tabs.length) % tabs.length
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? tabs.length - 1
              : -1
    const tab = tabs[to]
    if (!tab) return
    e.preventDefault()
    setActive(tab.id)
    buttons.current[to]?.focus()
  }

  return (
    <div>
      <div role="tablist" aria-label={label} className="flex border-b border-rule">
        {tabs.map((tab, i) => {
          const selected = tab.id === active
          return (
            <button
              key={tab.id}
              ref={(el) => {
                buttons.current[i] = el
              }}
              type="button"
              role="tab"
              id={`${base}-tab-${tab.id}`}
              aria-selected={selected}
              aria-controls={`${base}-panel-${tab.id}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => setActive(tab.id)}
              onKeyDown={(e) => onKeyDown(e, i)}
              className={clsx(
                '-mb-px h-11 border-b-2 px-4 text-[0.9375rem] font-[560] transition-colors first:pl-0 sm:px-5',
                selected
                  ? 'border-signal text-ink'
                  : 'border-transparent text-ink-3 hover:text-ink',
              )}
            >
              {tab.label}
            </button>
          )
        })}
      </div>
      {tabs.map((tab) => (
        <div
          key={tab.id}
          role="tabpanel"
          id={`${base}-panel-${tab.id}`}
          aria-labelledby={`${base}-tab-${tab.id}`}
          hidden={tab.id !== active}
          className="pt-5"
        >
          {tab.content}
        </div>
      ))}
    </div>
  )
}
