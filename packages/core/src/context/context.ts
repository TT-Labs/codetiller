/**
 * Render skills inline into CLAUDE.md / AGENTS.md.
 * Order: repo's own context file first, then skills in config order. Fail over token budget.
 */
// raised from ~1.5–2k: the generated onboarding skill alone is ~1.8k, a learned skill adds ≤500 words
export const CONTEXT_TOKEN_BUDGET = 3000

export interface Skill {
  name: string
  version: number
  body: string
  /** shown instead of the version for skills without one (repository skills: `repo`) */
  origin?: string
}

/** Rough estimate: ~4 chars / token. Good enough for a budget guard. */
export const estimateTokens = (s: string) => Math.ceil(s.length / 4)

export function renderContext(repoContext: string | undefined, skills: Skill[]): string {
  const skillText = skills
    .map((s) => `## Skill: ${s.name} (${s.origin ?? `v${s.version}`})\n\n${s.body.trim()}`)
    .join('\n\n')
  const tokens = estimateTokens(skillText)
  if (tokens > CONTEXT_TOKEN_BUDGET) {
    throw new Error(`skills exceed context budget: ~${tokens} > ${CONTEXT_TOKEN_BUDGET} tokens`)
  }
  return `${[repoContext?.trim(), skillText].filter(Boolean).join('\n\n')}\n`
}
