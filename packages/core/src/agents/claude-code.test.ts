import { expect, it } from 'vitest'
import { ClaudeCodeAdapter, OFFLINE_PRELUDE, parseClaudeStream } from './claude-code.js'

it('finds final result event', () => {
  const t = [
    '{"type":"system"}',
    'noise',
    '{"type":"result","total_cost_usd":1.23,"num_turns":7,"is_error":false}',
  ].join('\n')
  expect(parseClaudeStream(t)).toMatchObject({ total_cost_usd: 1.23, num_turns: 7 })
})

it('offline agents get the pnpm wrapper before the agent starts; others do not', () => {
  const input = {
    sandbox: {
      exec: async () => ({ exitCode: 0, timedOut: false, stdout: '', stderr: '', duration_s: 0 }),
    },
    image: 'img',
    workspace: '/ws',
    promptFile: '/p.md',
    config: {
      name: 'c',
      harness: 'claude-code' as const,
      model: 'm',
      skills: [],
      prompt_template: 'p',
      limits: { max_turns: 5, timeout_s: 60, budget_usd: 1 },
    },
    env: {},
  }
  const adapter = new ClaudeCodeAdapter()
  const online = adapter.request(input).cmd[2] as string
  expect(online.startsWith('claude -p')).toBe(true)
  const offline = adapter.request({ ...input, offline: true, network: 'tiller-agents' })
    .cmd[2] as string
  expect(offline.startsWith(OFFLINE_PRELUDE)).toBe(true)
  expect(offline).toContain('--pm-on-fail=ignore --config.verify-deps-before-run=false "$@"')
  expect(offline.trimEnd().split('\n').at(-1)?.startsWith('claude -p')).toBe(true)
})
