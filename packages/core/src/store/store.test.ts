import { expect, it } from 'vitest'
import { Store } from './store.js'

it('creates schema in memory', () => {
  const s = new Store(':memory:', '/tmp/unused')
  const tables = s.db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((r) => (r as { name: string }).name)
  expect(tables).toEqual([
    'benchmarks',
    'checks',
    'configs',
    'failure_labels',
    'repos',
    'reviews',
    'runs',
    'settings',
    'tasks',
    'work_ci',
    'work_events',
    'work_experiments',
    'work_feedback',
    'work_items',
    'work_models',
    'work_order',
    'work_pr_state',
    'work_preflights',
    'work_prs',
    'work_reviews',
    'work_runs',
  ])
  s.close()
})

it('schema.ts matches schema.sql', async () => {
  const { readFile } = await import('node:fs/promises')
  const { SCHEMA } = await import('./schema.js')
  expect(SCHEMA).toBe(await readFile(new URL('./schema.sql', import.meta.url), 'utf8'))
})
