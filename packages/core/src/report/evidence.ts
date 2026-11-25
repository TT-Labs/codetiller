import type { Comparison, MetricDelta } from './compare.js'
import { againstReference, holds, type Recommendation } from './report.js'

export interface EvidenceSide {
  /** benchmark id */
  id: string
  config: string | null
  model: string
  skills: string[]
}

export interface EvidenceInput {
  dataset: string
  split: string
  /** baseline */
  a: EvidenceSide
  /** candidate */
  b: EvidenceSide
  comparison: Comparison
  /** the same comparison without tasks labelled underspecified; null when none is labelled */
  solvable?: Comparison | null
  /**
   * The candidate against a fixed reference (the config from before any promotion): what keeps
   * a chain of promotions from adding up losses each comparison was too noisy to see.
   */
  reference?: { side: EvidenceSide; comparison: Comparison }
}

/** The gate's verdict: the promote rule, and not below the reference by more than rerun noise. */
export function gateVerdict(e: Pick<EvidenceInput, 'comparison' | 'reference'>): Recommendation {
  const rule = { verdict: e.comparison.recommendation, reason: e.comparison.reason }
  return e.reference ? againstReference(rule, e.reference.comparison) : rule
}

const pct = (x: number) => `${(x * 100).toFixed(1)} %`
const pp = (x: number) => `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(1)}`
const num = (x: number) =>
  Math.abs(x) >= 100 ? x.toFixed(0) : Math.abs(x) >= 10 ? x.toFixed(1) : x.toFixed(3)
const signed = (x: number) => `${x >= 0 ? '+' : '−'}${num(Math.abs(x))}`
const yes = (b: boolean) => (b ? '**yes**' : 'no')

// what a reviewer of a skill change reads first; the rest of the per-run metrics follow
const NAMES: Record<string, string> = {
  cost_usd: 'cost per run ($)',
  duration_s: 'duration per run (s)',
  turns: 'turns',
  output_tokens: 'output tokens',
  diff_lines: 'diff lines',
  f2p_share: 'hidden tests fixed (share)',
  regressions: 'regressions (tests broken)',
  tool_calls: 'tool calls',
  tool_errors: 'tool errors',
  test_runs: 'test runs',
  missing_commands: 'missing commands',
}

const successRow = (label: string, c: Comparison) => {
  const n = (side: Comparison['a']) => `${Math.round(side.successRate * side.runs)}/${side.runs}`
  const noise = c.noise === null ? 'n/a' : `±${(c.noise * 100).toFixed(1)}`
  return `| ${label} | ${pct(c.a.successRate)} (${n(c.a)}) | ${pct(c.b.successRate)} (${n(c.b)}) | ${pp(c.delta.mean)} pp | ${pp(c.delta.lo)} … ${pp(c.delta.hi)} | ${noise} | ${yes(holds(c))} |`
}

const metricRow = (m: MetricDelta) =>
  `| ${NAMES[m.name] ?? m.name} | ${num(m.a)} | ${num(m.b)} | ${signed(m.delta.mean)} | ${signed(m.delta.lo)} … ${signed(m.delta.hi)} | ${m.noise === null ? 'n/a' : `±${num(m.noise)}`} | ${yes(holds(m))} |`

const side = (s: EvidenceSide) =>
  `\`${s.id}\` · config \`${s.config ?? '?'}\` · ${s.model} · skills: ${s.skills.length ? s.skills.map((x) => `\`${x}\``).join(', ') : 'none'}`

/**
 * The evidence a skill or config change ships with, as markdown for the PR. Every
 * delta carries its CI over tasks and rerun noise; "holds" = both say it is real. The verdict is
 * the promote rule's; the human reviewing the PR decides.
 */
export function renderEvidence(e: EvidenceInput): string {
  const c = e.comparison
  const list = (ids: string[]) => (ids.length ? ids.map((t) => `\`${t}\``).join(', ') : 'none')
  const verdict = gateVerdict(e)
  return [
    `## Eval evidence`,
    `**${verdict.verdict}** — ${verdict.reason}.`,
    `Dataset \`${e.dataset}\` (split ${e.split}) · ${c.tasks} paired tasks · ${c.a.runs} baseline runs, ${c.b.runs} candidate runs.`,
    [
      '| | baseline | candidate | Δ | 95 % CI over tasks | rerun noise | holds |',
      '|---|---|---|---|---|---|---|',
      successRow('success', c),
      ...(e.solvable && e.solvable.tasks < c.tasks
        ? [successRow(`success, ${e.solvable.tasks} tasks solvable from the issue`, e.solvable)]
        : []),
      ...(e.reference
        ? [successRow('success, reference → candidate', e.reference.comparison)]
        : []),
      ...c.metrics.map(metricRow),
    ].join('\n'),
    `Tasks improved: ${list(c.improved)}\nTasks worse: ${list(c.worse)}`,
    `Baseline: ${side(e.a)}\nCandidate: ${side(e.b)}${e.reference ? `\nReference: ${side(e.reference.side)}` : ''}`,
    'A delta holds when its CI over tasks excludes 0 and it exceeds rerun noise (what the same two configs give when they do not differ). Rule: promote if the success gain holds, or there is no detectable loss of success (the delta is not below zero by more than rerun noise) and cost per success or duration per run drops by 15 % or more with that drop holding.',
    e.reference
      ? 'The candidate is also held against the reference with the same band, so that promotions cannot add up losses none of them could see.'
      : 'No reference was given: a loss that adds up over several promotions is not checked here (`--reference <benchmark>`).',
  ].join('\n\n')
}
