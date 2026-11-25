import { clsx } from 'clsx'
import { Link, useParams } from 'react-router'
import { type Run, useBenchmark } from '../api'
import { badgeClass, outcomeTone } from '../components/ui/Badge'
import { MetaList, PageHeader, Section, Stat, StatGrid } from '../components/ui/layout'
import { ErrorBox, Loading } from '../components/ui/states'
import { Table, Td, Th } from '../components/ui/Table'
import { benchmarkLabel, duration, pct, usd } from '../format'
import { usePageTitle } from '../title'

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length ? (s[Math.floor(s.length / 2)] ?? null) : null
}

export function BenchmarkPage() {
  const { id = '' } = useParams()
  const { data, error, isLoading } = useBenchmark(id)
  usePageTitle(data ? benchmarkLabel(data.benchmark) : id)
  if (isLoading) return <Loading what="benchmark" />
  if (error || !data) return <ErrorBox error={error ?? 'not found'} />
  const { benchmark: b, runs } = data
  const byTask = Map.groupBy(runs, (r: Run) => r.task_id)
  const timeouts = runs.filter((r) => r.agent_exit === 'timeout').length

  return (
    <>
      <PageHeader
        crumbs={[{ label: 'Evals', to: '/evals' }, { label: b.dataset }]}
        title={benchmarkLabel(b)}
        meta={
          <MetaList
            items={[
              { label: 'Config', value: b.config_name, mono: true },
              { label: 'Harness', value: b.harness, mono: true },
              { label: 'Model', value: b.model, mono: true },
              { label: 'Skills', value: b.skills.length ? b.skills.join(', ') : '—', mono: true },
              { label: 'Repeats', value: `${b.repeats}× per task` },
            ]}
          />
        }
      />
      <div className="space-y-8">
        <StatGrid>
          <Stat
            label="Success"
            value={b.runs ? pct(b.successes / b.runs) : '—'}
            hint={`${b.successes}/${b.runs} runs`}
          />
          <Stat
            label="Cost"
            value={usd(b.cost_usd)}
            hint={`${usd(b.runs ? b.cost_usd / b.runs : null)} / run`}
          />
          <Stat label="Cost / success" value={b.successes ? usd(b.cost_usd / b.successes) : '—'} />
          <Stat
            label="Median duration"
            value={duration(median(runs.map((r) => r.duration_s ?? 0)))}
            hint={timeouts ? `${timeouts} timeouts` : undefined}
          />
        </StatGrid>
        <Section title="Tasks" count={byTask.size}>
          <Table>
            <thead>
              <tr>
                <Th>Task</Th>
                <Th>Runs</Th>
                <Th num>Cost</Th>
                <Th num>Duration</Th>
              </tr>
            </thead>
            <tbody>
              {[...byTask].map(([task, rs]) => (
                <tr key={task}>
                  <Td className="whitespace-nowrap font-mono text-fg text-xs leading-5">{task}</Td>
                  <Td>
                    <div className="flex flex-wrap gap-1.5">
                      {rs.map((r) => (
                        <Link
                          key={r.id}
                          to={`/runs/${r.id}`}
                          className={clsx(
                            badgeClass(outcomeTone(r.outcome)),
                            'transition-shadow hover:ring-current/40',
                          )}
                          title={`#${r.repeat} ${r.outcome}`}
                        >
                          <span className="font-mono">#{r.repeat}</span> {r.outcome}
                        </Link>
                      ))}
                    </div>
                  </Td>
                  <Td num>{usd(rs.reduce((s, r) => s + (r.cost_usd ?? 0), 0))}</Td>
                  <Td num className="text-fg-muted">
                    {rs.map((r) => duration(r.duration_s)).join(' · ')}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Section>
      </div>
    </>
  )
}
