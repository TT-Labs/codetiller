import Anthropic from '@anthropic-ai/sdk'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import { z } from 'zod'

/**
 * Failed train runs → per-run labels → clusters → proposed skill v<N+1>.
 * Never auto-promotes; output = files + improve-report.md for review, then holdout compare decides.
 */

export const FailureLabelSchema = z.object({
  cluster: z.string().describe('short kebab-case slug, e.g. wrong-default-behaviour'),
  root_cause: z
    .string()
    .describe('one or two sentences: why the agent patch fails the hidden tests'),
  would_context_have_helped: z.enum(['yes', 'no', 'maybe']),
  missing_knowledge: z
    .string()
    .describe('general, reusable repo knowledge that would have prevented this; empty if none'),
})

export type FailureLabel = z.infer<typeof FailureLabelSchema> & { run_id: string; task_id: string }

export const ProposalSchema = z.object({
  clusters: z.array(
    z.object({
      slug: z.string(),
      count: z.number(),
      summary: z.string(),
      addressed: z.boolean().describe('whether the new skill text addresses this cluster'),
    }),
  ),
  skill_markdown: z.string().describe('the complete new learned skill, markdown body only'),
})

export type Proposal = z.infer<typeof ProposalSchema>

export interface FailureEvidence {
  run_id: string
  task_id: string
  issue: string
  agent_diff: string
  reference_diff: string // fix_commit, non-test files — train data only
  failing_output: string
  agent_summary: string
}

export const IMPROVE_MODEL = 'claude-opus-5-5'

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n…[truncated]` : s)

export class Improver {
  constructor(
    readonly client = new Anthropic(),
    readonly model = IMPROVE_MODEL,
  ) {}

  async label(e: FailureEvidence, currentSkills: string): Promise<FailureLabel> {
    const response = await this.client.messages.parse({
      model: this.model,
      max_tokens: 16000,
      output_config: { effort: 'high', format: zodOutputFormat(FailureLabelSchema) },
      system:
        'You analyse why a coding agent failed a benchmark task in a specific repository. ' +
        'Compare the agent patch with the reference fix and the failing test output. ' +
        'Focus on what general, reusable knowledge about this repository (conventions, APIs, ' +
        'expected behaviours, testing practice) the agent lacked. Never restate the task-specific answer.',
      messages: [
        {
          role: 'user',
          content: [
            `<current_context_given_to_agent>\n${currentSkills || '(none)'}\n</current_context_given_to_agent>`,
            `<issue>\n${clip(e.issue, 8000)}\n</issue>`,
            `<agent_patch>\n${clip(e.agent_diff, 12000)}\n</agent_patch>`,
            `<reference_fix>\n${clip(e.reference_diff, 12000)}\n</reference_fix>`,
            `<failing_test_output>\n${clip(e.failing_output, 6000)}\n</failing_test_output>`,
            `<agent_final_message>\n${clip(e.agent_summary, 3000)}\n</agent_final_message>`,
          ].join('\n\n'),
        },
      ],
    })
    if (response.stop_reason === 'refusal' || !response.parsed_output) {
      throw new Error(`label failed for ${e.run_id}: stop_reason ${response.stop_reason}`)
    }
    return { ...response.parsed_output, run_id: e.run_id, task_id: e.task_id }
  }

  async propose(
    labels: FailureLabel[],
    currentSkills: string,
    opts: { repo: string; maxWords: number },
  ): Promise<Proposal> {
    const response = await this.client.messages.parse({
      model: this.model,
      max_tokens: 16000,
      output_config: { effort: 'high', format: zodOutputFormat(ProposalSchema) },
      system:
        `You maintain a short "learned" skill file that is appended to a coding agent's context ` +
        `when it fixes bugs in ${opts.repo}. You get failure analyses from past runs. ` +
        'Cluster them (merge near-duplicates), rank by count and by whether context could help, ' +
        'and write the learned skill.\n\nRules for skill_markdown:\n' +
        '- Generalizable rules only: repo conventions, API semantics, expected default behaviours, pitfalls, how to verify.\n' +
        '- NO task-specific answers: never name a specific bug, file+line, test name, or the exact fix of one task.\n' +
        "- Don't repeat what the current context already says.\n" +
        `- Hard limit ${opts.maxWords} words. Terse bullets under a few headings.`,
      messages: [
        {
          role: 'user',
          content: [
            `<current_context>\n${currentSkills || '(none)'}\n</current_context>`,
            `<failure_analyses>\n${JSON.stringify(labels, null, 2)}\n</failure_analyses>`,
          ].join('\n\n'),
        },
      ],
    })
    if (response.stop_reason === 'refusal' || !response.parsed_output) {
      throw new Error(`proposal failed: stop_reason ${response.stop_reason}`)
    }
    return response.parsed_output
  }
}

export const SanitizedSchema = z.object({
  removed: z.array(z.object({ task_id: z.string(), passage: z.string(), why: z.string() })),
  skill_markdown: z
    .string()
    .describe('the skill with task-specific passages removed or generalised'),
})

export type Sanitized = z.infer<typeof SanitizedSchema>

export interface SanitizeInput {
  task_id: string
  issue: string
  reference_diff: string
}

/**
 * Semantic leak guard: an identifier check misses rules that *describe* a specific fix
 * (hono-learned v1: "ETag only for safe methods + 2xx" = the answer to one train task).
 */
export async function sanitizeSkill(
  improver: { client: Anthropic; model: string },
  skill: string,
  tasks: SanitizeInput[],
): Promise<Sanitized> {
  const response = await improver.client.messages.parse({
    model: improver.model,
    max_tokens: 16000,
    output_config: { effort: 'high', format: zodOutputFormat(SanitizedSchema) },
    system:
      'You audit a learned skill file for a coding agent for leakage of benchmark answers. ' +
      'For each task you get its issue and its reference fix. A passage LEAKS if, read by an agent ' +
      'given only that issue, it would point directly at the specific fix (the exact condition, ' +
      'default, option, API or value changed) — rather than a general practice that helps across many tasks. ' +
      'Remove leaking passages, or generalise them so they no longer encode the specific fix. ' +
      'Keep everything else verbatim. Return the full cleaned skill.',
    messages: [
      {
        role: 'user',
        content: [
          `<skill>\n${skill}\n</skill>`,
          ...tasks.map(
            (t) =>
              `<task id="${t.task_id}">\n<issue>\n${clip(t.issue, 4000)}\n</issue>\n<reference_fix>\n${clip(t.reference_diff, 8000)}\n</reference_fix>\n</task>`,
          ),
        ].join('\n\n'),
      },
    ],
  })
  if (response.stop_reason === 'refusal' || !response.parsed_output) {
    throw new Error(`sanitize failed: stop_reason ${response.stop_reason}`)
  }
  return response.parsed_output
}

/**
 * Leakage guard: identifiers in the proposal that occur in exactly one train task's
 * reference fix and nowhere in that task's issue → likely a task-specific answer.
 */
export function leakWarnings(
  proposal: string,
  refs: { task_id: string; reference_diff: string; issue: string }[],
): string[] {
  const idents = new Set(
    [...proposal.matchAll(/`([^`\n]{3,60})`|\b([a-z]+[A-Z][A-Za-z0-9]{2,})\b/g)]
      .map((m) => (m[1] ?? m[2] ?? '').trim())
      .filter((s) => s.length >= 4),
  )
  const warnings: string[] = []
  for (const id of idents) {
    const hits = refs.filter((r) => addedLines(r.reference_diff).includes(id))
    if (hits.length === 1 && hits[0] && !hits[0].issue.includes(id)) {
      warnings.push(`\`${id}\` appears only in the reference fix of ${hits[0].task_id}`)
    }
  }
  return warnings
}

const addedLines = (diff: string) =>
  diff
    .split('\n')
    .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
    .join('\n')
