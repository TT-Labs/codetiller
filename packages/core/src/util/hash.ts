import { createHash } from 'node:crypto'

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

/** Stable JSON (sorted keys) so the hash doesn't depend on key order. */
export function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`
  if (v && typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>)
      .filter(([, x]) => x !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
    return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${stableStringify(x)}`).join(',')}}`
  }
  return JSON.stringify(v)
}
