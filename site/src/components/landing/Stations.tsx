'use client'

import clsx from 'clsx'
import { AnimatePresence, motion } from 'motion/react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { rich } from '@/lib/rich'

interface Step {
  title: string
  body: string
  note: string
}

/* --- the panels: what the dashboard shows of task T-41 at each station ------------------
   Product output and sample data, so not translated. One panel per step, in order. */

function State({
  children,
  tone = 'plain',
}: {
  children: ReactNode
  tone?: 'plain' | 'ok' | 'run'
}) {
  return (
    <span
      className={clsx(
        'rounded-xs border px-1.5 py-0.5 font-mono text-[0.6875rem] tracking-wide',
        tone === 'ok' && 'border-ok text-ok',
        tone === 'run' && 'border-signal text-signal-ink',
        tone === 'plain' && 'border-rule-strong text-ink-2',
      )}
    >
      {children}
    </span>
  )
}

function Row({ k, children, mark }: { k: string; children: ReactNode; mark?: 'ok' | 'no' }) {
  return (
    <div className="flex items-baseline gap-3 border-t border-rule py-2.5 text-[0.875rem] first:border-t-0">
      <span className="w-4 shrink-0 font-mono text-[0.8125rem]">
        {mark === 'ok' && <span className="text-ok">✓</span>}
        {mark === 'no' && <span className="text-bad">✕</span>}
      </span>
      <span className="min-w-0 flex-1 text-ink-2">{k}</span>
      <span className="text-right font-mono text-[0.8125rem] text-ink">{children}</span>
    </div>
  )
}

function Meter({
  label,
  value,
  max,
  text,
}: {
  label: string
  value: number
  max: number
  text: string
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between text-[0.875rem]">
        <span className="text-ink-2">{label}</span>
        <span className="font-mono text-[0.8125rem]">{text}</span>
      </div>
      <div className="mt-2 h-1.5 bg-sunk">
        <div className="h-full bg-ink" style={{ width: `${(value / max) * 100}%` }} />
      </div>
    </div>
  )
}

function Verdict({ children }: { children: ReactNode }) {
  return (
    <p className="mt-4 flex items-center gap-2.5 border border-ok px-3 py-2.5 font-mono text-[0.8125rem] text-ok">
      <span aria-hidden="true">✓</span>
      {children}
    </p>
  )
}

const PANELS: { head: string; state: ReactNode; body: ReactNode }[] = [
  {
    head: 'intake',
    state: <State>IMPORTED</State>,
    body: (
      <>
        <div className="rounded-sm border border-rule bg-bg p-4">
          <p className="font-mono text-[0.75rem] text-ink-3">acme/shop · issue #412</p>
          <p className="mt-2 font-[600] tracking-[-0.01em]">Rate-limit the export endpoint</p>
          <p className="mt-1.5 text-[0.875rem] leading-relaxed text-ink-2">
            Exports over 10 000 rows should answer 429 with a Retry-After header.
          </p>
          <span className="mt-3 inline-block rounded-xs bg-ink px-1.5 py-0.5 font-mono text-[0.6875rem] text-bg">
            tiller
          </span>
        </div>
        <p className="my-3 pl-4 font-mono text-[0.75rem] text-ink-3">
          ↓ imported once, by its label
        </p>
        <div className="flex items-center justify-between rounded-sm border border-rule bg-bg px-4 py-3">
          <span className="font-mono text-[0.875rem]">T-41</span>
          <span className="text-[0.8125rem] text-ink-3">waiting for a human to queue a run</span>
        </div>
      </>
    ),
  },
  {
    head: 'preflight',
    state: <State>QUEUED</State>,
    body: (
      <>
        <div className="space-y-5">
          <Meter label="Files the work touches" value={6} max={10} text="about 6 of 10" />
          <Meter label="Domain concepts" value={2} max={3} text="2 of 3" />
        </div>
        <div className="mt-5">
          <Row k="Blocking questions">none</Row>
          <Row k="Proposed split">not needed</Row>
        </div>
        <Verdict>within limits: the run starts</Verdict>
      </>
    ),
  },
  {
    head: 'run 1',
    state: <State tone="run">RUNNING</State>,
    body: (
      <>
        <p className="mb-1 font-mono text-[0.75rem] text-ink-3">
          agent container · network tiller-agents
        </p>
        <Row k="Model gateway" mark="ok">
          reachable
        </Row>
        <Row k="Internet" mark="no">
          no route
        </Row>
        <Row k="GitHub token, model key" mark="no">
          absent
        </Row>
        <div className="mt-4">
          <Meter
            label="Budget, counted by the gateway"
            value={0.42}
            max={5}
            text="$0.42 of $5.00"
          />
        </div>
        <p className="mt-5 border-l-2 border-signal pl-3 font-mono text-[0.8125rem] leading-relaxed">
          TILLER: DONE
          <span className="block text-ink-2">Added a limiter to the export route, with tests.</span>
        </p>
      </>
    ),
  },
  {
    head: 'verification',
    state: <State tone="run">RUNNING</State>,
    body: (
      <>
        <p className="mb-1 font-mono text-[0.75rem] text-ink-3">
          clean export · fresh container · network none
        </p>
        <Row k="Passing at the base commit">137</Row>
        <Row k="Passing now" mark="ok">
          138
        </Row>
        <Row k="Failed" mark="ok">
          0
        </Row>
        <Row k="Removed or skipped" mark="ok">
          0
        </Row>
        <Row k="Type check, lint" mark="ok">
          ok
        </Row>
        <Verdict>verified: the branch may be pushed</Verdict>
      </>
    ),
  },
  {
    head: 'pull request',
    state: <State>PR_OPEN</State>,
    body: (
      <>
        <div className="rounded-sm border border-rule bg-bg p-4">
          <p className="flex items-center gap-2 font-mono text-[0.75rem] text-ink-3">
            <span className="rounded-xs border border-rule-strong px-1.5 py-0.5 text-ink-2">
              Draft
            </span>
            acme/shop #58
          </p>
          <p className="mt-2.5 font-[600] tracking-[-0.01em]">Rate-limit the export endpoint</p>
          <p className="mt-1 font-mono text-[0.75rem] text-ink-3">tiller/41 → main · Closes #412</p>
        </div>
        <div className="mt-3">
          <Row k="Verification" mark="ok">
            138 tests, checks ok
          </Row>
          <Row k="Changed check files">none</Row>
          <Row k="Second reader">1 note</Row>
        </div>
      </>
    ),
  },
  {
    head: 'review',
    state: <State tone="ok">COMPLETED</State>,
    body: (
      <div className="space-y-3">
        <div className="rounded-sm border border-rule bg-bg p-4">
          <p className="font-mono text-[0.75rem] text-ink-3">maintainer, on the pull request</p>
          <p className="mt-2 font-mono text-[0.8125rem] leading-relaxed">
            <span className="text-signal-ink">/tiller</span> use the shared limiter in lib/limits
            instead of a new one
          </p>
          <p className="mt-2 text-[0.8125rem] text-ink-3">👀 picked up</p>
        </div>
        <div className="rounded-sm border border-rule bg-bg p-4">
          <p className="font-mono text-[0.75rem] text-ink-3">codetiller</p>
          <p className="mt-2 text-[0.875rem] leading-relaxed text-ink-2">
            Run 2 is verified and pushed to this pull request: 139 tests passed.
          </p>
        </div>
        <p className="pl-4 font-mono text-[0.75rem] text-ink-3">↓ merged by the maintainer</p>
      </div>
    ),
  },
]

function Panel({ index, total }: { index: number; total: number }) {
  const panel = PANELS[index]
  if (!panel) return null
  return (
    <div className="rounded-md border border-rule bg-raised">
      <div className="flex h-11 items-center gap-3 border-b border-rule px-4">
        <span className="label text-ink-3">
          <span className="text-signal-ink">{String(index + 1).padStart(2, '0')}</span>
          <span className="mx-1.5">/</span>
          {String(total).padStart(2, '0')}
        </span>
        <span className="label text-ink-2">{panel.head}</span>
        <span className="ml-auto flex items-center gap-2">
          <span className="font-mono text-[0.6875rem] text-ink-3">T-41</span>
          {panel.state}
        </span>
      </div>
      <div className="p-4 sm:p-5">{panel.body}</div>
    </div>
  )
}

/**
 * The stations of a task, told while scrolling. From `lg`: the steps scroll on the left and one
 * panel stays in view on the right, showing the step at the middle of the screen. Below `lg`
 * every step carries its own panel.
 */
export function Stations({ steps }: { steps: Step[] }) {
  const [active, setActive] = useState(0)
  const items = useRef<(HTMLLIElement | null)[]>([])

  useEffect(() => {
    // a step is current while it crosses the middle of the viewport
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries)
          if (entry.isIntersecting) setActive(Number((entry.target as HTMLElement).dataset.index))
      },
      { rootMargin: '-50% 0px -50% 0px' },
    )
    for (const el of items.current) if (el) observer.observe(el)
    return () => observer.disconnect()
  }, [])

  return (
    <div className="lg:grid lg:grid-cols-12 lg:gap-x-12">
      <ol className="lg:col-span-5">
        {steps.map((step, i) => (
          <li
            key={step.title}
            ref={(el) => {
              items.current[i] = el
            }}
            data-index={i}
            className={clsx(
              'border-t border-rule py-10 first:border-t-0 first:pt-0 last:pb-0 lg:flex lg:min-h-[58vh] lg:flex-col lg:justify-center lg:border-t-0 lg:py-0 lg:transition-opacity lg:duration-300',
              i !== active && 'lg:opacity-40',
            )}
          >
            <p className="label text-signal-ink">{String(i + 1).padStart(2, '0')}</p>
            <h3 className="heading mt-3 text-[1.5rem] sm:text-[1.75rem]">{step.title}</h3>
            <p className="mt-3 max-w-[46ch] leading-relaxed text-ink-2">{rich(step.body)}</p>
            <p className="mt-4 font-mono text-[0.75rem] leading-relaxed text-ink-3">
              {rich(step.note)}
            </p>
            <div className="mt-7 lg:hidden">
              <Panel index={i} total={steps.length} />
            </div>
          </li>
        ))}
      </ol>

      <div className="hidden lg:col-span-7 lg:block" aria-hidden="true">
        <div className="sticky top-[max(5.5rem,calc(50vh-14rem))]">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={active}
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ duration: 0.26, ease: [0.22, 1, 0.36, 1] }}
            >
              <Panel index={active} total={steps.length} />
            </motion.div>
          </AnimatePresence>
        </div>
      </div>
    </div>
  )
}
