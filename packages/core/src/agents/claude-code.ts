import type { ExecRequest } from '../sandbox/sandbox.js'
import type { AgentAdapter, AgentResult, AgentRunInput } from './agent.js'

interface ResultEvent {
  type: 'result'
  result?: string
  is_error?: boolean
  subtype?: string
  total_cost_usd?: number
  num_turns?: number
  usage?: { input_tokens?: number; output_tokens?: number }
  session_id?: string
}

/** Parse Claude Code stream-json transcript; final `result` event carries cost/turns. */
export function parseClaudeStream(transcript: string): ResultEvent | undefined {
  const lines = transcript.trim().split('\n').reverse()
  for (const line of lines) {
    try {
      const ev = JSON.parse(line) as { type?: string }
      if (ev.type === 'result') return ev as ResultEvent
    } catch {
      // non-JSON noise
    }
  }
  return undefined
}

const STATE_DIR = '/tiller/claude'

/**
 * Shell lines run before the agent in a container without internet. pnpm otherwise tries to fetch
 * the version a repo pins and to check the lockfile against the registry, and waits 70 s per call
 * before giving up (measured: vanilla zod runs 50 % slower). A wrapper earlier in PATH passes the
 * two settings that stop both; they are honoured as flags, not as environment variables. Done at
 * start instead of in the image so every image gets it, and the dependency install (which has
 * the network and should use the pinned version) does not.
 */
export const OFFLINE_PRELUDE = [
  'tiller_pnpm=$(command -v pnpm || true)',
  'if [ -n "$tiller_pnpm" ]; then',
  '  mkdir -p /tmp/tiller-bin',
  `  printf '#!/bin/sh\\nexec %s --pm-on-fail=ignore --config.verify-deps-before-run=false "$@"\\n' "$tiller_pnpm" > /tmp/tiller-bin/pnpm`,
  '  chmod +x /tmp/tiller-bin/pnpm',
  '  export PATH=/tmp/tiller-bin:$PATH',
  'fi',
].join('\n')

export class ClaudeCodeAdapter implements AgentAdapter {
  readonly harness = 'claude-code' as const

  /**
   * The container an agent runs in. Public so the sandbox audit can run its probes in exactly
   * this configuration (same mounts, env, network, limits) with a different command.
   */
  request(input: AgentRunInput): ExecRequest {
    const { image, workspace, promptFile, setup, volumes, tmpfs, config, env } = input
    const { stateDir, resumeSession, onStdout, readOnly, network } = input
    if (resumeSession && !/^[A-Za-z0-9-]+$/.test(resumeSession))
      throw new Error(`bad session id ${resumeSession}`)
    // TODO verify flags against pinned CLI version
    const claude = [
      'claude -p "$(cat /tiller/prompt.md)"',
      '--output-format stream-json --verbose',
      `--model ${config.model}`,
      `--max-turns ${config.limits.max_turns}`,
      '--dangerously-skip-permissions',
      // no web lookups: the fix is public on GitHub (benchmark leak). The network itself is
      // closed by the model gateway; this keeps the agent from trying.
      `--disallowedTools WebFetch WebSearch${readOnly ? ' Edit Write NotebookEdit' : ''}`,
      ...(resumeSession ? [`--resume ${resumeSession}`] : []),
    ].join(' ')
    const steps = [
      ...(input.offline ? [OFFLINE_PRELUDE] : []),
      ...(setup ? [`${setup} >/dev/null 2>&1`] : []),
      claude,
    ]
    const script = steps.join('\n')
    return {
      image,
      cmd: ['sh', '-c', script],
      mounts: [
        { host: workspace, container: '/workspace', readonly: readOnly },
        { host: promptFile, container: '/tiller/prompt.md', readonly: true },
        // sessions live in the config dir: persisted per work item so `--resume` works next run
        ...(stateDir ? [{ host: stateDir, container: STATE_DIR }] : []),
      ],
      volumes,
      tmpfs,
      workdir: '/workspace',
      env: stateDir ? { ...env, CLAUDE_CONFIG_DIR: STATE_DIR } : env,
      network,
      limits: { timeout_s: config.limits.timeout_s },
      onStdout,
    }
  }

  async run(input: AgentRunInput): Promise<AgentResult> {
    const res = await input.sandbox.exec(this.request(input))
    const ev = parseClaudeStream(res.stdout)
    const exit = res.timedOut
      ? 'timeout'
      : ev?.subtype === 'error_max_budget_usd'
        ? 'budget'
        : !ev || ev.is_error || res.exitCode !== 0
          ? 'error'
          : 'ok'
    return {
      exit,
      cost_usd: ev?.total_cost_usd ?? null,
      cost_source: 'reported',
      input_tokens: ev?.usage?.input_tokens,
      output_tokens: ev?.usage?.output_tokens,
      turns: ev?.num_turns,
      duration_s: res.duration_s,
      transcript: res.stdout,
      finalText: ev?.result,
      stderr: res.stderr,
      session_id: ev?.session_id,
    }
  }
}
