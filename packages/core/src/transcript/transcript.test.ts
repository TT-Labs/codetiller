import { describe, expect, it } from 'vitest'
import { parseClaudeCodeTranscript, parseTranscript } from './transcript.js'

const lines = [
  {
    type: 'system',
    subtype: 'init',
    model: 'claude-sonnet-5-5',
    tools: ['Bash'],
    cwd: '/workspace',
  },
  { type: 'system', subtype: 'thinking_tokens', estimated_tokens: 50 },
  {
    type: 'assistant',
    message: {
      content: [
        { type: 'thinking', thinking: '' },
        { type: 'text', text: 'Looking at the code.' },
        { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
      ],
    },
  },
  { type: 'tool_progress', tool_use_id: 't1-heartbeat-0' },
  {
    type: 'user',
    message: {
      content: [
        { type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'a.ts' }] },
      ],
    },
  },
  { type: 'result', subtype: 'success', result: 'Done', total_cost_usd: 0.12, num_turns: 3 },
]
const raw = `${lines.map((l) => JSON.stringify(l)).join('\n')}\nnot json\n`

describe('parseClaudeCodeTranscript', () => {
  it('maps stream-json to events, dropping noise and empty thinking', () => {
    expect(parseClaudeCodeTranscript(raw)).toEqual([
      {
        kind: 'init',
        model: 'claude-sonnet-5-5',
        tools: ['Bash'],
        cwd: '/workspace',
        session_id: undefined,
      },
      { kind: 'text', role: 'assistant', text: 'Looking at the code.' },
      { kind: 'tool_call', id: 't1', name: 'Bash', input: { command: 'ls' } },
      { kind: 'tool_result', id: 't1', output: 'a.ts', is_error: false },
      {
        kind: 'result',
        ok: true,
        text: 'Done',
        cost_usd: 0.12,
        turns: 3,
        duration_ms: undefined,
        usage: undefined,
      },
    ])
  })

  it('rejects harnesses without a parser', () => {
    expect(() => parseTranscript('codex', raw)).toThrow(/no transcript parser/)
  })
})
