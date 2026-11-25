'use client'

import clsx from 'clsx'
import { useTranslations } from 'next-intl'
import { useEffect, useRef, useState } from 'react'
import { Check, Copy } from './icons'

/**
 * Copies `text`, or without it the text of the `pre` in the nearest `[data-copy-scope]`
 * (code rendered on the server needs no second copy of itself in the page).
 */
export function CopyButton({ text, className }: { text?: string; className?: string }) {
  const t = useTranslations('ui.copy')
  const ref = useRef<HTMLButtonElement>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const id = setTimeout(() => setCopied(false), 1600)
    return () => clearTimeout(id)
  }, [copied])

  async function copy() {
    const value =
      text ?? ref.current?.closest('[data-copy-scope]')?.querySelector('pre')?.textContent ?? ''
    try {
      await navigator.clipboard.writeText(value.replace(/\n$/, ''))
      setCopied(true)
    } catch {
      // no clipboard (insecure origin): the text stays selectable
    }
  }

  return (
    <button
      ref={ref}
      type="button"
      onClick={copy}
      aria-label={copied ? t('copied') : t('copy')}
      title={copied ? t('copied') : t('copy')}
      className={clsx(
        'inline-flex size-8 items-center justify-center rounded-sm border border-rule bg-bg text-ink-3 transition-colors hover:border-rule-strong hover:text-ink',
        copied && 'text-ok hover:text-ok',
        className,
      )}
    >
      {copied ? <Check /> : <Copy />}
      <span className="sr-only" aria-live="polite">
        {copied ? t('copied') : ''}
      </span>
    </button>
  )
}
