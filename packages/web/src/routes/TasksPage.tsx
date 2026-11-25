import { type FormEvent, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import {
  LIVE_STATES,
  NEEDS_YOU,
  type TaskState,
  type TaskSummary,
  useCreateTask,
  useImportIssues,
  useTaskOptions,
  useTasks,
} from '../api'
import { TaskStateBadge } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { Field, Input, Select, Textarea } from '../components/ui/form'
import { Download, Plus } from '../components/ui/icons'
import { Card, PageHeader, Section } from '../components/ui/layout'
import { Code, EmptyState, ErrorBox, Loading, Notice } from '../components/ui/states'
import { Table, Td, Th } from '../components/ui/Table'
import { date, usd } from '../format'
import { usePageTitle } from '../title'

const GROUPS: { title: string; hint: string; states: readonly TaskState[] }[] = [
  { title: 'Needs you', hint: 'questions, reviews, failed runs', states: NEEDS_YOU },
  { title: 'Working', hint: 'queued or running', states: LIVE_STATES },
  { title: 'Not started', hint: 'enqueue to run the agent', states: ['IMPORTED'] },
  { title: 'Closed', hint: '', states: ['COMPLETED', 'CANCELLED'] },
]
const GROUPED = new Set<string>(GROUPS.flatMap((g) => g.states))

export function TasksPage() {
  usePageTitle('Tasks')
  const { data, error, isLoading } = useTasks()
  const [creating, setCreating] = useState(false)
  const options = useTaskOptions()
  const importIssues = useImportIssues()
  const projects = options.data?.projects ?? []
  const items = data?.items ?? []
  // states the UI does not know yet still show up
  const groups = [
    ...GROUPS.map((g) => ({ ...g, items: items.filter((i) => g.states.includes(i.state)) })),
    { title: 'Other', hint: '', items: items.filter((i) => !GROUPED.has(i.state)) },
  ]
  return (
    <>
      <PageHeader
        title="Tasks"
        description="Agent work items. Nothing runs until you enqueue it; answer questions and review here."
        actions={
          <>
            {options.data?.canImport ? (
              <Button
                onClick={() => importIssues.mutate()}
                disabled={importIssues.isPending}
                title={projects.map((p) => `${p.repo} · label "${p.label}"`).join('\n')}
              >
                <Download className="size-3.5" />
                {importIssues.isPending ? 'Importing…' : 'Import issues'}
              </Button>
            ) : null}
            <Button
              variant={creating ? 'secondary' : 'primary'}
              aria-expanded={creating}
              onClick={() => setCreating(!creating)}
            >
              {creating ? null : <Plus className="size-3.5" />}
              {creating ? 'Close' : 'New task'}
            </Button>
          </>
        }
      />
      <div className="space-y-8">
        {importIssues.error || importIssues.data ? (
          <div className="space-y-2">
            {importIssues.error ? <ErrorBox error={importIssues.error} /> : null}
            {importIssues.data ? (
              <Notice>
                {importIssues.data.imported.length
                  ? `Imported ${importIssues.data.imported.join(', ')}.`
                  : 'No new labelled issues.'}
              </Notice>
            ) : null}
            {importIssues.data?.errors.length ? (
              <ErrorBox error={importIssues.data.errors.join('\n')} />
            ) : null}
          </div>
        ) : null}
        {creating ? <NewTaskForm /> : null}
        {isLoading ? <Loading what="tasks" /> : null}
        {error ? <ErrorBox error={error} /> : null}
        {data && data.items.length === 0 && !creating ? (
          <EmptyState title="No tasks yet">
            Create one, or use <Code>tiller task create</Code>.
          </EmptyState>
        ) : null}
        {groups.map((g) =>
          g.items.length ? (
            <Section key={g.title} title={g.title} count={g.items.length} hint={g.hint}>
              <TaskTable items={g.items} />
            </Section>
          ) : null,
        )}
      </div>
    </>
  )
}

function TaskTable({ items }: { items: TaskSummary[] }) {
  return (
    <Table minWidth="min-w-[60rem]" className="table-fixed">
      <colgroup>
        <col />
        <col className="w-36" />
        <col className="w-52" />
        <col className="w-16" />
        <col className="w-20" />
        <col className="w-44" />
      </colgroup>
      <thead>
        <tr>
          <Th>Task</Th>
          <Th>State</Th>
          <Th>Repo</Th>
          <Th num>Runs</Th>
          <Th num>Cost</Th>
          <Th>Updated</Th>
        </tr>
      </thead>
      <tbody>
        {items.map((t) => (
          <tr key={t.id}>
            <Td>
              <Link to={`/tasks/${t.id}`} className="group flex items-baseline gap-2.5">
                <span className="shrink-0 font-mono text-fg-subtle text-xs">{t.id}</span>
                <span className="font-medium text-fg group-hover:text-accent-text group-hover:underline">
                  {t.title}
                </span>
                {t.experiment ? (
                  <span className="shrink-0 text-fg-subtle text-xs">experiment</span>
                ) : null}
              </Link>
            </Td>
            <Td>
              <TaskStateBadge state={t.state} />
            </Td>
            <Td className="truncate font-mono text-fg-muted text-xs leading-5" title={t.repo}>
              {t.repo}
            </Td>
            <Td num>{t.runs}</Td>
            <Td num>{usd(t.cost_usd)}</Td>
            <Td className="whitespace-nowrap text-fg-muted">{date(t.updated_at)}</Td>
          </tr>
        ))}
      </tbody>
    </Table>
  )
}

function NewTaskForm() {
  const options = useTaskOptions()
  const create = useCreateTask()
  const navigate = useNavigate()
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const f = new FormData(e.currentTarget)
    const s = (k: string) => String(f.get(k) ?? '').trim()
    create.mutate(
      {
        title: s('title'),
        body: s('body'),
        repo: s('repo'),
        dataset: s('dataset'),
        config: s('config'),
        ref: s('ref') || undefined,
        model: s('model') || undefined,
      },
      { onSuccess: (item) => navigate(`/tasks/${item.id}`) },
    )
  }
  const o = options.data
  return (
    <Card>
      <form onSubmit={submit} aria-labelledby="new-task-title">
        <div className="border-line border-b px-5 py-3">
          <h2 id="new-task-title" className="font-semibold text-sm">
            New task
          </h2>
        </div>
        <div className="space-y-4 px-5 py-4">
          <Field label="Title">
            <Input name="title" required maxLength={300} placeholder="Fix pagination in search" />
          </Field>
          <Field label="Description">
            <Textarea
              name="body"
              rows={6}
              placeholder="What should change, acceptance criteria, context…"
            />
          </Field>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(11rem,1fr))] gap-4">
            <Field label="Repository">
              <Input name="repo" required placeholder="owner/name" pattern="[\w.-]+/[\w.-]+" />
            </Field>
            <Field label="Branch from">
              <Input name="ref" placeholder="default branch" />
            </Field>
            <Field label="Sandbox profile">
              <Select name="dataset" defaultValue="">
                <option value="">From the repository</option>
                {(o?.datasets ?? []).map((d) => (
                  <option key={d}>{d}</option>
                ))}
              </Select>
            </Field>
            <Field label="Agent config">
              <Select name="config" required defaultValue="c0-vanilla">
                {(o?.configs ?? []).map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </Select>
            </Field>
            {o?.models.length ? (
              <Field label="Model">
                <Select name="model" defaultValue="">
                  <option value="">Default ({o.default_model ?? "the config's own"})</option>
                  {o.models.map((m) => (
                    <option key={m}>{m}</option>
                  ))}
                </Select>
              </Field>
            ) : null}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3 rounded-b-lg border-line border-t bg-subtle px-5 py-3">
          <Button type="submit" variant="primary" disabled={create.isPending}>
            {create.isPending ? 'Creating… (fetching repo)' : 'Create task'}
          </Button>
          <span className="text-13 text-fg-subtle">
            Created tasks wait for you to enqueue them.
          </span>
          {create.error ? <ErrorBox error={create.error} className="w-full" /> : null}
        </div>
      </form>
    </Card>
  )
}
