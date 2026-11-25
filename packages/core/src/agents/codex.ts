import type { AgentAdapter, AgentResult, AgentRunInput } from './agent.js'

/** Not built yet: codex exec --json; cost = tokens × price table. */
export class CodexAdapter implements AgentAdapter {
  readonly harness = 'codex' as const

  run(_input: AgentRunInput): Promise<AgentResult> {
    throw new Error('CodexAdapter not implemented yet')
  }
}
