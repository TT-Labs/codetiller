import type { Config } from '../config/config.js'
import type { Sandbox } from '../sandbox/sandbox.js'

export type AgentExit = 'ok' | 'error' | 'timeout' | 'budget'

export interface AgentResult {
  exit: AgentExit
  cost_usd: number | null
  /** `gateway` = counted by the model gateway from the API's answers; `reported` = the agent's own figure */
  cost_source: 'reported' | 'computed' | 'gateway'
  /** what the agent itself reported, kept when the gateway's count replaced it */
  agent_cost_usd?: number | null
  input_tokens?: number
  output_tokens?: number
  turns?: number
  duration_s: number
  harness_version?: string
  transcript: string // raw JSONL
  finalText?: string // agent's final message
  stderr?: string
  session_id?: string // harness session, for resuming later (factory)
}

export interface AgentRunInput {
  sandbox: Sandbox
  image: string
  workspace: string // host path, mounted at /workspace
  promptFile: string // host path, mounted read-only at /tiller/prompt.md
  setup?: string // repo setup (deps install) before the agent starts
  volumes?: { name: string; container: string; readonly?: boolean }[]
  tmpfs?: string[]
  config: Config
  env: Record<string, string>
  /** docker network for the agent container (the model gateway's internal network); default: bridge */
  network?: string
  /** no route to the internet: set up the tools so they fail or work at once instead of waiting */
  offline?: boolean
  /** host dir persisted across runs of one work item (harness config + sessions) */
  stateDir?: string
  /** assessment run: workspace mounted read-only, no editing tools */
  readOnly?: boolean
  /** continue this harness session instead of starting fresh */
  resumeSession?: string
  /** live transcript chunks (dashboard follows a running agent) */
  onStdout?: (chunk: string) => void
}

/** Harness-specific headless invocation + result parsing. */
export interface AgentAdapter {
  readonly harness: Config['harness']
  run(input: AgentRunInput): Promise<AgentResult>
}
