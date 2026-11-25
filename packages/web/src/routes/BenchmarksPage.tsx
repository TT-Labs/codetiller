import { clsx } from 'clsx'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { type Benchmark, useBenchmarks } from '../api'
import { Button } from '../components/ui/Button'
import { PageHeader, Section } from '../components/ui/layout'
import { Code, EmptyState, ErrorBox, Loading } from '../components/ui/states'
import { Table, Td, Th } from '../components/ui/Table'
import { benchmarkLabel, date, pct, usd } from '../format'
import { usePageTitle } from '../title'

export function BenchmarksPage() {
  usePageTitle('Evals')
  const { data, error, isLoading } = useBenchmarks()
  const [picked, setPicked] = useState<string[]>([])
  const navigate = useNavigate()
  if (isLoading) return <Loading what="benchmarks" />
  if (error) return <ErrorBox error={error} />
  const list = data ?? []
  const byDataset = Map.groupBy(list, (b) => b.dataset)
  const pickedDataset = list.find((b) => b.id === picked[0])?.dataset

  const toggle = (b: Benchmark) =>
    setPicked((p) => (p.includes(b.id) ? p.filter((x) => x !== b.id) : [...p, b.id].slice(-2)))

  return (
    <>
      <PageHeader
        title="Benchmarks"
        description="Eval runs per dataset. Select two on the same dataset to compare them."
        actions={
          <Button
            variant="primary"
            disabled={picked.length !== 2}
            onClick={() => navigate(`/compare?a=${picked[0]}&b=${picked[1]}`)}
          >
            Compare <span className="tabular-nums opacity-80">{picked.length}/2</span>
          </Button>
        }
      />
      <div className="space-y-8">
        {list.length === 0 ? (
          <EmptyState title="No benchmarks yet">
            Run <Code>tiller benchmark --dataset … --config …</Code>.
          </EmptyState>
        ) : null}
        {[...byDataset].map(([dataset, rows]) => (
          <Section key={dataset} title={dataset} count={rows.length}>
            <Table minWidth="min-w-[60rem]" className="table-fixed">
              <colgroup>
                <col className="w-10" />
                <col />
                <col className="w-44" />
                <col className="w-60" />
                <col className="w-20" />
                <col className="w-16" />
                <col className="w-20" />
                <col className="w-28" />
                <col className="w-48" />
              </colgroup>
              <thead>
                <tr>
                  <Th aria-label="select" />
                  <Th>Benchmark</Th>
                  <Th>Model</Th>
                  <Th>Skills</Th>
                  <Th num>Success</Th>
                  <Th num>Runs</Th>
                  <Th num>Cost</Th>
                  <Th num>Cost / success</Th>
                  <Th>Started</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((b) => {
                  const on = picked.includes(b.id)
                  return (
                    <tr key={b.id} className={clsx(on && 'bg-accent-soft hover:bg-accent-soft!')}>
                      <Td className="pr-0">
                        <input
                          type="checkbox"
                          className="mt-0.5 size-4"
                          aria-label={`select ${benchmarkLabel(b)}`}
                          checked={on}
                          disabled={!!pickedDataset && pickedDataset !== b.dataset && !on}
                          onChange={() => toggle(b)}
                        />
                      </Td>
                      <Td>
                        <Link
                          to={`/benchmarks/${b.id}`}
                          className="font-medium text-fg hover:text-accent-text hover:underline"
                        >
                          {benchmarkLabel(b)}
                        </Link>
                        <div className="mt-0.5 font-mono text-fg-subtle text-xs">
                          {b.config_name}
                        </div>
                      </Td>
                      <Td className="font-mono text-fg-muted text-xs leading-5">{b.model}</Td>
                      <Td className="text-fg-muted">
                        {b.skills.length ? b.skills.join(', ') : '—'}
                      </Td>
                      <Td num className="font-semibold text-fg">
                        {b.runs ? pct(b.successes / b.runs) : '—'}
                      </Td>
                      <Td num className="text-fg-muted">
                        {b.successes}/{b.runs}
                      </Td>
                      <Td num>{usd(b.cost_usd)}</Td>
                      <Td num>{b.successes ? usd(b.cost_usd / b.successes) : '—'}</Td>
                      <Td className="whitespace-nowrap text-fg-muted">{date(b.started_at)}</Td>
                    </tr>
                  )
                })}
              </tbody>
            </Table>
          </Section>
        ))}
      </div>
    </>
  )
}
