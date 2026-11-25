import type { SearchEntry } from './docs'

export interface SearchHit extends SearchEntry {
  /** a piece of the text around the first word found, when the match is in the text */
  snippet: string
}

const norm = (s: string) => s.toLowerCase()

/**
 * Every word of the query has to be somewhere in an entry; where it is decides the order:
 * page title, then heading, then text. Small and exact on purpose: the index is a few
 * hundred sections.
 */
export function search(index: SearchEntry[], query: string, limit = 12): SearchHit[] {
  const terms = norm(query).split(/\s+/).filter(Boolean)
  if (!terms.length) return []
  const hits: { score: number; hit: SearchHit }[] = []
  for (const entry of index) {
    const page = norm(entry.page)
    const heading = norm(entry.heading ?? '')
    const text = norm(entry.text)
    let score = 0
    let first = -1
    for (const term of terms) {
      const inPage = page.indexOf(term)
      const inHeading = heading.indexOf(term)
      const inText = text.indexOf(term)
      if (inPage < 0 && inHeading < 0 && inText < 0) {
        score = 0
        break
      }
      if (inHeading >= 0) score += inHeading === 0 ? 12 : 8
      // the page's own entry (no heading) is the best answer to its title
      if (inPage >= 0) score += entry.heading ? 3 : inPage === 0 ? 14 : 9
      if (inText >= 0) {
        score += 1
        if (first < 0) first = inText
      }
    }
    if (!score) continue
    const from = Math.max(0, first - 40)
    const snippet =
      (from > 0 ? '…' : '') +
      entry.text.slice(from, from + 150).trim() +
      (entry.text.length > from + 150 ? '…' : '')
    hits.push({ score, hit: { ...entry, snippet } })
  }
  return hits
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((h) => h.hit)
}
