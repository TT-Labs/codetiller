export const pct = (x: number) => `${(x * 100).toFixed(1)}%`
export const pp = (x: number) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)} pp`
export const usd = (x: number | null | undefined, digits = 2) =>
  x === null || x === undefined ? '—' : `$${x.toFixed(digits)}`
export const signedPct = (x: number | null) =>
  x === null ? '—' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(0)}%`

export function duration(s: number | null | undefined) {
  if (s === null || s === undefined) return '—'
  const m = Math.floor(s / 60)
  return m ? `${m}m ${Math.round(s % 60)}s` : `${Math.round(s)}s`
}

/** time of day for today, date + time otherwise: a timeline that spans days stays readable */
export function when(iso: string) {
  const d = new Date(iso)
  const today = d.toDateString() === new Date().toDateString()
  // field options only: `timeStyle` cannot be combined with `month` / `day` (throws)
  return d.toLocaleString(undefined, {
    ...(today ? {} : { month: 'short', day: 'numeric' }),
    hour: 'numeric',
    minute: '2-digit',
  })
}

/** "12s ago", "5 min ago", "3 h ago", then the date */
export function ago(iso: string | null | undefined) {
  if (!iso) return 'never'
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.round(s / 60)} min ago`
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`
  return when(iso)
}

export const date = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—'

// SGR colour codes from test runners (ESC [ … m); ESC built at runtime to keep control characters
// out of the source
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[\\d;]*m`, 'g')

/** Terminal output as plain text for a log view. */
export const stripAnsi = (text: string) => text.replace(ANSI, '')

export const benchmarkLabel = (b: { name: string | null; id: string }) => b.name ?? b.id
