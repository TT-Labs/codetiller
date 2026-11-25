'use client'

import clsx from 'clsx'
import { useInView } from 'motion/react'
import { useRef } from 'react'
import { rich } from '@/lib/rich'

/**
 * Probes of the agent container as `tiller audit` prints them: probe, what it observed, what
 * the factory wants (packages/core/src/sandbox/audit.ts). A selection, in the audit's order.
 */
const PROBES = [
  ['egress_https', '000', 'no route to the internet'],
  ['egress_ip', '000', 'no route to the internet by IP'],
  ['dns', 'none', 'no outside DNS (exfiltration channel)'],
  ['host_api', '000', 'cannot reach the factory API on the host'],
  ['model_api', '200', 'model API reachable (HTTP 200)'],
  ['model_key', 'absent', 'agent holds no model key'],
  ['gateway_proxy', '403', 'gateway refuses to proxy other hosts'],
  ['gateway_model', '403', 'gateway forwards only the model of the run'],
  ['gateway_admin', '403', 'an agent cannot open a run or raise a budget'],
  ['docker_socket', 'absent', 'absent'],
  ['secret_env', '', 'no token or secret in the environment'],
  ['uid', '1000', 'not root'],
] as const

/** The audit, probe by probe, the first time it scrolls into view. */
export function AuditTerminal({ caption }: { caption: string }) {
  const ref = useRef<HTMLElement>(null)
  const inView = useInView(ref, { once: true, amount: 0.3 })
  return (
    <figure ref={ref}>
      <div className="overflow-hidden rounded-md border border-rule bg-bg">
        <div className="flex h-10 items-center gap-2 border-b border-rule px-4 font-mono text-[0.75rem]">
          <span className="text-signal">$</span>
          <span className="text-ink">tiller audit</span>
        </div>
        <div className="px-4 py-4 font-mono text-[0.75rem] leading-[1.9]">
          <p className="text-ink-2">agent container</p>
          {PROBES.map(([probe, observed, want], i) => (
            <div
              key={probe}
              style={{ transitionDelay: `${200 + i * 120}ms` }}
              className={clsx(
                'grid grid-cols-[1.75rem_minmax(0,1fr)] gap-x-2 transition-opacity duration-300 sm:grid-cols-[2.25rem_8.5rem_4rem_minmax(0,1fr)]',
                inView ? 'opacity-100' : 'opacity-0',
              )}
            >
              <span className="text-ok">ok</span>
              <span className="text-ink">
                {probe}
                {/* below `sm` the probe and what the factory wants share a cell */}
                <span className="block text-ink-3 sm:hidden">{want}</span>
              </span>
              <span className="hidden text-ink-3 sm:block">{observed}</span>
              <span className="hidden text-ink-2 sm:block">{want}</span>
            </div>
          ))}
        </div>
      </div>
      <figcaption className="mt-3 text-[0.8125rem] text-ink-3">{rich(caption)}</figcaption>
    </figure>
  )
}
