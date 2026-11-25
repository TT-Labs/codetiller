import { lstat, readFile, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { renderContext, type Skill } from './context.js'

export interface ContextOverlay {
  /** what the agent sees in its context file ('' = no skills, nothing written) */
  rendered: string
  /** put the workspace back exactly as it was before the overlay */
  restore(): Promise<void>
}

/**
 * Put the skills into the harness context file for one agent run, repo's own content first.
 *
 * The file is often a symlink (`CLAUDE.md -> AGENTS.md`). Writing through it would edit the target,
 * which then shows up in the agent's diff, and a link pointing outside the workspace would make the
 * host read or write an arbitrary file. So a link is never followed for writing: it is replaced by a
 * regular file for the run and recreated afterwards; its target is read only when it resolves
 * inside the workspace.
 */
export async function overlayContext(
  ws: string,
  contextFile: string,
  skills: Skill[],
): Promise<ContextOverlay> {
  if (!skills.length) return { rendered: '', restore: async () => {} }
  const path = join(ws, contextFile)
  const stat = await lstat(path).catch(() => null)
  let own: string | null = null
  let link: string | null = null
  if (stat?.isSymbolicLink()) {
    link = await readlink(path)
    const root = await realpath(ws)
    const target = await realpath(path).catch(() => null)
    if (target?.startsWith(root + sep)) own = await readFile(target, 'utf8').catch(() => null)
    await rm(path)
  } else if (stat?.isFile()) {
    own = await readFile(path, 'utf8')
  }
  const rendered = renderContext(own ?? undefined, skills)
  await writeFile(path, rendered)
  return {
    rendered,
    restore: async () => {
      // whatever the agent left at this path (file, link, directory) goes; never write through it
      await rm(path, { force: true, recursive: true })
      if (link !== null) await symlink(link, path)
      else if (own !== null) await writeFile(path, own)
    },
  }
}
