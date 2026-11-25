import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { type Config, parseTranscript } from '@codetiller/core'
import { Hono } from 'hono'
import { isSafeId, readTask, type ServerContext } from '../context.js'

/** run artifacts the API may serve (allowlist, never arbitrary paths) */
export const RUN_FILES = {
  prompt: 'prompt.md',
  context: 'context.md',
  diff: 'diff.patch',
  tests: 'checks/tests.log',
  stderr: 'agent.stderr.log',
  verify: 'verify.log',
  manifest: 'manifest.json',
} as const

export type RunFile = keyof typeof RUN_FILES

const readArtifact = (ctx: ServerContext, runId: string, rel: string) =>
  readFile(join(ctx.store.artifactsDir, runId, rel), 'utf8').catch(() => null)

export const runRoutes = (ctx: ServerContext) =>
  new Hono()
    .get('/:id', async (c) => {
      const id = c.req.param('id')
      const run = isSafeId(id) ? ctx.store.getRun(id) : undefined
      if (!run) return c.json({ error: 'run not found' }, 404)
      const dataset = ctx.store.taskDataset(run.task_id)
      const task = dataset ? await readTask(ctx, dataset, run.task_id) : undefined
      const present = await Promise.all(
        Object.entries(RUN_FILES).map(async ([k, rel]) =>
          (await readArtifact(ctx, id, rel)) === null ? null : (k as RunFile),
        ),
      )
      return c.json({
        run,
        checks: ctx.store.runChecks(id),
        config: ctx.store.getConfig(run.config_id) ?? null,
        dataset: dataset ?? null,
        task: task
          ? {
              id: task.id,
              repo: task.repo,
              title: task.issue.title,
              body: task.issue.body,
              url: task.issue.url ?? null,
              hidden_tests: task.hidden_tests,
              fail_to_pass: task.fail_to_pass,
            }
          : null,
        files: present.filter((f): f is RunFile => f !== null),
      })
    })
    .get('/:id/transcript', async (c) => {
      const id = c.req.param('id')
      const run = isSafeId(id) ? ctx.store.getRun(id) : undefined
      if (!run) return c.json({ error: 'run not found' }, 404)
      const raw = await readArtifact(ctx, id, 'transcript.jsonl')
      if (raw === null) return c.json({ error: 'no transcript' }, 404)
      const harness = (ctx.store.getConfig(run.config_id)?.harness ??
        'claude-code') as Config['harness']
      return c.json({ events: parseTranscript(harness, raw) })
    })
    .get('/:id/files/:file', async (c) => {
      const id = c.req.param('id')
      const file = c.req.param('file') as RunFile
      if (!isSafeId(id) || !(file in RUN_FILES)) return c.json({ error: 'not found' }, 404)
      const text = await readArtifact(ctx, id, RUN_FILES[file])
      if (text === null) return c.json({ error: 'not found' }, 404)
      return c.json({ file, text })
    })
