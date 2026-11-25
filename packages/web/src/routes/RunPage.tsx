import { clsx } from 'clsx'
import { useParams } from 'react-router'
import { type RunFile, useRun, useRunFile, useTranscript } from '../api'
import { Diff } from '../components/Diff'
import { Markdown } from '../components/Markdown'
import { Transcript } from '../components/Transcript'
import { Outcome } from '../components/ui/Badge'
import { Check, Cross } from '../components/ui/icons'
import {
  type Crumb,
  ExternalA,
  MetaList,
  PageHeader,
  Stat,
  StatGrid,
} from '../components/ui/layout'
import { CodeBlock, ErrorBox, Loading } from '../components/ui/states'
import { Tabs } from '../components/ui/Tabs'
import { duration, stripAnsi, usd } from '../format'
import { usePageTitle } from '../title'
import { useTabParam } from '../useTabParam'

const TABS = ['conversation', 'diff', 'tests', 'issue', 'prompt', 'context', 'stderr'] as const
type TabId = (typeof TABS)[number]

function FileView({ runId, file, as }: { runId: string; file: RunFile; as: 'diff' | 'text' }) {
  const { data, error, isLoading } = useRunFile(runId, file)
  if (isLoading) return <Loading what={file} />
  if (error || !data) return <ErrorBox error={error ?? 'missing'} />
  return as === 'diff' ? (
    <Diff text={data.text} />
  ) : (
    <CodeBlock className="max-h-[75vh]">{stripAnsi(data.text)}</CodeBlock>
  )
}

function ConversationView({ runId }: { runId: string }) {
  const { data, error, isLoading } = useTranscript(runId)
  if (isLoading) return <Loading what="conversation" />
  if (error || !data) return <ErrorBox error={error ?? 'missing'} />
  return <Transcript events={data.events} />
}

export function RunPage() {
  const { id = '' } = useParams()
  const { data, error, isLoading } = useRun(id)
  usePageTitle(data?.task ? `${data.run.task_id} ${data.task.title}` : id)
  const [tab, setTab] = useTabParam<TabId>(TABS, 'conversation')
  if (isLoading) return <Loading what="run" />
  if (error || !data) return <ErrorBox error={error ?? 'not found'} />
  const { run, checks, config, task, files } = data
  const has = (f: RunFile) => files.includes(f)
  const crumbs: Crumb[] = run.benchmark_id
    ? [
        { label: 'Evals', to: '/evals' },
        { label: run.benchmark_id, to: `/benchmarks/${run.benchmark_id}` },
      ]
    : [{ label: 'run' }]

  return (
    <>
      <PageHeader
        crumbs={[...crumbs, { label: `${run.task_id} #${run.repeat}` }]}
        title={task?.title ?? run.task_id}
        badge={<Outcome value={run.outcome} />}
        meta={
          <MetaList
            items={
              config
                ? [
                    { label: 'Config', value: config.name, mono: true },
                    { label: 'Harness', value: config.harness, mono: true },
                    { label: 'Model', value: config.model, mono: true },
                    config.skills.length > 0 && {
                      label: 'Skills',
                      value: config.skills.join(', '),
                      mono: true,
                    },
                    task?.url && { value: <ExternalA href={task.url}>Issue</ExternalA> },
                  ]
                : [
                    { label: 'Config', value: run.config_id, mono: true },
                    task?.url && { value: <ExternalA href={task.url}>Issue</ExternalA> },
                  ]
            }
          />
        }
      />
      <div className="space-y-6">
        <StatGrid>
          <Stat label="Cost" value={usd(run.cost_usd, 3)} hint={run.cost_source ?? undefined} />
          <Stat label="Turns" value={run.turns ?? '—'} />
          <Stat
            label="Duration"
            value={duration(run.duration_s)}
            hint={`agent exit: ${run.agent_exit ?? '—'}`}
          />
          <Stat
            label="Diff"
            value={`${run.diff_files ?? 0} files`}
            hint={`${run.diff_lines ?? 0} lines`}
          />
          {checks.map((c) => (
            <Stat
              key={c.name}
              label={c.name.replaceAll('_', ' ')}
              value={
                <span
                  className={clsx(
                    'inline-flex items-center gap-1.5',
                    c.passed ? 'text-success' : 'text-danger',
                  )}
                >
                  {c.passed ? <Check className="size-4" /> : <Cross className="size-4" />}
                  {c.passed ? 'pass' : 'fail'}
                </span>
              }
              hint={
                c.total !== null
                  ? `${(c.total ?? 0) - (c.failed ?? 0)}/${c.total} passed`
                  : undefined
              }
            />
          ))}
        </StatGrid>
        <div className="space-y-4">
          <Tabs<TabId>
            label="Run views"
            value={tab}
            onChange={setTab}
            tabs={[
              { id: 'conversation', label: 'Conversation' },
              { id: 'diff', label: 'Diff', hidden: !has('diff') },
              { id: 'tests', label: 'Hidden tests', hidden: !has('tests') },
              { id: 'issue', label: 'Issue', hidden: !task },
              { id: 'prompt', label: 'Prompt', hidden: !has('prompt') },
              { id: 'context', label: 'Context', hidden: !has('context') },
              { id: 'stderr', label: 'stderr', hidden: !has('stderr') },
            ]}
          />
          <div>
            {tab === 'conversation' ? <ConversationView runId={id} /> : null}
            {tab === 'diff' ? <FileView runId={id} file="diff" as="diff" /> : null}
            {tab === 'tests' ? (
              <div className="space-y-3">
                {task ? (
                  <MetaList
                    items={[
                      { label: 'fail_to_pass', value: task.fail_to_pass.length },
                      { label: 'files', value: task.hidden_tests.join(', '), mono: true },
                    ]}
                  />
                ) : null}
                <FileView runId={id} file="tests" as="text" />
              </div>
            ) : null}
            {tab === 'issue' && task ? (
              <div className="max-w-[80ch] rounded-lg border border-line bg-surface px-5 py-4 shadow-xs">
                <Markdown>{task.body}</Markdown>
              </div>
            ) : null}
            {tab === 'prompt' ? <FileView runId={id} file="prompt" as="text" /> : null}
            {tab === 'context' ? <FileView runId={id} file="context" as="text" /> : null}
            {tab === 'stderr' ? <FileView runId={id} file="stderr" as="text" /> : null}
          </div>
        </div>
      </div>
    </>
  )
}
