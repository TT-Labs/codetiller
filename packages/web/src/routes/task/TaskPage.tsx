import { Link, useParams } from 'react-router'
import { type TaskDetail, useCloseTask, useTask, useTaskDiff } from '../../api'
import { Diff } from '../../components/Diff'
import { TaskStateBadge } from '../../components/ui/Badge'
import { Button, buttonClass } from '../../components/ui/Button'
import { ExternalLink } from '../../components/ui/icons'
import { ExternalA, MetaList, PageHeader } from '../../components/ui/layout'
import { EmptyState, ErrorBox, Loading } from '../../components/ui/states'
import { Tabs } from '../../components/ui/Tabs'
import { usePageTitle } from '../../title'
import { useTabParam } from '../../useTabParam'
import { Composer } from './Composer'
import { StatusBlock } from './Status'
import { Timeline } from './Timeline'

const TABS = ['timeline', 'diff'] as const
type TabId = (typeof TABS)[number]

export function TaskPage() {
  const { id = '' } = useParams()
  const { data, error, isLoading } = useTask(id)
  const [tab, setTab] = useTabParam<TabId>(TABS, 'timeline')
  usePageTitle(data ? `${data.item.id} ${data.item.title}` : id)
  if (isLoading) return <Loading what="task" />
  if (error || !data) return <ErrorBox error={error ?? 'not found'} />
  const { item, runs } = data
  const head = runs.at(-1)?.commit_sha ?? runs.at(-1)?.id ?? 'none'

  return (
    <>
      <PageHeader
        crumbs={[{ label: 'Tasks', to: '/' }, { label: item.id }]}
        title={item.title}
        badge={<TaskStateBadge state={item.state} />}
        meta={
          <MetaList
            items={[
              { label: 'Repo', value: item.repo, mono: true },
              {
                label: 'Branch',
                value: (
                  <>
                    {item.branch} <span className="font-sans text-13 text-fg-subtle">from</span>{' '}
                    {item.base_commit.slice(0, 8)}
                  </>
                ),
                mono: true,
              },
              { label: 'Config', value: item.config, mono: true },
              data.order && {
                label: 'Part',
                value: (
                  <>
                    {data.order.position} of {data.order.total} of{' '}
                    <Link
                      to={`/tasks/${data.order.parent}`}
                      className="text-accent-text hover:underline"
                    >
                      {data.order.parent}
                    </Link>
                  </>
                ),
              },
              { label: 'Profile', value: item.dataset, mono: true },
              item.external_url && {
                value: <ExternalA href={item.external_url}>Issue</ExternalA>,
              },
            ]}
          />
        }
        actions={<CloseActions item={item} pr={data.pr} />}
      />
      <div className="space-y-6">
        <StatusBlock data={data} />
        <Composer data={data} />
        <div className="space-y-4">
          <Tabs<TabId>
            label="Task views"
            value={tab}
            onChange={setTab}
            tabs={[
              { id: 'timeline', label: 'Timeline' },
              { id: 'diff', label: 'Changes', hidden: runs.length === 0 },
            ]}
          />
          {tab === 'timeline' ? <Timeline data={data} /> : null}
          {tab === 'diff' ? <TaskDiff id={item.id} version={head} /> : null}
        </div>
      </div>
    </>
  )
}

function CloseActions({ item, pr }: { item: TaskDetail['item']; pr: TaskDetail['pr'] }) {
  const close = useCloseTask(item.id)
  if (
    !['IMPORTED', 'QUEUED', 'WAITING_FOR_HUMAN', 'REVIEW', 'PR_OPEN', 'FAILED'].includes(item.state)
  )
    return null
  return (
    <div className="flex flex-col items-stretch gap-2 sm:items-end">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="danger"
          disabled={close.isPending}
          onClick={() => {
            if (confirm(`Cancel ${item.id}?`)) close.mutate('cancel')
          }}
        >
          Cancel task
        </Button>
        {pr ? (
          // with a PR, done means merged: the factory completes the task when it sees the merge
          <>
            {item.state === 'REVIEW' || item.state === 'PR_OPEN' ? (
              <Button
                disabled={close.isPending}
                title="Merging the pull request completes the task on its own"
                onClick={() => {
                  if (
                    confirm(
                      `Mark ${item.id} completed without merging PR #${pr.number}? The pull request stays open.`,
                    )
                  )
                    close.mutate('complete')
                }}
              >
                Mark completed
              </Button>
            ) : null}
            <a href={pr.url} target="_blank" rel="noreferrer" className={buttonClass('primary')}>
              Open PR #{pr.number}
              <ExternalLink className="size-3.5" />
            </a>
          </>
        ) : item.state === 'REVIEW' ? (
          <Button
            variant="primary"
            disabled={close.isPending}
            onClick={() => close.mutate('complete')}
          >
            Accept
          </Button>
        ) : null}
      </div>
      {close.error ? <ErrorBox error={close.error} /> : null}
    </div>
  )
}

function TaskDiff({ id, version }: { id: string; version: string }) {
  const { data, error, isLoading } = useTaskDiff(id, version)
  if (isLoading) return <Loading what="changes" />
  if (error || !data) return <ErrorBox error={error ?? 'missing'} />
  return data.text.trim() ? <Diff text={data.text} /> : <EmptyState title="No changes yet." />
}
