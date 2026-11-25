import { expect, it } from 'vitest'
import { sha256 } from '../util/hash.js'
import { checkManifest, type ManifestSources, type RunManifest } from './manifest.js'

const manifest = (over: Partial<RunManifest> = {}): RunManifest => ({
  schema: 1,
  run: { id: 'T-1-x', kind: 'run', seq: 1, started_at: '2026-11-15T00:00:00Z' },
  task: { id: 'T-1', title: 't', source: 'github', external_url: null },
  repo: { name: 'o/r', branch: 'tiller/t-1', base_commit: 'aaa', head_before: 'aaa' },
  factory: { version: '0.0.0', commit: 'fff', dirty: false },
  agent: {
    harness: 'claude-code',
    model: 'm',
    config: 'c0',
    config_id: 'h',
    limits: { max_turns: 60, timeout_s: 1200, budget_usd: 5 },
    resumed_session: null,
  },
  sandbox: {
    image: 'img',
    image_id: 'sha256:1',
    workspace: 'read-write',
    network: 'tiller-agents',
    model_access: 'gateway',
    disallowed_tools: ['WebFetch', 'WebSearch'],
  },
  prompt: { template: 'implement.md', sha256: sha256('the prompt') },
  skills: [
    { name: 'ops', source: 'config', ref: 'ops@1', sha256: sha256('ops body'), tokens: 2 },
    {
      name: 'layout',
      source: 'repo',
      ref: '.factory/skills/layout.md',
      sha256: sha256('layout'),
      tokens: 2,
    },
  ],
  context_sha256: null,
  human_messages: [],
  ...over,
})

const sources = (over: Partial<ManifestSources> = {}): ManifestSources => ({
  hasCommit: async () => true,
  factorySkill: async () => 'ops body',
  repoSkill: async () => 'layout',
  imageId: async () => 'sha256:1',
  prompt: async () => 'the prompt',
  ...over,
})

it('a run whose inputs are all still there and unchanged checks clean', async () => {
  const checks = await checkManifest(manifest(), sources())
  expect(checks.every((c) => c.ok)).toBe(true)
  expect(checks.map((c) => c.what)).toEqual([
    'base commit',
    'head before the run',
    'skill ops (config)',
    'skill layout (repo)',
    'image',
    'prompt',
    'factory',
  ])
})

it('reports each input that drifted or is gone', async () => {
  const checks = await checkManifest(
    manifest({ factory: { version: '0.0.0', commit: 'fff', dirty: true } }),
    sources({
      hasCommit: async (_repo, commit) => commit !== 'aaa',
      factorySkill: async () => 'ops body, edited',
      repoSkill: async () => null,
      imageId: async () => 'sha256:2',
    }),
  )
  expect(Object.fromEntries(checks.filter((c) => !c.ok).map((c) => [c.what, c.detail]))).toEqual({
    'base commit': 'aaa is missing from the repo cache',
    'head before the run': 'aaa is missing from the repo cache',
    'skill ops (config)': 'ops@1 changed since the run',
    'skill layout (repo)': '.factory/skills/layout.md not found',
    image: 'img was rebuilt since the run',
    factory: 'ran from fff with uncommitted changes',
  })
  expect(checks.find((c) => c.what === 'prompt')?.ok).toBe(true)
})
