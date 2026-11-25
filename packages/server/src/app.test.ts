import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DockerSandbox, Factory, GitWorkspaces, Store, WorkItems } from '@codetiller/core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApi } from './app.js'

let root: string
let store: Store
let api: ReturnType<typeof createApi>

const config = {
  name: 'c0',
  harness: 'claude-code' as const,
  model: 'claude-sonnet-5-5',
  skills: [],
  prompt_template: 'p.md',
  limits: { max_turns: 10, timeout_s: 60, budget_usd: 1 },
}
const task = {
  id: 't-1',
  repo: 'o/r',
  base_commit: 'a',
  fix_commit: 'b',
  issue: { title: 'Bug', body: 'broken' },
  hidden_tests: ['x.test.ts'],
  fail_to_pass: ['x > y'],
  pass_to_pass: 'suite' as const,
  tags: [],
  spec_hash: 'h',
}
const run = (id: string, benchmark_id: string, outcome: string) => ({
  id,
  task_id: 't-1',
  config_id: 'cfg',
  benchmark_id,
  repeat: 0,
  started_at: '2026-11-14T00:00:00Z',
  cost_usd: 0.1,
  duration_s: 10,
  outcome,
  score: outcome === 'success' ? 1 : 0,
})

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'tiller-server-'))
  store = new Store(join(root, 'tiller.db'), join(root, 'artifacts'))
  store.upsertTask(task, 'ds')
  store.upsertConfig('cfg', config, 'p')
  for (const b of ['bA', 'bB'])
    store.createBenchmark({
      id: b,
      name: b,
      dataset: 'ds',
      config_id: 'cfg',
      split: 'all',
      repeats: 1,
    })
  store.insertRun(run('r-a', 'bA', 'fail'), [])
  store.insertRun(run('r-b', 'bB', 'success'), [
    { name: 'fail_to_pass', passed: true, total: 1, failed: 0 },
  ])
  const dir = await store.runDir('r-b')
  await writeFile(
    join(dir, 'transcript.jsonl'),
    `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } })}\n`,
  )
  await writeFile(join(dir, 'diff.patch'), '+fix\n')
  await mkdir(join(root, 'datasets', 'ds', 'tasks'), { recursive: true })
  await writeFile(
    join(root, 'datasets', 'ds', 'tasks', 't-1.yaml'),
    'id: t-1\nrepo: o/r\nbase_commit: a\nfix_commit: b\nissue: {title: Bug, body: broken}\nhidden_tests: [x.test.ts]\nfail_to_pass: [x > y]\npass_to_pass: suite\n',
  )
  // factory without credentials: tasks can be queued, never run
  const items = new WorkItems(store)
  items.create({
    title: 'Fix it',
    body: 'b',
    repo: 'o/r',
    dataset: 'ds',
    config: 'c0',
    base_commit: 'abc',
    source: 'manual',
    external_url: null,
  })
  const factory = new Factory({
    items,
    sandbox: new DockerSandbox(),
    workspaces: new GitWorkspaces(join(root, '.cache')),
    root,
  })
  api = createApi({ store, root, factory })
})

afterAll(async () => {
  store.close()
  await rm(root, { recursive: true, force: true })
})

describe('api', () => {
  it('lists benchmarks with aggregates', async () => {
    const res = await api.request('/api/benchmarks')
    const list = (await res.json()) as { id: string; runs: number; successes: number }[]
    expect(list.map((b) => [b.id, b.runs, b.successes]).sort()).toEqual([
      ['bA', 1, 0],
      ['bB', 1, 1],
    ])
  })

  it('serves run detail with task, checks and present files', async () => {
    const res = await api.request('/api/runs/r-b')
    const body = (await res.json()) as {
      task: { title: string }
      checks: { passed: boolean }[]
      files: string[]
    }
    expect(body.task.title).toBe('Bug')
    expect(body.checks[0]?.passed).toBe(true)
    expect(body.files).toEqual(['diff'])
  })

  it('parses the transcript into events', async () => {
    const res = await api.request('/api/runs/r-b/transcript')
    expect(await res.json()).toEqual({ events: [{ kind: 'text', role: 'assistant', text: 'hi' }] })
  })

  it('only serves allowlisted artifact files', async () => {
    expect((await api.request('/api/runs/r-b/files/diff')).status).toBe(200)
    expect((await api.request('/api/runs/r-b/files/transcript.jsonl')).status).toBe(404)
    expect((await api.request('/api/runs/..%2F..%2Fetc/files/diff')).status).toBe(404)
  })

  it('compares two benchmarks per task', async () => {
    const res = await api.request('/api/compare?a=bA&b=bB')
    const body = (await res.json()) as {
      comparison: {
        flips: { failToSuccess: number }
        noise: number | null
        metrics: { name: string }[]
      }
      solvable: unknown
      evidence: string
      tasks: { task_id: string; underspecified: string | null }[]
    }
    expect(body.comparison.flips.failToSuccess).toBe(1)
    // one task, one run per side, and they disagree: the whole delta is within rerun noise
    expect(body.comparison.noise).toBeCloseTo(1.96)
    expect(body.comparison.metrics.map((m) => m.name)).toContain('f2p_share')
    expect(body.tasks).toEqual([expect.objectContaining({ task_id: 't-1', underspecified: null })])
    expect(body.solvable).toBeNull()
    expect(body.evidence).toMatch(/^## Eval evidence\n\n\*\*(PROMOTE|KEEP)\*\* — /)
  })
})

describe('tasks', () => {
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    api.request(path, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json', host: 'localhost', ...headers },
    })

  it('lists and shows tasks with their timeline', async () => {
    const list = (await (await api.request('/api/tasks')).json()) as { items: { id: string }[] }
    expect(list.items.map((i) => i.id)).toEqual(['T-1'])
    const one = (await (await api.request('/api/tasks/T-1')).json()) as {
      item: { state: string }
      events: { kind: string }[]
      canRun: boolean
    }
    expect(one.item.state).toBe('IMPORTED')
    expect(one.events.map((e) => e.kind)).toEqual(['created'])
    expect(one.canRun).toBe(false)
  })

  it('human enqueues with a message; bad transitions are 400', async () => {
    const r = await post('/api/tasks/T-1/enqueue', { message: 'go' })
    expect(r.status).toBe(200)
    expect(((await r.json()) as { item: { state: string } }).item.state).toBe('QUEUED')
    const again = await post('/api/tasks/T-1/enqueue', {})
    expect(again.status).toBe(400)
    expect(((await again.json()) as { error: string }).error).toMatch(/QUEUED/)
  })

  it('import without a configured tracker is a 400, and options say so', async () => {
    const r = await post('/api/tasks/import', {})
    expect(r.status).toBe(400)
    expect(((await r.json()) as { error: string }).error).toMatch(/no tracker configured/)
    const o = (await (await api.request('/api/tasks/options')).json()) as { canImport: boolean }
    expect(o.canImport).toBe(false)
  })

  it('rejects cross-origin and non-JSON writes', async () => {
    expect(
      (await post('/api/tasks/T-1/cancel', {}, { origin: 'https://evil.example' })).status,
    ).toBe(403)
    expect((await post('/api/tasks/T-1/cancel', {}, { origin: 'null' })).status).toBe(403)
    const form = await api.request('/api/tasks/T-1/cancel', {
      method: 'POST',
      body: 'a=1',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    })
    expect(form.status).toBe(403)
    expect((await post('/api/tasks/T-1/cancel', {}, { origin: 'http://localhost' })).status).toBe(
      200,
    )
  })

  it('task detail carries what a reviewer needs: PR, latest verdict, files per run', async () => {
    const empty = (await (await api.request('/api/tasks/T-1')).json()) as {
      pr: unknown
      verification: unknown
      preflight: unknown
    }
    expect(empty).toMatchObject({ pr: null, verification: null, preflight: null })

    const items = new WorkItems(store)
    items.setPr('T-1', { number: 7, url: 'https://github.com/o/r/pull/7' })
    items.event(
      'T-1',
      'factory',
      'verification',
      'verification failed: 1 of 3 tests newly failing\n- a > b',
    )
    items.event('T-1', 'factory', 'verification', 'verification passed: 3 tests')
    const one = (await (await api.request('/api/tasks/T-1')).json()) as {
      pr: { number: number }
      verification: { status: string; text: string }
      runs: unknown[]
    }
    expect(one.pr).toEqual({ number: 7, url: 'https://github.com/o/r/pull/7' })
    expect(one.verification).toMatchObject({ status: 'pass', text: 'verification passed: 3 tests' })
    expect(one.runs).toEqual([])
  })

  it('reports factory status; sync without a forge is a 400', async () => {
    const s = (await (await api.request('/api/tasks/status')).json()) as Record<string, unknown>
    expect(s).toMatchObject({
      worker: false,
      canRun: false,
      canSync: false,
      canImport: false,
      running: 0,
      intake: null,
      sync: null,
    })
    const r = await post('/api/tasks/sync', {})
    expect(r.status).toBe(400)
    expect(((await r.json()) as { error: string }).error).toMatch(/no forge configured/)
  })

  it('does not serve runs of another task', async () => {
    expect((await api.request('/api/tasks/T-1/runs/r-b/transcript')).status).toBe(404)
  })
})

describe('access', () => {
  const guarded = () =>
    createApi({ store, root, token: 'secret-token', hosts: ['127.0.0.1:4317', 'localhost:4317'] })
  const call = (path: string, headers: Record<string, string> = {}, init: RequestInit = {}) =>
    guarded().request(path, { ...init, headers: { host: '127.0.0.1:4317', ...headers } })

  it('answers no API call without the token, reads included', async () => {
    for (const path of ['/api/health', '/api/benchmarks', '/api/runs/r-a', '/api/tasks'])
      expect([path, (await call(path)).status]).toEqual([path, 401])
    expect((await call('/api/health', { 'x-tiller-token': 'wrong' })).status).toBe(401)
    expect((await call('/api/health', { 'x-tiller-token': 'secret-token-and-more' })).status).toBe(
      401,
    )
    const ok = await call('/api/health', { 'x-tiller-token': 'secret-token' })
    expect(ok.status).toBe(200)
    // the refusal names no part of the token
    expect(await (await call('/api/health')).text()).not.toContain('secret')
    // a write needs it as well, before anything else is looked at
    const write = await call(
      '/api/tasks/sync',
      { 'content-type': 'application/json' },
      { method: 'POST', body: '{}' },
    )
    expect(write.status).toBe(401)
  })

  it('answers only to its own host names', async () => {
    const token = { 'x-tiller-token': 'secret-token' }
    expect((await call('/api/health', { ...token, host: 'localhost:4317' })).status).toBe(200)
    for (const host of ['evil.example:4317', 'host.docker.internal:4317', '127.0.0.1:9999', ''])
      expect([host, (await call('/api/health', { ...token, host })).status]).toEqual([host, 403])
  })

  it('without a configured token the API is open (tests, read-only dashboards)', async () => {
    expect((await api.request('/api/health')).status).toBe(200)
  })
})
