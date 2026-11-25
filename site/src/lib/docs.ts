import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import GithubSlugger from 'github-slugger'
import matter from 'gray-matter'
import { cache } from 'react'
import { type NavGroup, nav } from '../../content/docs/nav'
import { routing } from '../i18n/routing'

const ROOT = path.join(process.cwd(), 'content', 'docs')

export interface TocItem {
  depth: 2 | 3
  text: string
  id: string
}

export interface Doc {
  slug: string
  /** address of the page without the locale: /docs or /docs/<slug> */
  href: string
  title: string
  description: string
  /** MDX without the frontmatter */
  body: string
  toc: TocItem[]
  /** `<locale>/<slug>.mdx`, for the edit link */
  file: string
}

export const SLUGS: string[] = nav.flatMap((g) => [...g.pages])

export const hrefOf = (slug: string) => (slug === 'index' ? '/docs' : `/docs/${slug}`)

/** heading text as a reader sees it: no backticks, emphasis or link targets */
const plain = (md: string) =>
  md
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[`*_]/g, '')
    .trim()

interface Block {
  heading: { depth: 2 | 3; text: string; id: string } | null
  lines: string[]
}

/**
 * The page cut at its `##` / `###` headings (not those inside code fences). Code stays in the
 * lines of its block, without the fence markers: commands are what people search for.
 */
function blocks(body: string): Block[] {
  const slugger = new GithubSlugger()
  const out: Block[] = [{ heading: null, lines: [] }]
  let fence: string | null = null
  for (const line of body.split('\n')) {
    const mark = line.match(/^\s*(```+|~~~+)/)?.[1]
    if (mark) {
      if (!fence) fence = mark
      else if (mark.startsWith(fence)) fence = null
      continue
    }
    const h = fence ? null : line.match(/^(#{2,3})\s+(.+?)\s*$/)
    if (h?.[1] && h[2]) {
      const text = plain(h[2])
      out.push({
        heading: { depth: h[1].length as 2 | 3, text, id: slugger.slug(text) },
        lines: [],
      })
    } else out.at(-1)?.lines.push(line)
  }
  return out
}

export const loadDoc = cache(async (locale: string, slug: string): Promise<Doc | null> => {
  if (!SLUGS.includes(slug)) return null
  // a page without a translation is shown in the default language
  for (const lang of new Set([locale, routing.defaultLocale])) {
    const raw = await readFile(path.join(ROOT, lang, `${slug}.mdx`), 'utf8').catch(() => null)
    if (raw === null) continue
    const { data, content } = matter(raw)
    return {
      slug,
      href: hrefOf(slug),
      title: String(data.title ?? slug),
      description: String(data.description ?? ''),
      body: content,
      toc: blocks(content).flatMap((b) => (b.heading ? [b.heading] : [])),
      file: `${lang}/${slug}.mdx`,
    }
  }
  return null
})

export interface NavEntry {
  group: NavGroup
  pages: { slug: string; href: string; title: string }[]
}

/** The sidebar with the titles of the pages; throws when nav.ts and the files disagree. */
export const loadNav = cache(async (locale: string): Promise<NavEntry[]> => {
  const files = (await readdir(path.join(ROOT, routing.defaultLocale)))
    .filter((f) => f.endsWith('.mdx'))
    .map((f) => f.slice(0, -4))
  const unlisted = files.filter((f) => !SLUGS.includes(f))
  if (unlisted.length)
    throw new Error(`docs pages missing from content/docs/nav.ts: ${unlisted.join(', ')}`)
  return Promise.all(
    nav.map(async (g) => ({
      group: g.group,
      pages: await Promise.all(
        g.pages.map(async (slug) => {
          const doc = await loadDoc(locale, slug)
          if (!doc) throw new Error(`content/docs/nav.ts lists "${slug}", which has no .mdx file`)
          return { slug, href: doc.href, title: doc.title }
        }),
      ),
    })),
  )
})

export async function neighbours(locale: string, slug: string) {
  const pages = (await loadNav(locale)).flatMap((g) => g.pages)
  const i = pages.findIndex((p) => p.slug === slug)
  return { previous: pages[i - 1] ?? null, next: pages[i + 1] ?? null }
}

export interface SearchEntry {
  href: string
  page: string
  heading: string | null
  text: string
}

/** markdown reduced to the words a search should find */
const words = (lines: string[]) =>
  lines
    .map((line) => line.replace(/^\s*(?:[-*+]|\d+\.)\s+/, ''))
    .join(' ')
    .replace(/<\/?[A-Za-z][^>]*>/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`]/g, '')
    .replace(/[|>#]/g, ' ')
    .replace(/-{3,}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

/** One entry per section of every page: what the search palette looks through. */
export async function searchIndex(locale: string): Promise<SearchEntry[]> {
  const docs = await Promise.all(SLUGS.map((slug) => loadDoc(locale, slug)))
  return docs.flatMap((doc) => {
    if (!doc) return []
    return blocks(doc.body).map((b) => ({
      href: b.heading ? `${doc.href}#${b.heading.id}` : doc.href,
      page: doc.title,
      heading: b.heading?.text ?? null,
      text: b.heading ? words(b.lines) : `${doc.description} ${words(b.lines)}`.trim(),
    }))
  })
}
