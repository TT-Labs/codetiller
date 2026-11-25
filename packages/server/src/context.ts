import { join } from 'node:path'
import { type Factory, loadSplit, loadTask, type Store, type Task } from '@codetiller/core'

/** Everything a route needs; built once per server. */
export interface ServerContext {
  store: Store
  /** working dir holding datasets/ and artifacts/ (tiller.yaml dir) */
  root: string
  /** factory (tasks); absent = read-only eval dashboard */
  factory?: Factory
  /**
   * Every API call must carry this (header `x-tiller-token`). The API can queue paid runs and
   * serves repository code and transcripts; anything on the host, and containers on docker's
   * default network, can reach its port. Absent = no check (tests).
   */
  token?: string
  /** `Host` values the server answers to (`127.0.0.1:<port>`, `localhost:<port>`); absent = any */
  hosts?: string[]
}

// ids come from URLs and become file paths: allow only what tiller generates
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/
export const isSafeId = (id: string) => SAFE_ID.test(id) && !id.includes('..')

export const datasetDir = (ctx: ServerContext, dataset: string) =>
  join(ctx.root, 'datasets', dataset)

export async function readTask(
  ctx: ServerContext,
  dataset: string,
  taskId: string,
): Promise<Task | undefined> {
  if (!isSafeId(dataset) || !isSafeId(taskId)) return undefined
  return loadTask(join(datasetDir(ctx, dataset), 'tasks', `${taskId}.yaml`)).catch(() => undefined)
}

export async function splitIds(ctx: ServerContext, dataset: string, split: string) {
  if (split === 'all' || !isSafeId(dataset)) return undefined
  const s = await loadSplit(datasetDir(ctx, dataset))
  return new Set(split === 'train' ? (s?.train ?? []) : (s?.holdout ?? []))
}
