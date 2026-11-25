import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  type Config,
  parseTranscript,
  verificationDetails,
  verificationVerdict,
} from '@codetiller/core'
import { type Context, Hono } from 'hono'
import { isSafeId, type ServerContext } from '../context.js'
import { RUN_FILES, type RunFile } from './runs.js'

const str = (v: unknown, max = 20_000) => (typeof v === 'string' && v.length <= max ? v : undefined)

/** Factory errors (bad state, bad input) are user-facing 400s. */
async function attempt<T>(c: Context, fn: () => T | Promise<T>) {
  try {
    return c.json({ ok: true as const, item: await fn() })
  } catch (e) {
    return c.json({ ok: false as const, error: (e as Error).message }, 400)
  }
}

/** Factory tasks. Mutations only queue/close work; nothing starts without a human. */
export const taskRoutes = (ctx: ServerContext) => {
  const factory = () => {
    if (!ctx.factory) throw new Error('factory not enabled in this server')
    return ctx.factory
  }
  const readRunFile = (runId: string, rel: string) =>
    readFile(join(ctx.store.artifactsDir, runId, rel), 'utf8').catch(() => null)
  /** run (or the preflight's assessment run) must belong to the task in the URL */
  const ownRun = (id: string, runId: string) => {
    if (!isSafeId(id) || !isSafeId(runId)) return undefined
    const run = factory().items.run(runId)
    if (run) return run.item_id === id ? { id: run.id, config_id: run.config_id } : undefined
    return factory().items.preflight(id)?.run_id === runId
      ? { id: runId, config_id: '' }
      : undefined
  }

  return (
    new Hono()
      .get('/', (c) => {
        const items = factory().items
        const totals = items.totals()
        const experiments = items.experiments()
        return c.json({
          items: items.list().map((i) => ({
            ...i,
            /** run to try the factory itself: left out of the metrics */
            experiment: experiments.has(i.id),
            runs: totals.get(i.id)?.runs ?? 0,
            cost_usd: totals.get(i.id)?.cost_usd ?? 0,
          })),
        })
      })
      .get('/options', async (c) => c.json(await factory().options()))
      .get('/status', (c) => c.json(factory().status()))
      // factory settings a human changes from the UI: the default model
      .get('/settings', (c) => c.json(factory().modelSettings()))
      .put('/settings', async (c) => {
        const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
        try {
          const model = b.default_model === null ? null : str(b.default_model, 120)
          if (model === undefined) throw new Error('default_model must be a model id or null')
          return c.json({ ok: true as const, ...factory().setDefaultModel(model) })
        } catch (e) {
          return c.json({ ok: false as const, error: (e as Error).message }, 400)
        }
      })
      .get('/metrics', (c) => c.json(factory().metrics()))
      .post('/sync', async (c) => {
        try {
          const { queued, closed, errors } = await factory().syncPrs()
          return c.json({ ok: true as const, queued, closed, errors })
        } catch (e) {
          return c.json({ ok: false as const, error: (e as Error).message }, 400)
        }
      })
      .post('/import', async (c) => {
        try {
          const { created, errors } = await factory().importIssues()
          return c.json({ ok: true as const, imported: created.map((i) => i.id), errors })
        } catch (e) {
          return c.json({ ok: false as const, error: (e as Error).message }, 400)
        }
      })
      .post('/', async (c) => {
        const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
        return attempt(c, () => {
          const [title, body, repo, dataset, config] = [
            str(b.title, 300),
            str(b.body),
            str(b.repo, 200),
            str(b.dataset, 80),
            str(b.config, 80),
          ]
          // no dataset: the sandbox comes from the repository or from its onboarding
          if (!title || body === undefined || !repo || dataset === undefined || !config)
            throw new Error('title, body, repo and config are required')
          return factory().create({
            title,
            body,
            repo,
            dataset,
            config,
            ref: str(b.ref, 200) || undefined,
            model: str(b.model, 120) || undefined,
          })
        })
      })
      .get('/:id', async (c) => {
        const id = c.req.param('id')
        const item = isSafeId(id) ? factory().items.get(id) : undefined
        if (!item) return c.json({ error: 'task not found' }, 404)
        const events = factory().items.events(id)
        // the factory's latest verdict; a human's acceptance of removed tests is not one
        const verified = events.findLast((e) => e.kind === 'verification' && e.actor === 'factory')
        // which artifacts each run has, so the UI offers only views that exist
        const runs = await Promise.all(
          factory()
            .items.runs(id)
            .map(async (run) => {
              const present = await Promise.all(
                Object.entries(RUN_FILES).map(async ([k, rel]) =>
                  (await readRunFile(run.id, rel)) === null ? null : (k as RunFile),
                ),
              )
              return {
                ...run,
                /** the model this run used */
                model: ctx.store.getConfig(run.config_id)?.model ?? null,
                files: present.filter((f): f is RunFile => f !== null),
              }
            }),
        )
        // a config file that is gone must not take the page down
        const model = await factory()
          .modelOf(id)
          .catch(() => null)
        return c.json({
          item,
          runs,
          events,
          pr: factory().items.pr(id) ?? null,
          /** how the PR stands against the default branch at the last sync: current, behind, conflict */
          prState: factory().items.prState(id) ?? null,
          /** the factory's latest verdict on the branch; null = never verified */
          verification: verified
            ? {
                status: verificationVerdict(verified.text),
                text: verified.text ?? '',
                /** newly failing tests, tests that no longer run, changed files that decide the checks */
                ...verificationDetails(verified.text),
                run_id: verified.run_id,
                at: verified.at,
              }
            : null,
          /** the repository's own CI on the pull request, as last seen; null = never looked at */
          ci: factory().items.ci(id) ?? null,
          /** the second reader's latest reading of the change (advisory); null = none */
          review: factory().items.review(id) ?? null,
          reviewCost: factory().items.reviewCost(id),
          /** assessment before the first run: verdict, estimates, proposed split; null = none yet */
          preflight: factory().items.preflight(id) ?? null,
          preflightLimits: factory().preflightLimits ?? null,
          /** a part of a split: its place in the series and the part it waits for; null = not a part */
          order: factory().orderOf(id),
          /** run to try the factory itself: left out of the metrics */
          experiment: factory().items.experiments().has(id),
          /** the model of the next run, where it comes from, and what a human may choose */
          model,
          models: factory().modelSettings().models,
          canRun: factory().canRun,
        })
      })
      .get('/:id/diff', async (c) => {
        const id = c.req.param('id')
        if (!isSafeId(id) || !factory().items.get(id))
          return c.json({ error: 'task not found' }, 404)
        return c.json({ text: await factory().diff(id) })
      })
      .post('/:id/enqueue', async (c) => {
        const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
        return attempt(c, () =>
          factory().enqueue(c.req.param('id'), str(b.message), {
            skipPreflight: b.skipPreflight === true,
            // absent = keep; null = back to the default
            model: b.model === null ? null : str(b.model, 120) || undefined,
            outOfOrder: b.outOfOrder === true,
          }),
        )
      })
      .put('/:id/experiment', async (c) => {
        const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
        return attempt(c, () => factory().setExperiment(c.req.param('id'), b.on === true))
      })
      .put('/:id/model', async (c) => {
        const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
        return attempt(c, () => {
          const model = b.model === null ? null : str(b.model, 120)
          if (model === undefined) throw new Error('model must be a model id or null')
          return factory().setModel(c.req.param('id'), model)
        })
      })
      .post('/:id/update', async (c) => {
        try {
          // answers once the merge is done; verification and push of a clean merge go on in the worker
          const { result } = await factory().update(c.req.param('id'))
          return c.json({ ok: true as const, result })
        } catch (e) {
          return c.json({ ok: false as const, error: (e as Error).message }, 400)
        }
      })
      .post('/:id/ci', async (c) => {
        try {
          // hand the failing CI checks and the end of their logs to the agent
          await factory().fixCi(c.req.param('id'), 'human')
          return c.json({ ok: true as const })
        } catch (e) {
          return c.json({ ok: false as const, error: (e as Error).message }, 400)
        }
      })
      .post('/:id/verify', async (c) => {
        const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
        try {
          // answers once the request is taken; the suite runs in the worker
          const { accepted } = await factory().verifyAgain(c.req.param('id'), {
            acceptRemoved: b.acceptRemoved === true,
            acceptChecks: b.acceptChecks === true,
          })
          return c.json({ ok: true as const, accepted: accepted.length })
        } catch (e) {
          return c.json({ ok: false as const, error: (e as Error).message }, 400)
        }
      })
      .post('/:id/split', (c) => {
        try {
          const created = factory().split(c.req.param('id'))
          return c.json({ ok: true as const, created: created.map((i) => i.id) })
        } catch (e) {
          return c.json({ ok: false as const, error: (e as Error).message }, 400)
        }
      })
      .post('/:id/complete', (c) => attempt(c, () => factory().complete(c.req.param('id'))))
      .post('/:id/cancel', (c) => attempt(c, () => factory().cancel(c.req.param('id'))))
      .get('/:id/runs/:runId/transcript', async (c) => {
        const run = ownRun(c.req.param('id'), c.req.param('runId'))
        if (!run) return c.json({ error: 'run not found' }, 404)
        const raw = (await readRunFile(run.id, 'transcript.jsonl')) ?? ''
        const harness = (ctx.store.getConfig(run.config_id)?.harness ??
          'claude-code') as Config['harness']
        return c.json({ events: parseTranscript(harness, raw) })
      })
      .get('/:id/runs/:runId/files/:file', async (c) => {
        const run = ownRun(c.req.param('id'), c.req.param('runId'))
        const file = c.req.param('file') as RunFile
        if (!run || !(file in RUN_FILES)) return c.json({ error: 'not found' }, 404)
        const text = await readRunFile(run.id, RUN_FILES[file])
        if (text === null) return c.json({ error: 'not found' }, 404)
        return c.json({ file, text })
      })
  )
}
