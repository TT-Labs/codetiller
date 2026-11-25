import type { AppType } from '@codetiller/server'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { hc, type InferResponseType } from 'hono/client'
import { authHeaders } from './token'

/** Typed client generated from the server's route types: no hand-written DTOs to drift. */
const api = hc<AppType>('/', { headers: authHeaders }).api

export type Benchmark = InferResponseType<typeof api.benchmarks.$get, 200>[number]
export type BenchmarkDetail = InferResponseType<(typeof api.benchmarks)[':id']['$get'], 200>
export type Run = BenchmarkDetail['runs'][number]
export type RunDetail = InferResponseType<(typeof api.runs)[':id']['$get'], 200>
export type TranscriptEvent = InferResponseType<
  (typeof api.runs)[':id']['transcript']['$get'],
  200
>['events'][number]
export type CompareResult = InferResponseType<typeof api.compare.$get, 200>
export type RunFile = RunDetail['files'][number]
export type TaskSummary = InferResponseType<typeof api.tasks.$get, 200>['items'][number]
export type TaskDetail = InferResponseType<(typeof api.tasks)[':id']['$get'], 200>
export type TaskEvent = TaskDetail['events'][number]
export type TaskRun = TaskDetail['runs'][number]
export type TaskState = TaskDetail['item']['state']
export type TaskOptions = InferResponseType<typeof api.tasks.options.$get, 200>
export type FactoryStatus = InferResponseType<typeof api.tasks.status.$get, 200>
export type FactoryMetrics = InferResponseType<typeof api.tasks.metrics.$get, 200>
export type FactorySettings = InferResponseType<typeof api.tasks.settings.$get, 200>

async function ok<T>(res: Response & { json(): Promise<unknown> }): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(body.error ?? `HTTP ${res.status}`)
  }
  return (await res.json()) as T
}

/** does the server accept this page's token; `false` = it wants one this page does not have */
export const useAuthorized = () =>
  useQuery({
    queryKey: ['authorized'],
    queryFn: async () => (await api.health.$get()).status !== 401,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  })

export const useBenchmarks = () =>
  useQuery({
    queryKey: ['benchmarks'],
    queryFn: async () => ok<Benchmark[]>(await api.benchmarks.$get()),
  })

export const useBenchmark = (id: string) =>
  useQuery({
    queryKey: ['benchmark', id],
    queryFn: async () => ok<BenchmarkDetail>(await api.benchmarks[':id'].$get({ param: { id } })),
  })

export const useRun = (id: string) =>
  useQuery({
    queryKey: ['run', id],
    queryFn: async () => ok<RunDetail>(await api.runs[':id'].$get({ param: { id } })),
  })

export const useTranscript = (id: string) =>
  useQuery({
    queryKey: ['transcript', id],
    queryFn: async () =>
      ok<{ events: TranscriptEvent[] }>(await api.runs[':id'].transcript.$get({ param: { id } })),
  })

export const useRunFile = (id: string, file: RunFile, enabled = true) =>
  useQuery({
    queryKey: ['run-file', id, file],
    enabled,
    queryFn: async () =>
      ok<{ text: string }>(await api.runs[':id'].files[':file'].$get({ param: { id, file } })),
  })

export const useCompare = (a?: string, b?: string, split = 'all') =>
  useQuery({
    queryKey: ['compare', a, b, split],
    enabled: !!a && !!b,
    queryFn: async () =>
      ok<CompareResult>(
        await api.compare.$get({ query: { a: a as string, b: b as string, split } }),
      ),
  })

// ---- factory tasks ------------------------------------------------------------------

/** states where the factory is working: poll so the timeline and conversation stay live */
export const LIVE_STATES: readonly TaskState[] = ['QUEUED', 'PREFLIGHT', 'RUNNING']
/** states waiting for the human */
export const NEEDS_YOU: readonly TaskState[] = ['WAITING_FOR_HUMAN', 'REVIEW', 'PR_OPEN', 'FAILED']

export const useTasks = () =>
  useQuery({
    queryKey: ['tasks'],
    refetchInterval: 3000,
    queryFn: async () => ok<{ items: TaskSummary[] }>(await api.tasks.$get()),
  })

export const useMetrics = () =>
  useQuery({
    queryKey: ['factory-metrics'],
    queryFn: async () => ok<FactoryMetrics>(await api.tasks.metrics.$get()),
  })

/** is the factory alive and connected; polled so sync errors surface without a reload */
export const useFactoryStatus = () =>
  useQuery({
    queryKey: ['factory-status'],
    refetchInterval: 10_000,
    queryFn: async () => ok<FactoryStatus>(await api.tasks.status.$get()),
  })

/** poll GitHub now: PR feedback and state, then newly labelled issues */
export const useSyncNow = () => {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (status: FactoryStatus) => {
      const errors: string[] = []
      for (const [enabled, call] of [
        [status.canSync, () => api.tasks.sync.$post({}, json({}))],
        [status.canImport, () => api.tasks.import.$post({}, json({}))],
      ] as const) {
        if (!enabled) continue
        const body = (await (await call()).json()) as { ok: boolean; error?: string }
        if (!body.ok) errors.push(body.error ?? 'failed')
      }
      if (errors.length) throw new Error(errors.join('; '))
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['tasks'] })
      qc.invalidateQueries({ queryKey: ['factory-status'] })
    },
  })
}

/** what a human sets for the whole factory: the default model, and the models on offer */
export const useSettings = () =>
  useQuery({
    queryKey: ['settings'],
    queryFn: async () => ok<FactorySettings>(await api.tasks.settings.$get()),
  })

/** null = no default: each task's config decides */
export const useSetDefaultModel = () => {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (model: string | null) => {
      const body = (await (
        await api.tasks.settings.$put({}, json({ default_model: model }))
      ).json()) as ({ ok: true } & FactorySettings) | { ok: false; error: string }
      if (!body.ok) throw new Error(body.error)
      return body
    },
    // the model of every task without an own choice changes with it
    onSettled: () => qc.invalidateQueries(),
  })
}

export const useTaskOptions = () =>
  useQuery({
    queryKey: ['task-options'],
    queryFn: async () => ok<TaskOptions>(await api.tasks.options.$get()),
  })

export const useTask = (id: string) =>
  useQuery({
    queryKey: ['task', id],
    refetchInterval: (q) =>
      q.state.data && LIVE_STATES.includes(q.state.data.item.state) ? 2000 : 10_000,
    queryFn: async () => ok<TaskDetail>(await api.tasks[':id'].$get({ param: { id } })),
  })

export const useTaskDiff = (id: string, version: string) =>
  useQuery({
    queryKey: ['task-diff', id, version],
    queryFn: async () => ok<{ text: string }>(await api.tasks[':id'].diff.$get({ param: { id } })),
  })

export const useTaskRunTranscript = (id: string, runId: string, live: boolean) =>
  useQuery({
    queryKey: ['task-run-transcript', id, runId],
    refetchInterval: live ? 2000 : false,
    queryFn: async () =>
      ok<{ events: TranscriptEvent[] }>(
        await api.tasks[':id'].runs[':runId'].transcript.$get({ param: { id, runId } }),
      ),
  })

export const useTaskRunFile = (id: string, runId: string, file: RunFile) =>
  useQuery({
    queryKey: ['task-run-file', id, runId, file],
    queryFn: async () =>
      ok<{ text: string }>(
        await api.tasks[':id'].runs[':runId'].files[':file'].$get({ param: { id, runId, file } }),
      ),
  })

type Mutation = { ok: true; item: TaskDetail['item'] } | { ok: false; error: string }

/** POST JSON; the server only accepts JSON writes from the same origin. */
async function write(res: Promise<Response>): Promise<TaskDetail['item']> {
  const body = (await (
    await res
  )
    .json()
    .catch(() => ({ ok: false, error: 'bad response' }))) as Mutation
  if (!body.ok) throw new Error(body.error)
  return body.item
}
const json = (body: unknown) => ({
  init: { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } },
})

function useTaskMutation<V>(fn: (v: V) => Promise<TaskDetail['item']>) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSuccess: (item) => {
      qc.invalidateQueries({ queryKey: ['tasks'] })
      qc.invalidateQueries({ queryKey: ['task', item.id] })
    },
  })
}

export const useCreateTask = () =>
  useTaskMutation(
    (v: {
      title: string
      body: string
      repo: string
      dataset: string
      config: string
      ref?: string
      model?: string
    }) => write(api.tasks.$post({}, json(v))),
  )

export const useImportIssues = () => {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async () => {
      const body = (await (await api.tasks.import.$post({}, json({}))).json()) as
        | { ok: true; imported: string[]; errors: string[] }
        | { ok: false; error: string }
      if (!body.ok) throw new Error(body.error)
      return { imported: body.imported, errors: body.errors }
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tasks'] }),
  })
}

export const useEnqueue = (id: string) =>
  useTaskMutation((v: { message: string; skipPreflight?: boolean }) =>
    write(api.tasks[':id'].enqueue.$post({ param: { id } }, json(v))),
  )

/** hand the failing CI checks of the task's pull request to the agent */
export const useFixCi = (id: string) => {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async () => {
      const body = (await (await api.tasks[':id'].ci.$post({ param: { id } }, json({}))).json()) as
        | { ok: true }
        | { ok: false; error: string }
      if (!body.ok) throw new Error(body.error)
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['tasks'] })
      qc.invalidateQueries({ queryKey: ['task', id] })
    },
  })
}

/** verify the branch again without an agent run; `acceptRemoved`: the removed tests may go */
export const useVerifyAgain = (id: string) => {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (v: { acceptRemoved?: boolean; acceptChecks?: boolean }) => {
      const body = (await (
        await api.tasks[':id'].verify.$post({ param: { id } }, json(v))
      ).json()) as { ok: true; accepted: number } | { ok: false; error: string }
      if (!body.ok) throw new Error(body.error)
      return body.accepted
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['tasks'] })
      qc.invalidateQueries({ queryKey: ['task', id] })
    },
  })
}

/** an experiment is a task run to try the factory itself: left out of the metrics */
export const useSetExperiment = (id: string) => {
  const qc = useQueryClient()
  return useTaskMutation(async (on: boolean) => {
    const item = await write(api.tasks[':id'].experiment.$put({ param: { id } }, json({ on })))
    qc.invalidateQueries({ queryKey: ['metrics'] })
    return item
  })
}

/** the model of the task's next runs; null = back to the default */
export const useSetTaskModel = (id: string) =>
  useTaskMutation((model: string | null) =>
    write(api.tasks[':id'].model.$put({ param: { id } }, json({ model }))),
  )

/** bring the default branch into the task's branch; conflicts go to the agent */
export const useUpdateTask = (id: string) => {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async () => {
      const body = (await (
        await api.tasks[':id'].update.$post({ param: { id } }, json({}))
      ).json()) as
        | { ok: true; result: 'current' | 'merged' | 'conflict' }
        | { ok: false; error: string }
      if (!body.ok) throw new Error(body.error)
      return body.result
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['tasks'] })
      qc.invalidateQueries({ queryKey: ['task', id] })
    },
  })
}

/** approve the preflight's proposed split: its parts become tasks, this one is cancelled */
export const useSplitTask = (id: string) => {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async () => {
      const body = (await (
        await api.tasks[':id'].split.$post({ param: { id } }, json({}))
      ).json()) as { ok: true; created: string[] } | { ok: false; error: string }
      if (!body.ok) throw new Error(body.error)
      return body.created
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tasks'] })
      qc.invalidateQueries({ queryKey: ['task', id] })
    },
  })
}

export const useCloseTask = (id: string) =>
  useTaskMutation((action: 'complete' | 'cancel') =>
    write(
      action === 'complete'
        ? api.tasks[':id'].complete.$post({ param: { id } }, json({}))
        : api.tasks[':id'].cancel.$post({ param: { id } }, json({})),
    ),
  )
