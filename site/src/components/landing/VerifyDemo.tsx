'use client'

import clsx from 'clsx'
import { motion, type Variants } from 'motion/react'

/** A change that gets its green run by skipping the test: sample data in the product's words. */
const DIFF = [
  { sign: ' ', text: "describe('export', () => {" },
  { sign: '-', text: "  it('rejects a request over the limit', async () => {" },
  { sign: '-', text: '    const res = await exportRows({ rows: LIMIT + 1 })' },
  { sign: '-', text: '    expect(res.status).toBe(429)' },
  { sign: '-', text: '  })' },
  { sign: '+', text: "  it.skip('rejects a request over the limit', () => {})" },
  { sign: ' ', text: '})' },
] as const

const container: Variants = {
  hidden: {},
  shown: { transition: { staggerChildren: 0.09, delayChildren: 0.1 } },
}
const line: Variants = {
  hidden: { opacity: 0, x: -8 },
  shown: { opacity: 1, x: 0, transition: { duration: 0.35, ease: [0.22, 1, 0.36, 1] } },
}
const verdict: Variants = {
  hidden: { opacity: 0, y: 16 },
  shown: { opacity: 1, y: 0, transition: { duration: 0.5, delay: 0.95, ease: [0.22, 1, 0.36, 1] } },
}
// the stamp lands a moment after the verdict is there
const stamp: Variants = {
  hidden: { opacity: 0, scale: 1.6, rotate: -8 },
  shown: {
    opacity: 1,
    scale: 1,
    rotate: -4,
    transition: { delay: 1.35, type: 'spring', stiffness: 420, damping: 22 },
  },
}

/** The diff of the change, then what the factory says about it. */
export function VerifyDemo({
  diffCaption,
  verdictCaption,
}: {
  diffCaption: string
  verdictCaption: string
}) {
  return (
    <motion.div
      data-reveal
      variants={container}
      initial="hidden"
      whileInView="shown"
      viewport={{ once: true, amount: 0.35 }}
    >
      <figure className="overflow-hidden rounded-md border border-rule bg-raised">
        <figcaption className="flex h-10 items-center gap-3 border-b border-rule px-4">
          <span className="label shrink-0 text-ink-3">{diffCaption}</span>
          <span className="ml-auto min-w-0 truncate font-mono text-[0.75rem] text-ink-3">
            src/export/export.test.ts
          </span>
        </figcaption>
        <div className="overflow-x-auto py-3 font-mono text-[0.75rem] leading-[1.75] sm:text-[0.8125rem]">
          <div className="w-max min-w-full">
            {DIFF.map((row) => (
              <motion.div
                key={row.text}
                variants={line}
                className={clsx(
                  'flex gap-3 px-4',
                  row.sign === '-' && 'bg-del',
                  row.sign === '+' && 'bg-add',
                )}
              >
                <span
                  aria-hidden="true"
                  className={clsx(
                    'w-2 shrink-0 select-none',
                    row.sign === '-' ? 'text-bad' : row.sign === '+' ? 'text-ok' : 'text-ink-3',
                  )}
                >
                  {row.sign}
                </span>
                <span className="whitespace-pre text-ink">{row.text}</span>
              </motion.div>
            ))}
          </div>
        </div>
      </figure>

      <motion.figure
        variants={verdict}
        className="relative mt-4 rounded-md border border-bad bg-raised"
      >
        <figcaption className="flex h-10 items-center border-b border-rule px-4">
          <span className="label text-ink-3">{verdictCaption}</span>
        </figcaption>
        <dl className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 px-4 py-4 font-mono text-[0.75rem] leading-relaxed sm:text-[0.8125rem]">
          <dt className="text-ink-3">tests</dt>
          <dd>137 passed, 0 failed</dd>
          <dt className="text-ink-3">removed</dt>
          <dd className="text-bad">
            1 test that passed at the base commit no longer runs
            <span className="mt-1 block text-ink-2">
              export.test.ts › export › rejects a request over the limit
            </span>
          </dd>
          <dt className="text-ink-3">pushed</dt>
          <dd>nothing</dd>
          <dt className="text-ink-3">next</dt>
          <dd>back to the agent, with what failed</dd>
        </dl>
        <motion.span
          variants={stamp}
          aria-hidden="true"
          className="absolute top-2 right-3 border-2 border-bad px-2 py-0.5 font-mono text-[0.75rem] font-[700] tracking-[0.14em] text-bad"
        >
          FAILED
        </motion.span>
      </motion.figure>
    </motion.div>
  )
}
