import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse } from 'yaml'
import type { Skill } from './context.js'

/** `name@N` → skills/<name>/v<N>.md, frontmatter stripped. */
export async function loadSkill(skillsDir: string, ref: string): Promise<Skill> {
  const m = /^([a-z0-9-]+)@(\d+)$/.exec(ref)
  if (!m?.[1] || !m[2]) throw new Error(`bad skill ref ${ref} (expected name@N)`)
  const raw = await readFile(join(skillsDir, m[1], `v${m[2]}.md`), 'utf8')
  const fm = /^---\n([\s\S]*?)\n---\n?/.exec(raw)
  const meta = fm?.[1] ? (parse(fm[1]) as Record<string, unknown>) : {}
  return {
    name: String(meta.name ?? m[1]),
    version: Number(m[2]),
    body: raw.slice(fm?.[0].length ?? 0),
  }
}

/** Context file each harness reads (inline, same content for both). */
export const contextFileFor = (harness: string) => (harness === 'codex' ? 'AGENTS.md' : 'CLAUDE.md')
