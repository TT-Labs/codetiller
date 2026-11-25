/** Paired bootstrap CI over per-task success deltas. */
export function pairedBootstrapCI(
  deltas: number[],
  iterations = 10_000,
  alpha = 0.05,
  rand: () => number = Math.random,
): { mean: number; lo: number; hi: number } {
  const n = deltas.length
  if (n === 0) return { mean: 0, lo: 0, hi: 0 }
  const mean = deltas.reduce((a, b) => a + b, 0) / n
  const means: number[] = []
  for (let i = 0; i < iterations; i++) {
    let s = 0
    for (let j = 0; j < n; j++) s += deltas[Math.floor(rand() * n)] ?? 0
    means.push(s / n)
  }
  means.sort((a, b) => a - b)
  const at = (q: number) => means[Math.min(iterations - 1, Math.floor(q * iterations))] ?? mean
  return { mean, lo: at(alpha / 2), hi: at(1 - alpha / 2) }
}

export interface Delta {
  delta: { mean: number; lo: number; hi: number }
  /** 95 % half-width if the configs did not differ */
  noise: number | null
}

/** A delta holds when it carries across tasks (CI excludes 0) and exceeds what a rerun gives. */
export const holds = (d: Delta) =>
  (d.delta.lo > 0 || d.delta.hi < 0) && d.noise !== null && Math.abs(d.delta.mean) > d.noise

/** a per-run quantity (cost, duration) on both sides: `a` is the baseline mean */
export interface Quantity extends Delta {
  a: number
}

export interface Recommendation {
  verdict: 'PROMOTE' | 'KEEP'
  /** which branch of the rule decided, with its numbers: goes into the PR evidence */
  reason: string
}

/** a drop this large (relative to the baseline) is worth promoting on, if it holds */
const WORTHWHILE_DROP = 0.15

const pp = (x: number) => `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(1)} pp`
const rel = (x: number) => `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(0)} %`

/** a comparison whose rerun noise is wider than this cannot call a negative delta "no loss" */
const WIDEST_BAND = 0.1

/**
 * No detectable loss: the success delta is not below zero by more than what a rerun of the same
 * two configs gives. A delta inside that band is one run more or less, not a loss anyone measured.
 * The band only counts while it is narrow (at most 10 pp): a comparison too noisy to see a large
 * loss cannot vouch that there is none. Without a noise estimate, or with a wide one, only a
 * delta that is not negative counts.
 */
export const noDetectableLoss = (d: Delta) =>
  d.delta.mean >= 0 || (d.noise !== null && d.noise <= WIDEST_BAND && d.delta.mean >= -d.noise)

/** a negative delta the comparison is too noisy to judge */
const tooNoisy = (d: Delta) => d.delta.mean < 0 && (d.noise === null || d.noise > WIDEST_BAND)

/** the success delta with what it can and cannot say: its noise band and the loss it could hide */
function successNote(d: Delta): string {
  const noise =
    d.noise === null ? 'rerun noise unknown' : `rerun noise ±${(d.noise * 100).toFixed(1)} pp`
  // the low end of the CI over tasks: how large a loss these data cannot rule out
  const hidden =
    d.delta.lo < 0
      ? `; a loss of up to ${(Math.abs(d.delta.lo) * 100).toFixed(1)} pp cannot be ruled out`
      : ''
  return `success ${pp(d.delta.mean)} (${noise}${hidden})`
}

/**
 * PROMOTE if the success gain holds, or there is no detectable loss of success and the config is
 * cheaper or faster: cost per success ≤ −15 % with the drop in cost per run itself holding, or
 * duration per run ≤ −15 % with that drop holding. A promotion on cost or time says how large a
 * loss of success the data could still hide.
 */
export function recommend(input: {
  success: Delta
  costPerSuccessDelta: number | null
  cost?: Quantity
  duration?: Quantity
}): Recommendation {
  const { success, costPerSuccessDelta, cost, duration } = input
  if (success.delta.mean > 0 && holds(success))
    return {
      verdict: 'PROMOTE',
      reason: `success gain holds: ${pp(success.delta.mean)}, across tasks and beyond rerun noise`,
    }
  const noLoss = noDetectableLoss(success)
  if (
    noLoss &&
    costPerSuccessDelta !== null &&
    costPerSuccessDelta <= -WORTHWHILE_DROP &&
    cost !== undefined &&
    cost.delta.mean < 0 &&
    holds(cost)
  )
    return {
      verdict: 'PROMOTE',
      reason: `cheaper at no detectable loss of success: cost per success ${rel(costPerSuccessDelta)}, and the drop in cost per run holds; ${successNote(success)}`,
    }
  const faster = duration && duration.a > 0 ? duration.delta.mean / duration.a : 0
  if (noLoss && duration !== undefined && faster <= -WORTHWHILE_DROP && holds(duration))
    return {
      verdict: 'PROMOTE',
      reason: `faster at no detectable loss of success: duration per run ${rel(faster)}, across tasks and beyond rerun noise; ${successNote(success)}`,
    }
  return {
    verdict: 'KEEP',
    reason: noLoss
      ? `${successNote(success)} does not hold as a gain, and no cost or time drop of 15 % holds`
      : tooNoisy(success)
        ? `${successNote(success)} cannot be told from a loss: the comparison is too noisy to promote on cost or time (rerun noise must be within ±${WIDEST_BAND * 100} pp; add repeats)`
        : `${successNote(success)} is a loss beyond rerun noise; cost or time count only at no detectable loss of success`,
  }
}

/**
 * Promotions add up: each may hide a loss inside its own noise, and a chain of them can lose
 * what no single comparison saw. So a candidate is also held against a fixed reference (the
 * config from before any promotion), with the same band: not below it by more than rerun noise.
 */
export function againstReference(rule: Recommendation, reference: Delta): Recommendation {
  if (rule.verdict !== 'PROMOTE' || noDetectableLoss(reference)) return rule
  return {
    verdict: 'KEEP',
    reason: `against the reference: ${successNote(reference)} ${tooNoisy(reference) ? 'cannot be told from a loss' : 'is a loss beyond rerun noise'}, although against the baseline: ${rule.reason}`,
  }
}
