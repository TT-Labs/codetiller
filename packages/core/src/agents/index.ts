import type { Config } from '../config/config.js'
import type { AgentAdapter } from './agent.js'
import { ClaudeCodeAdapter } from './claude-code.js'
import { CodexAdapter } from './codex.js'

export * from './agent.js'
export { ClaudeCodeAdapter, parseClaudeStream } from './claude-code.js'
export { CodexAdapter } from './codex.js'

export function adapterFor(harness: Config['harness']): AgentAdapter {
  return harness === 'claude-code' ? new ClaudeCodeAdapter() : new CodexAdapter()
}
