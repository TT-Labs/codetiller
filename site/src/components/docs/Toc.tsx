'use client'

import clsx from 'clsx'
import { useEffect, useState } from 'react'
import type { TocItem } from '@/lib/docs'

/** "On this page": follows the heading the reader is at. */
export function Toc({ items, title }: { items: TocItem[]; title: string }) {
  const [active, setActive] = useState<string | null>(items[0]?.id ?? null)

  useEffect(() => {
    const headings = items
      .map((item) => document.getElementById(item.id))
      .filter((el): el is HTMLElement => el !== null)
    if (!headings.length) return
    // the current section = the last heading above a line a little under the header
    const update = () => {
      const line = 120
      let current = headings[0]
      for (const h of headings) if (h.getBoundingClientRect().top <= line) current = h
      // at the very end of the page the last section may never reach the line
      const atEnd = window.innerHeight + window.scrollY >= document.body.scrollHeight - 4
      setActive((atEnd ? headings.at(-1) : current)?.id ?? null)
    }
    update()
    window.addEventListener('scroll', update, { passive: true })
    window.addEventListener('resize', update)
    return () => {
      window.removeEventListener('scroll', update)
      window.removeEventListener('resize', update)
    }
  }, [items])

  if (!items.length) return null
  return (
    <nav aria-label={title}>
      <p className="label text-ink-3">{title}</p>
      <ul className="mt-3 border-l border-rule text-[0.8125rem] leading-snug">
        {items.map((item) => (
          <li key={item.id}>
            <a
              href={`#${item.id}`}
              aria-current={active === item.id ? 'location' : undefined}
              className={clsx(
                '-ml-px block border-l py-1.5 transition-colors',
                item.depth === 3 ? 'pl-7' : 'pl-4',
                active === item.id
                  ? 'border-signal text-ink'
                  : 'border-transparent text-ink-3 hover:text-ink',
              )}
            >
              {item.text}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  )
}
