import { parse } from 'yaml'
import { sha256 } from '../util/hash.js'
import { estimateTokens, type Skill } from './context.js'
import { loadSkill } from './skills.js'

/** Most general first: later levels are closer to the task. */
export type SkillSource = 'builtin' | 'repo' | 'config'

export interface ResolvedSkill extends Skill {
  source: SkillSource
  /** `name@N` for factory skills, the repo path for repository skills */
  ref: string
  /** of the rendered body: what the agent actually read */
  sha256: string
  tokens: number
}

export interface RepoSkillFile {
  /** repo-relative path, e.g. `.factory/skills/testing.md` */
  path: string
  text: string
}

/** where a target repo keeps its own skills */
export const REPO_SKILLS_DIR = '.factory/skills'

const resolved = (skill: Skill, source: SkillSource, ref: string): ResolvedSkill => ({
  ...skill,
  source,
  ref,
  sha256: sha256(skill.body),
  tokens: estimateTokens(skill.body),
})

/** `.factory/skills/<name>.md`: optional frontmatter (`name`) stripped, the rest is the skill. */
export function repoSkill(file: RepoSkillFile): ResolvedSkill {
  const fm = /^---\n([\s\S]*?)\n---\n?/.exec(file.text)
  const meta = fm?.[1] ? ((parse(fm[1]) as Record<string, unknown> | null) ?? {}) : {}
  const name = String(meta.name ?? file.path.replace(/^.*\//, '').replace(/\.md$/, ''))
  // a repo skill has no version of its own: it is pinned by the commit it was read at
  const skill = { name, version: 0, origin: 'repo', body: file.text.slice(fm?.[0].length ?? 0) }
  return resolved(skill, 'repo', file.path)
}

/**
 * The skills of one run in render order: factory built-ins, then the repository's own
 * (`.factory/skills/*.md`, sorted by path), then the config's. A name that appears again at a
 * later level replaces the earlier one: the level closer to the task knows better.
 */
export async function resolveSkills(input: {
  /** factory skills dir: `<name>/v<N>.md` */
  skillsDir: string
  /** refs enabled for every task (tiller.yaml `factory.skills`) */
  builtin: string[]
  /** read from the trusted git dir at the task's base commit, never from the agent's workspace */
  repo: RepoSkillFile[]
  /** refs of the task's config */
  config: string[]
}): Promise<ResolvedSkill[]> {
  const load = (source: SkillSource) => async (ref: string) =>
    resolved(await loadSkill(input.skillsDir, ref), source, ref)
  const all = [
    ...(await Promise.all(input.builtin.map(load('builtin')))),
    ...[...input.repo].sort((a, b) => a.path.localeCompare(b.path)).map(repoSkill),
    ...(await Promise.all(input.config.map(load('config')))),
  ]
  const last = new Map(all.map((s, i) => [s.name, i]))
  return all.filter((s, i) => last.get(s.name) === i)
}
