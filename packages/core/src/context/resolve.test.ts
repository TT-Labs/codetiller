import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { renderContext } from './context.js'
import { repoSkill, resolveSkills } from './resolve.js'

function skillsDir(skills: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'tiller-skills-'))
  for (const [ref, body] of Object.entries(skills)) {
    const [name, v] = ref.split('@')
    mkdirSync(join(dir, name as string), { recursive: true })
    writeFileSync(join(dir, name as string, `v${v}.md`), `---\nname: ${name}\n---\n${body}`)
  }
  return dir
}

it('orders built-in, repository, config; a later level replaces the same name', async () => {
  const dir = skillsDir({ 'git@1': 'factory git', 'testing@2': 'factory testing', 'zod@1': 'zod' })
  const skills = await resolveSkills({
    skillsDir: dir,
    builtin: ['git@1', 'testing@2'],
    repo: [
      { path: '.factory/skills/testing.md', text: '---\nname: testing\n---\nrun `make test`\n' },
      { path: '.factory/skills/layout.md', text: 'apps/api is Go\n' },
    ],
    config: ['zod@1'],
  })
  expect(skills.map((s) => [s.source, s.name, s.ref])).toEqual([
    ['builtin', 'git', 'git@1'],
    ['repo', 'layout', '.factory/skills/layout.md'],
    // the repository's `testing` replaces the factory's
    ['repo', 'testing', '.factory/skills/testing.md'],
    ['config', 'zod', 'zod@1'],
  ])
  expect(skills[2]?.body).toBe('run `make test`\n')
  expect(skills[2]?.sha256).toMatch(/^[0-9a-f]{64}$/)
  expect(skills[2]?.tokens).toBeGreaterThan(0)
})

it('renders a repository skill without a version; factory skills render as before', async () => {
  const repo = repoSkill({ path: '.factory/skills/layout.md', text: 'apps/api is Go' })
  const [zod] = await resolveSkills({
    skillsDir: skillsDir({ 'zod@3': 'zod facts' }),
    builtin: [],
    repo: [],
    config: ['zod@3'],
  })
  expect(renderContext(undefined, [repo, zod as typeof repo])).toBe(
    '## Skill: layout (repo)\n\napps/api is Go\n\n## Skill: zod (v3)\n\nzod facts\n',
  )
})

it('a missing factory skill is an error, not a silently thinner context', async () => {
  await expect(
    resolveSkills({ skillsDir: skillsDir({}), builtin: ['nope@1'], repo: [], config: [] }),
  ).rejects.toThrow()
})
