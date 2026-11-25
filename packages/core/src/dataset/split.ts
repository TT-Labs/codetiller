import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse } from 'yaml'

/** Deterministic PRNG (mulberry32) so splits and bootstrap CIs are reproducible. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Train/holdout split; improve learns only from train, promotion decided on holdout. */
export function splitTasks(ids: string[], holdout: number, seed: number) {
  const rand = seededRandom(seed)
  const shuffled = [...ids].sort()
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[shuffled[i], shuffled[j]] = [shuffled[j] as string, shuffled[i] as string]
  }
  const n = Math.round(ids.length * holdout)
  return { train: shuffled.slice(n).sort(), holdout: shuffled.slice(0, n).sort() }
}

export type Split = { train: string[]; holdout: string[] }

/** `datasets/<name>/split.yaml`; undefined when the dataset has no split yet. */
export async function loadSplit(datasetDir: string): Promise<Split | undefined> {
  const raw = await readFile(join(datasetDir, 'split.yaml'), 'utf8').catch(() => null)
  if (raw === null) return undefined
  const s = parse(raw) as Partial<Split>
  return { train: s.train ?? [], holdout: s.holdout ?? [] }
}
