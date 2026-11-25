'use client'

import clsx from 'clsx'
import { motion } from 'motion/react'

interface ChartCopy {
  caption: string
  title: string
  noise: string
  counts: string
  within: string
  rows: { metric: string; unit: string }[]
}

/**
 * Made-up numbers that show how a comparison is read: the difference of candidate and baseline
 * with its confidence interval, against the band of rerun noise. One entry per row of the copy.
 */
const DATA = [
  { delta: 9, lo: 3, hi: 15, noise: 4 },
  { delta: -18, lo: -27, hi: -9, noise: 6 },
  { delta: -3, lo: -10, hi: 4, noise: 7 },
] as const

const RANGE = 30
/** a value on the axis, as a share of the track's width */
const at = (v: number) => `${50 + (v / RANGE) * 50}%`
const signed = (v: number) => (v > 0 ? `+${v}` : `${v}`.replace('-', '−'))

/** Paired comparison, drawn when it scrolls into view. */
export function DeltaChart({ copy }: { copy: ChartCopy }) {
  return (
    <figure>
      <div className="rounded-md border border-rule bg-raised">
        <div className="flex h-11 items-center justify-between gap-3 border-b border-rule px-4 sm:px-5">
          <span className="label text-ink-3">{copy.title}</span>
          <span className="flex items-center gap-2 text-[0.75rem] text-ink-3">
            <span aria-hidden="true" className="h-3 w-5 bg-sunk ring-1 ring-rule" />
            {copy.noise}
          </span>
        </div>
        <ul>
          {copy.rows.map((row, i) => {
            const d = DATA[i]
            if (!d) return null
            // it counts when the interval excludes zero and the difference is larger than the noise
            const counts = (d.lo > 0 || d.hi < 0) && Math.abs(d.delta) > d.noise
            return (
              <li
                key={row.metric}
                className="border-t border-rule px-4 py-5 first:border-t-0 sm:px-5"
              >
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-[0.9375rem] font-[560]">{row.metric}</span>
                  <span className="flex items-baseline gap-2 font-mono text-[0.8125rem]">
                    <span className={counts ? 'text-ink' : 'text-ink-3'}>
                      {signed(d.delta)} {row.unit}
                      {counts && <span className="text-signal-ink"> *</span>}
                    </span>
                    <span
                      className={clsx(
                        'label rounded-xs border px-1.5 py-0.5',
                        counts ? 'border-ink text-ink' : 'border-rule-strong text-ink-3',
                      )}
                    >
                      {counts ? copy.counts : copy.within}
                    </span>
                  </span>
                </div>
                <div className="relative mt-4 h-7" aria-hidden="true">
                  {/* rerun noise around zero */}
                  <span
                    className="absolute inset-y-0 bg-sunk ring-1 ring-rule"
                    style={{ left: at(-d.noise), right: `calc(100% - ${at(d.noise)})` }}
                  />
                  <span className="absolute inset-x-0 top-1/2 h-px bg-rule" />
                  <span className="absolute inset-y-0 left-1/2 w-px bg-rule-strong" />
                  {/* the confidence interval grows out of the estimate */}
                  <motion.span
                    className={clsx(
                      'absolute top-1/2 h-[3px] -translate-y-1/2',
                      counts ? 'bg-ink' : 'bg-ink-3',
                    )}
                    style={{ left: at(d.lo), right: `calc(100% - ${at(d.hi)})` }}
                    initial={{ scaleX: 0 }}
                    whileInView={{ scaleX: 1 }}
                    viewport={{ once: true, amount: 1 }}
                    transition={{ duration: 0.7, delay: 0.25 + i * 0.15, ease: [0.22, 1, 0.36, 1] }}
                  />
                  <motion.span
                    className={clsx(
                      'absolute top-1/2 size-[11px] -translate-x-1/2 -translate-y-1/2',
                      counts ? 'bg-signal' : 'bg-ink-3',
                    )}
                    initial={{ left: '50%' }}
                    whileInView={{ left: at(d.delta) }}
                    viewport={{ once: true, amount: 1 }}
                    transition={{ duration: 0.8, delay: 0.1 + i * 0.15, ease: [0.22, 1, 0.36, 1] }}
                  />
                </div>
              </li>
            )
          })}
        </ul>
        <div className="flex justify-between border-t border-rule px-4 py-2 font-mono text-[0.6875rem] text-ink-3 sm:px-5">
          <span>−{RANGE}</span>
          <span>0</span>
          <span>+{RANGE}</span>
        </div>
      </div>
      <figcaption className="mt-3 text-[0.8125rem] text-ink-3">{copy.caption}</figcaption>
    </figure>
  )
}
