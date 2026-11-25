'use client'

import clsx from 'clsx'
import { useLocale, useTranslations } from 'next-intl'
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useRouter } from '@/i18n/navigation'
import type { SearchEntry } from '@/lib/docs'
import { search } from '@/lib/search'
import { Search as SearchIcon } from '../ui/icons'

/** the words of the query, marked inside a text */
function Marked({ text, query }: { text: string; query: string }) {
  const terms = query
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  if (!terms.length) return text
  const parts = text.split(new RegExp(`(${terms.join('|')})`, 'gi'))
  return parts.map((part, i) =>
    i % 2 ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: parts of one string
      <mark key={i} className="bg-transparent font-[620] text-signal-ink">
        {part}
      </mark>
    ) : (
      // biome-ignore lint/suspicious/noArrayIndexKey: parts of one string
      <Fragment key={i}>{part}</Fragment>
    ),
  )
}

/** The search button of the header and its palette (⌘K, Ctrl+K or /). The index loads on first use. */
export function Search() {
  const t = useTranslations('ui.search')
  const locale = useLocale()
  const router = useRouter()
  const dialog = useRef<HTMLDialogElement>(null)
  const list = useRef<HTMLUListElement>(null)
  const [index, setIndex] = useState<SearchEntry[] | null>(null)
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)

  const hits = useMemo(() => (index ? search(index, query) : []), [index, query])

  const open = useRef(() => {})
  open.current = () => {
    if (dialog.current?.open) return
    dialog.current?.showModal()
    if (!index)
      fetch(`/api/docs-index/${locale}`)
        .then((r) => r.json())
        .then(setIndex)
        .catch(() => setIndex([]))
  }
  const close = () => dialog.current?.close()

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target as HTMLElement)?.tagName ?? '')
      if ((e.key === 'k' && (e.metaKey || e.ctrlKey)) || (e.key === '/' && !typing)) {
        e.preventDefault()
        open.current()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // biome-ignore lint/correctness/useExhaustiveDependencies: the cursor follows the results
  useEffect(() => setCursor(0), [hits])

  useEffect(() => {
    list.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  })

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const step = e.key === 'ArrowDown' ? 1 : -1
      setCursor((c) => (hits.length ? (c + step + hits.length) % hits.length : 0))
    } else if (e.key === 'Enter') {
      const hit = hits[cursor]
      if (!hit) return
      e.preventDefault()
      close()
      router.push(hit.href)
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => open.current()}
        aria-label={t('button')}
        className="inline-flex h-9 items-center gap-2 rounded-sm px-2.5 text-sm text-ink-2 transition-colors hover:bg-sunk hover:text-ink lg:border lg:border-rule lg:pr-2 lg:hover:border-rule-strong lg:hover:bg-transparent"
      >
        <SearchIcon />
        <span className="hidden lg:inline">{t('button')}</span>
        <kbd className="ml-3 hidden rounded-xs border border-rule px-1.5 py-0.5 text-[0.6875rem] text-ink-3 lg:inline">
          ⌘K
        </kbd>
      </button>

      {/* biome-ignore lint/a11y/useKeyWithClickEvents: Escape closes a modal dialog natively */}
      <dialog
        ref={dialog}
        onClick={(e) => e.target === dialog.current && close()}
        onClose={() => setQuery('')}
        aria-label={t('button')}
        className="mx-auto mt-[10vh] max-h-[min(34rem,76vh)] w-[min(40rem,calc(100vw-1.5rem))] overflow-hidden rounded-md border border-rule-strong bg-bg p-0 text-ink shadow-[0_24px_80px_-20px_rgb(0_0_0/0.45)] backdrop:bg-black/55 open:flex open:flex-col"
      >
        <div className="flex items-center gap-3 border-b border-rule px-4">
          <SearchIcon className="shrink-0 text-ink-3" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={t('placeholder')}
            aria-label={t('placeholder')}
            aria-controls="search-results"
            autoComplete="off"
            spellCheck={false}
            className="h-13 min-w-0 flex-1 bg-transparent text-base text-ink outline-none placeholder:text-ink-3 [&::-webkit-search-cancel-button]:hidden"
          />
          <button
            type="button"
            onClick={close}
            aria-label={t('close')}
            className="rounded-xs border border-rule px-1.5 py-0.5 font-mono text-[0.6875rem] text-ink-3 hover:text-ink"
          >
            esc
          </button>
        </div>

        <ul ref={list} id="search-results" className="min-h-0 flex-1 overflow-y-auto p-2">
          {hits.map((hit, i) => (
            <li key={hit.href}>
              <Link
                href={hit.href}
                onClick={close}
                onMouseMove={() => setCursor(i)}
                data-active={i === cursor}
                className={clsx(
                  'block rounded-sm border-l-2 px-3 py-2.5',
                  i === cursor ? 'border-signal bg-sunk' : 'border-transparent',
                )}
              >
                <span className="flex flex-wrap items-baseline gap-x-2 text-[0.9375rem] text-ink">
                  <span className={hit.heading ? 'text-ink-3' : 'font-[600]'}>
                    <Marked text={hit.page} query={query} />
                  </span>
                  {hit.heading && (
                    <>
                      <span className="text-ink-3" aria-hidden="true">
                        /
                      </span>
                      <span className="font-[600]">
                        <Marked text={hit.heading} query={query} />
                      </span>
                    </>
                  )}
                </span>
                {hit.snippet && (
                  <span className="mt-0.5 line-clamp-2 block text-[0.8125rem] leading-snug text-ink-2">
                    <Marked text={hit.snippet} query={query} />
                  </span>
                )}
              </Link>
            </li>
          ))}
          {!hits.length && (
            <li className="px-3 py-8 text-center text-sm text-ink-3" role="status">
              {!index
                ? t('loading')
                : query.trim()
                  ? t('empty', { query: query.trim() })
                  : t('hint')}
            </li>
          )}
        </ul>

        <div className="hidden items-center gap-4 border-t border-rule px-4 py-2.5 text-[0.75rem] text-ink-3 sm:flex">
          <span>
            <kbd className="font-mono text-ink-2">↑↓</kbd> {t('navigate')}
          </span>
          <span>
            <kbd className="font-mono text-ink-2">↵</kbd> {t('open')}
          </span>
          <span>
            <kbd className="font-mono text-ink-2">esc</kbd> {t('dismiss')}
          </span>
        </div>
      </dialog>
    </>
  )
}
