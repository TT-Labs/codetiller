import { clsx } from 'clsx'
import type { ReactNode } from 'react'
import { useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { type CompareResult, useBenchmarks, useCompare } from '../api'
import { Badge, RateCell } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { Field, Select } from '../components/ui/form'
import { Check, Info } from '../components/ui/icons'
import { Card, PageHeader, Section, Stat, StatGrid } from '../components/ui/layout'
import { EmptyState, ErrorBox, Loading } from '../components/ui/states'
import { Table, Td, Th } from '../components/ui/Table'
import { Tabs } from '../components/ui/Tabs'
import { benchmarkLabel, duration, pct, pp, signedPct, usd } from '../format'
import { usePageTitle } from '../title'

const SPLITS = ['all', 'train', 'holdout'] as const
type SplitId = (typeof SPLITS)[number]

export function ComparePage() {
  usePageTitle('Compare')
  const [params, setParams] = useSearchParams()
  const a = params.get('a') ?? undefined
  const b = params.get('b') ?? undefined
  const split = (params.get('split') ?? 'all') as SplitId
  const benchmarks = useBenchmarks()
  const cmp = useCompare(a, b, split)
  const set = (k: string, v: string) => {
    const next = new URLSearchParams(params)
    next.set(k, v)
    setParams(next)
  }
  const dataset = benchmarks.data?.find((x) => x.id === a)?.dataset
  const options = (benchmarks.data ?? []).filter((x) => !dataset || x.dataset === dataset)

  return (
    <>
      <PageHeader
        title="Compare"
        description="Paired per task: every delta with a confidence interval and rerun noise."
      />
      <div className="space-y-8">
        <Card className="grid items-end gap-4 p-4 md:grid-cols-[1fr_1fr_auto]">
          {(['a', 'b'] as const).map((k) => (
            <Field key={k} label={k === 'a' ? 'Baseline (A)' : 'Candidate (B)'}>
              <Select value={params.get(k) ?? ''} onChange={(e) => set(k, e.target.value)}>
                <option value="">choose…</option>
                {(k === 'a' ? (benchmarks.data ?? []) : options).map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.dataset} · {benchmarkLabel(x)} ({x.model})
                  </option>
                ))}
              </Select>
            </Field>
          ))}
          <div className="flex flex-col gap-1.5">
            <span className="font-medium text-13 text-fg">Split</span>
            <Tabs
              variant="segmented"
              label="Split"
              tabs={SPLITS.map((s) => ({ id: s, label: s }))}
              value={split}
              onChange={(s) => set('split', s)}
            />
          </div>
        </Card>
        {!a || !b ? <EmptyState title="Pick two benchmarks on the same dataset." /> : null}
        {cmp.isLoading ? <Loading what="comparison" /> : null}
        {cmp.error ? <ErrorBox error={cmp.error} /> : null}
        {cmp.data ? <CompareResultView data={cmp.data} /> : null}
      </div>
    </>
  )
}

/** signed delta; colour is a second cue next to the sign, never the only one */
function Delta({ value, real, children }: { value: number; real: boolean; children: ReactNode }) {
  return (
    <span className={clsx(real ? (value > 0 ? 'text-success' : 'text-danger') : 'text-fg-subtle')}>
      {children}
    </span>
  )
}

/** the comparison as markdown for the PR of a skill / config change */
function CopyEvidence({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <Button
      className="ml-auto"
      title="Markdown with every delta, its CI and rerun noise: paste into the PR"
      onClick={() =>
        navigator.clipboard.writeText(text).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 2000)
        })
      }
    >
      {copied ? 'Copied' : 'Copy evidence'}
    </Button>
  )
}

function CompareResultView({ data }: { data: CompareResult }) {
  const { comparison: c, solvable, tasks } = data
  const promote = c.recommendation === 'PROMOTE'
  const significant = c.delta.lo > 0 || c.delta.hi < 0
  const withinNoise = c.noise !== null && Math.abs(c.delta.mean) <= c.noise
  // a metric delta counts when it holds across tasks and exceeds what a rerun moves
  const real = (m: (typeof c.metrics)[number]) =>
    (m.delta.lo > 0 || m.delta.hi < 0) && m.noise !== null && Math.abs(m.delta.mean) > m.noise
  const num = (x: number) =>
    Math.abs(x) >= 100 ? x.toFixed(0) : Math.abs(x) >= 10 ? x.toFixed(1) : x.toFixed(3)
  const signed = (x: number) => `${x >= 0 ? '+' : ''}${num(x)}`
  return (
    <>
      <div
        className={clsx(
          'flex items-start gap-3 rounded-lg border px-4 py-3',
          promote ? 'border-success-line bg-success-soft' : 'border-line bg-surface shadow-xs',
        )}
      >
        <span
          className={clsx(
            'mt-0.5 grid size-6 shrink-0 place-items-center rounded-full',
            promote ? 'bg-success text-surface' : 'bg-subtle text-fg-muted ring-1 ring-line',
          )}
        >
          {promote ? <Check className="size-3.5" /> : <Info className="size-3.5" />}
        </span>
        <div className="min-w-0">
          <p className={clsx('font-semibold text-sm', promote ? 'text-success' : 'text-fg')}>
            {promote
              ? `PROMOTE ${benchmarkLabel(data.b)}`
              : `KEEP ${benchmarkLabel(data.a)} — don't promote ${benchmarkLabel(data.b)}`}
          </p>
          <p className="mt-0.5 text-13 text-fg first-letter:uppercase">{c.reason}.</p>
          <p className="mt-1 text-fg-muted text-xs">
            Rule: promote if the success gain holds (across tasks and beyond rerun noise), or
            success is not lower and cost per success or duration per run drops ≥ 15% with that drop
            holding.
          </p>
        </div>
        <CopyEvidence text={data.evidence} />
      </div>
      <StatGrid className="lg:grid-cols-4">
        <Stat
          label="Success A → B"
          value={`${pct(c.a.successRate)} → ${pct(c.b.successRate)}`}
          hint={`${c.tasks} paired tasks`}
        />
        <Stat
          label="Δ success (95% CI)"
          value={
            // coloured only when it holds, like the per-run table: green on a delta inside noise
            // reads as a result
            <span
              className={
                significant && !withinNoise
                  ? c.delta.mean >= 0
                    ? 'text-success'
                    : 'text-danger'
                  : undefined
              }
            >
              {pp(c.delta.mean)}
            </span>
          }
          hint={`${pp(c.delta.lo)} … ${pp(c.delta.hi)}${significant ? '' : ' · not significant'}`}
        />
        <Stat
          label="Rerun noise"
          value={c.noise === null ? '—' : `±${(c.noise * 100).toFixed(1)} pp`}
          hint={
            c.noise === null
              ? 'no paired tasks'
              : withinNoise
                ? 'Δ is inside it: a rerun could give this'
                : 'Δ exceeds it'
          }
        />
        {solvable ? (
          <Stat
            label="Solvable from the issue"
            value={`${pct(solvable.a.successRate)} → ${pct(solvable.b.successRate)}`}
            hint={`${solvable.tasks} tasks · ${pp(solvable.delta.mean)} (${pp(solvable.delta.lo)} … ${pp(solvable.delta.hi)})`}
          />
        ) : null}
        <Stat
          label="Cost / success"
          value={`${usd(c.a.costPerSuccess, 3)} → ${usd(c.b.costPerSuccess, 3)}`}
          hint={signedPct(c.costPerSuccessDelta)}
        />
        <Stat
          label="Median duration"
          value={`${duration(c.a.medianDuration)} → ${duration(c.b.medianDuration)}`}
        />
        <Stat
          label="Tasks"
          value={
            <>
              <span className="text-success">{c.flips.failToSuccess} better</span>
              <span className="text-fg-subtle"> · </span>
              <span className="text-danger">{c.flips.successToFail} worse</span>
            </>
          }
        />
      </StatGrid>
      <Section
        title="Per run"
        hint="Δ is coloured and marked * only when it holds across tasks (CI excludes 0) and exceeds rerun noise."
      >
        <Table>
          <thead>
            <tr>
              <Th>Metric</Th>
              <Th num>A</Th>
              <Th num>B</Th>
              <Th num>Δ</Th>
              <Th num>95% CI over tasks</Th>
              <Th num>Rerun noise</Th>
            </tr>
          </thead>
          <tbody>
            {c.metrics.map((m) => (
              <tr key={m.name}>
                <Td className="font-mono text-fg text-xs leading-5">{m.name}</Td>
                <Td num>{num(m.a)}</Td>
                <Td num>{num(m.b)}</Td>
                <Td num className="font-medium">
                  <Delta value={m.delta.mean} real={real(m)}>
                    {signed(m.delta.mean)}
                    <span className="inline-block w-2 text-left">{real(m) ? '*' : ''}</span>
                  </Delta>
                </Td>
                <Td num className="text-fg-subtle">
                  {signed(m.delta.lo)} … {signed(m.delta.hi)}
                </Td>
                <Td num className="text-fg-subtle">
                  {m.noise === null ? '—' : `±${num(m.noise)}`}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Section>
      <Section title="Per task" count={tasks.length}>
        <Table>
          <thead>
            <tr>
              <Th>Task</Th>
              <Th>A · {benchmarkLabel(data.a)}</Th>
              <Th>B · {benchmarkLabel(data.b)}</Th>
              <Th num>Δ</Th>
            </tr>
          </thead>
          <tbody>
            {tasks.map((t) => {
              const d = t.b.successes / t.b.runs - t.a.successes / t.a.runs
              return (
                <tr key={t.task_id}>
                  <Td
                    className={clsx(
                      d > 0 && 'shadow-[inset_3px_0_var(--success)]',
                      d < 0 && 'shadow-[inset_3px_0_var(--danger)]',
                    )}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-fg text-xs">{t.task_id}</span>
                      {t.underspecified ? (
                        <Badge title={t.underspecified}>underspecified</Badge>
                      ) : null}
                    </div>
                  </Td>
                  {[t.a, t.b].map((cell, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: fixed A/B columns
                    <Td key={i}>
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <RateCell successes={cell.successes} runs={cell.runs} />
                        {cell.run_ids.map((id, n) => (
                          <Link
                            key={id}
                            to={`/runs/${id}`}
                            className="text-accent-text text-xs hover:underline"
                          >
                            run {n + 1}
                          </Link>
                        ))}
                      </div>
                    </Td>
                  ))}
                  <Td num className="font-medium">
                    <Delta value={d} real={d !== 0}>
                      {d === 0 ? '·' : pp(d)}
                    </Delta>
                  </Td>
                </tr>
              )
            })}
          </tbody>
        </Table>
      </Section>
    </>
  )
}
