'use client'

import clsx from 'clsx'
import { useInView, useReducedMotion } from 'motion/react'
import { useTranslations } from 'next-intl'
import { useEffect, useRef, useState } from 'react'
import { Pause, Play } from '../ui/icons'

interface Station {
  name: string
  who: string
}

/**
 * What the factory records as the task passes each station: output of the product, so it is not
 * translated. One row per station of `landing.hero.stations`.
 */
const LOG = [
  { tag: 'intake', text: 'acme/shop#412 Rate-limit the export endpoint', meta: 'label tiller' },
  {
    tag: 'preflight',
    text: 'about 6 files, 2 concepts, no blocking questions',
    meta: 'within limits',
  },
  { tag: 'run 1', text: 'claude-sonnet-5-5, network: gateway only', meta: '$0.42 of $5.00' },
  { tag: 'verify', text: '138 passed, 0 removed, typecheck ok, lint ok', meta: 'offline' },
  { tag: 'draft pr', text: '#58 opened as a draft, verdict attached', meta: 'closes #412' },
  { tag: 'review', text: 'approved and merged by a maintainer', meta: 'human' },
] as const

const STATES = ['IMPORTED', 'QUEUED', 'RUNNING', 'RUNNING', 'PR_OPEN', 'COMPLETED'] as const

const STEP_MS = 2400
const END_MS = 4400

/** where station `i` sits on the track: the columns start after the padding `--p` */
const x = (i: number, n: number) => `calc(var(--p) + ${i} * (100% - 2 * var(--p)) / ${n})`

/**
 * The hero's figure: one task travelling the line, station by station, on a loop. It plays
 * while it is on screen, can be paused, and a station can be picked by hand. With reduced
 * motion it shows the finished line and does not move.
 */
export function PipelineScene({ title, stations }: { title: string; stations: Station[] }) {
  const t = useTranslations('ui.scene')
  const ref = useRef<HTMLElement>(null)
  const inView = useInView(ref, { amount: 0.25 })
  const reduced = useReducedMotion()
  const last = stations.length - 1
  const [step, setStep] = useState(0)
  const [playing, setPlaying] = useState(true)

  useEffect(() => {
    if (!reduced) return
    setPlaying(false)
    setStep(last)
  }, [reduced, last])

  useEffect(() => {
    if (!playing || !inView) return
    const id = setTimeout(
      () => setStep((s) => (s === last ? 0 : s + 1)),
      step === last ? END_MS : STEP_MS,
    )
    return () => clearTimeout(id)
  }, [playing, inView, step, last])

  const state = STATES[step] ?? 'IMPORTED'
  const current = stations[step]

  return (
    <figure
      ref={ref}
      className="scheme-dark overflow-hidden rounded-md border border-rule bg-sunk text-ink"
    >
      <figcaption className="flex h-12 items-center gap-3 border-b border-rule pr-2 pl-4 sm:pl-5">
        <span className="label min-w-0 truncate text-ink-3">{title}</span>
        <span className="ml-auto flex shrink-0 items-center gap-2 font-mono text-[0.6875rem] tracking-wide">
          <span className="text-ink-3">T-41</span>
          <span
            className={clsx(
              'rounded-xs border px-1.5 py-0.5 transition-colors duration-300',
              state === 'RUNNING'
                ? 'border-signal text-signal'
                : state === 'COMPLETED'
                  ? 'border-ok text-ok'
                  : 'border-rule-strong text-ink-2',
            )}
          >
            {state}
          </span>
        </span>
        <button
          type="button"
          onClick={() => setPlaying((p) => !p)}
          aria-label={playing ? t('pause') : t('play')}
          title={playing ? t('pause') : t('play')}
          className="inline-flex size-8 shrink-0 items-center justify-center rounded-sm text-ink-3 transition-colors hover:bg-raised hover:text-ink"
        >
          {playing ? <Pause size={14} /> : <Play size={14} />}
        </button>
      </figcaption>

      {/* the line */}
      <div className="relative [--p:1rem] sm:[--p:1.25rem]">
        <span
          aria-hidden="true"
          className="absolute top-[28px] right-[var(--p)] left-[var(--p)] h-px bg-rule-strong"
        />
        <span
          aria-hidden="true"
          className="absolute top-[28px] left-[var(--p)] h-px bg-signal transition-[width] duration-700 ease-out-quint"
          style={{ width: `calc(${step} * (100% - 2 * var(--p)) / ${stations.length})` }}
        />
        <span
          aria-hidden="true"
          className="absolute top-[22px] z-10 size-[13px] bg-signal transition-[left] duration-700 ease-out-quint"
          style={{ left: `calc(${x(step, stations.length)} - 2px)` }}
        />
        <ol
          className="relative grid px-[var(--p)] pt-6"
          style={{ gridTemplateColumns: `repeat(${stations.length}, minmax(0, 1fr))` }}
        >
          {stations.map((station, i) => (
            <li key={station.name}>
              <button
                type="button"
                onClick={() => {
                  setStep(i)
                  setPlaying(false)
                }}
                aria-current={i === step ? 'step' : undefined}
                aria-label={`${t('stage', { current: i + 1, total: stations.length })}: ${station.name}`}
                className="group block w-full pr-2 pb-5 text-left"
              >
                <span
                  aria-hidden="true"
                  className={clsx(
                    'block size-[9px] border transition-colors duration-300',
                    i < step ? 'border-signal bg-signal' : 'border-rule-strong bg-sunk',
                  )}
                />
                <span
                  className={clsx(
                    'label mt-4 block transition-colors duration-300',
                    i === step ? 'text-signal' : 'text-ink-3 group-hover:text-ink-2',
                  )}
                >
                  {String(i + 1).padStart(2, '0')}
                </span>
                <span
                  className={clsx(
                    'mt-1 hidden text-[0.9375rem] font-[600] tracking-[-0.01em] transition-colors duration-300 md:block',
                    i === step ? 'text-ink' : 'text-ink-3 group-hover:text-ink-2',
                  )}
                >
                  {station.name}
                </span>
                <span className="mt-0.5 hidden text-[0.8125rem] leading-snug text-ink-3 lg:block">
                  {station.who}
                </span>
              </button>
            </li>
          ))}
        </ol>
        {/* below `md` there is no room for six names: the current one is spelled out */}
        <p aria-hidden="true" className="-mt-1 px-[var(--p)] pb-4 text-[0.9375rem] md:hidden">
          <span className="font-[600]">{current?.name}</span>
          <span className="text-ink-3"> · {current?.who}</span>
        </p>
      </div>

      {/* what the factory wrote down so far */}
      <div className="border-t border-rule px-4 py-4 font-mono text-[0.75rem] leading-[1.8] sm:px-5 sm:text-[0.8125rem]">
        {LOG.map((row, i) => {
          const done = i < step || step === last
          const pending = i > step
          return (
            <div
              key={row.tag}
              className={clsx(
                'grid grid-cols-[1rem_4.75rem_minmax(0,1fr)] gap-x-2 transition-opacity duration-500 sm:grid-cols-[1rem_5.5rem_minmax(0,1fr)_auto] sm:gap-x-3',
                // what is still ahead stays on the page, faint: the figure keeps its height
                pending ? 'opacity-25' : 'opacity-100',
              )}
            >
              <span className={pending ? 'text-ink-3' : done ? 'text-ok' : 'text-signal'}>
                {pending ? '·' : done ? '✓' : '›'}
              </span>
              <span className="text-ink-3">{row.tag}</span>
              <span className={clsx('min-w-0', !done && !pending && 'caret')}>{row.text}</span>
              <span className="hidden text-right text-ink-3 sm:block">{row.meta}</span>
            </div>
          )
        })}
      </div>
    </figure>
  )
}
