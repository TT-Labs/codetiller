import { type FactoryMetrics, useMetrics } from '../api'
import { PageHeader, Section, Stat, StatGrid } from '../components/ui/layout'
import { EmptyState, ErrorBox, Loading } from '../components/ui/states'
import { Table, Td, Th } from '../components/ui/Table'
import { duration, usd } from '../format'
import { usePageTitle } from '../title'

type Group = FactoryMetrics['total']

const pct = (x: number | null) => (x === null ? '—' : `${Math.round(x * 100)}%`)
const per = (x: number | null) => (x === null ? '—' : x.toFixed(2))

// keyed by string: a verdict added on the server still gets a row
const PREFLIGHT: Record<string, string> = {
  pass: 'passed',
  too_large: 'too large',
  unclear: 'needs answers',
  error: 'failed',
  skipped: 'skipped by human',
}

function Groups({
  title,
  hint,
  rows,
}: {
  title: string
  hint: string
  rows: (Group & { key: string })[]
}) {
  return (
    <Section title={title} hint={hint}>
      <Table>
        <thead>
          <tr>
            <Th>{title.replace(/^By /, '')}</Th>
            <Th num>Tasks</Th>
            <Th num>Agent ran</Th>
            <Th num>Delivered</Th>
            <Th num>First pass</Th>
            <Th num>Interventions / task</Th>
            <Th num>Cost / delivered</Th>
            <Th num>Cost</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((g) => (
            <tr key={g.key}>
              <Td className="font-mono text-fg text-xs leading-5">{g.key}</Td>
              <Td num>{g.tasks}</Td>
              <Td num>{g.ran}</Td>
              <Td num>{g.delivered}</Td>
              <Td num>{pct(g.firstPassRate)}</Td>
              <Td num>{per(g.interventionsPerTask)}</Td>
              <Td num>{usd(g.costPerDelivered)}</Td>
              <Td num>{usd(g.cost_usd)}</Td>
            </tr>
          ))}
        </tbody>
      </Table>
    </Section>
  )
}

function Counts({ title, hint, rows }: { title: string; hint: string; rows: [string, number][] }) {
  return (
    <Section title={title} hint={hint}>
      <Table minWidth="min-w-0">
        <tbody>
          {rows.map(([label, n]) => (
            <tr key={label}>
              <Td>{label}</Td>
              <Td num className="w-24 font-medium text-fg">
                {n}
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>
    </Section>
  )
}

/** What the factory delivers, how often a human has to step in, and what it costs. */
export function MetricsPage() {
  usePageTitle('Metrics')
  const { data: m, error, isLoading } = useMetrics()
  if (isLoading) return <Loading what="metrics" />
  if (error || !m) return <ErrorBox error={error ?? 'missing'} />
  const t = m.total
  const created = m.funnel[0]?.tasks ?? 0
  return (
    <>
      <PageHeader
        title="Metrics"
        description={`What the factory delivers, how often you have to step in, and what it costs. All tasks so far${m.experiments ? `, without the ${m.experiments} marked as experiments` : ''}.`}
      />
      {t.tasks === 0 ? (
        <EmptyState title="No tasks yet">Metrics appear once tasks have run.</EmptyState>
      ) : (
        <div className="space-y-8">
          <StatGrid>
            <Stat
              label="Delivered"
              value={`${t.delivered} of ${t.ran}`}
              hint="tasks the agent ran that reached you verified"
            />
            <Stat
              label="First pass"
              value={pct(t.firstPassRate)}
              hint={`${t.firstPass} of ${t.delivered} delivered by one run, no intervention`}
            />
            <Stat
              label="Interventions / task"
              value={per(t.interventionsPerTask)}
              hint={`${t.interventions} answers and review requests over ${t.ran} tasks`}
            />
            <Stat
              label="Cost / delivered task"
              value={usd(t.costPerDelivered)}
              hint={`${usd(t.cost_usd)} total, undelivered work included`}
            />
            <Stat
              label="Accepted"
              value={t.accepted}
              hint={
                t.accepted
                  ? `${usd(t.costPerAccepted)} per accepted task`
                  : 'no pull request merged yet'
              }
            />
            <Stat label="Agent time" value={duration(t.agent_s)} hint={`${t.runs} runs`} />
          </StatGrid>
          <div className="grid gap-8 lg:grid-cols-2">
            <Section title="Funnel" hint="tasks that reached each stage">
              <Table minWidth="min-w-0">
                <thead>
                  <tr>
                    <Th>Stage</Th>
                    <Th num>Tasks</Th>
                    <Th num>Of created</Th>
                  </tr>
                </thead>
                <tbody>
                  {m.funnel.map((f) => (
                    <tr key={f.stage}>
                      <Td>{f.stage}</Td>
                      <Td num className="font-medium text-fg">
                        {f.tasks}
                      </Td>
                      <Td num className="text-fg-muted">
                        {pct(created ? f.tasks / created : null)}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </Section>
            <div className="space-y-8">
              <Counts
                title="Review of pull requests"
                hint={
                  m.review.asIsRate === null
                    ? 'no pull request decided yet'
                    : `${pct(m.review.asIsRate)} of decided PRs merged as delivered`
                }
                rows={[
                  ['merged as delivered', m.review.acceptedAsIs],
                  ['merged after requested changes', m.review.acceptedAfterChanges],
                  ['closed without merge', m.review.rejected],
                  ['waiting for review', m.review.pending],
                ]}
              />
              <Counts
                title="Preflight"
                hint="verdicts before the first run"
                rows={Object.entries(m.preflight).map(([k, n]) => [PREFLIGHT[k] ?? k, n])}
              />
              <Counts
                title="Verification"
                hint="every verdict on an agent's commit"
                rows={[
                  ['passed', m.verification.pass],
                  ['failed', m.verification.fail],
                  ['no report', m.verification.error],
                ]}
              />
            </div>
          </div>
          <Groups title="By repository" hint="" rows={m.byRepo} />
          <Groups
            title="By config"
            hint="harness, skills and limits a task ran with"
            rows={m.byConfig}
          />
          <Groups
            title="By model"
            hint="tasks that ran, under the model of their last run"
            rows={m.byModel ?? []}
          />
        </div>
      )}
    </>
  )
}
