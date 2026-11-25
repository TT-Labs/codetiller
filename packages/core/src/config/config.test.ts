import { describe, expect, it } from 'vitest'
import { type Config, configHash, mergeConfig } from './config.js'

const base: Config = {
  name: 'c0',
  harness: 'claude-code',
  model: 'claude-sonnet-5-5',
  skills: [],
  prompt_template: 'prompts/default.md',
  limits: { max_turns: 60, timeout_s: 1200, budget_usd: 5 },
}

describe('config', () => {
  it('merges extends, child wins, limits deep-merged', () => {
    const merged = mergeConfig(base, { name: 'c1', skills: ['hono@1'], limits: { budget_usd: 3 } })
    expect(merged.name).toBe('c1')
    expect(merged.skills).toEqual(['hono@1'])
    expect(merged.limits).toEqual({ max_turns: 60, timeout_s: 1200, budget_usd: 3 })
  })

  it('hash ignores name, depends on prompt text', () => {
    expect(configHash(base, 'p')).toBe(configHash({ ...base, name: 'other' }, 'p'))
    expect(configHash(base, 'p')).not.toBe(configHash(base, 'q'))
  })
})
