import { execFile } from 'node:child_process'
import { access, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)

export async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 })
  return stdout
}

const FORGE = 'https://github.com/'

/**
 * Git environment for a call to the forge. The header is bound to the forge's address: a
 * redirect or a submodule on another host does not get it. It is in the environment, not in
 * argv and not in any stored config.
 */
export function forgeAuth(auth?: string): Record<string, string> {
  const env: Record<string, string> = { GIT_TERMINAL_PROMPT: '0' }
  if (auth) {
    env.GIT_CONFIG_COUNT = '1'
    env.GIT_CONFIG_KEY_0 = `http.${FORGE}.extraHeader`
    env.GIT_CONFIG_VALUE_0 = auth
  }
  return env
}

const exists = (p: string) =>
  access(p).then(
    () => true,
    () => false,
  )

/**
 * Clone cache per repo + one self-contained local clone per workspace
 * (not a worktree: its .git must resolve inside the container).
 */
export class GitWorkspaces {
  /**
   * `auth`: the factory's own credential as an HTTP header (`Forge.gitAuth()`). Without it git
   * falls back to whatever the machine has configured, which is fine for public repositories and
   * for a developer's laptop, and nothing a server install can rely on.
   */
  constructor(
    readonly cacheDir: string,
    private readonly remote: { auth?: string } = {},
  ) {}

  /** Environment of a git call that talks to the forge: never a prompt, the header for it only. */
  private net(): NodeJS.ProcessEnv {
    return { ...process.env, ...forgeAuth(this.remote.auth) }
  }

  repoCache(repo: string) {
    return join(this.cacheDir, 'repos', repo.replace('/', '__'))
  }

  async ensureRepo(repo: string, commits: string[]): Promise<string> {
    const dir = this.repoCache(repo)
    if (!(await exists(dir))) {
      await mkdir(join(this.cacheDir, 'repos'), { recursive: true })
      await exec('git', ['clone', '--quiet', `${FORGE}${repo}.git`, dir], { env: this.net() })
    }
    for (const c of commits) {
      const ok = await git(dir, 'cat-file', '-e', `${c}^{commit}`).then(
        () => true,
        () => false,
      )
      if (!ok) await exec('git', ['fetch', '--quiet', 'origin', c], { cwd: dir, env: this.net() })
    }
    return dir
  }

  /** Fetch what the forge has now into the repo's cache (which `ensureRepo` made). */
  async fetch(repo: string) {
    await exec('git', ['fetch', '--quiet', 'origin'], {
      cwd: this.repoCache(repo),
      env: this.net(),
      maxBuffer: 64 * 1024 * 1024,
    })
  }

  /** Fresh workspace checked out (detached) at `commit`. */
  async create(repo: string, commit: string, name: string): Promise<string> {
    const src = this.repoCache(repo)
    const ws = join(this.cacheDir, 'work', name)
    await rm(ws, { recursive: true, force: true })
    await mkdir(join(this.cacheDir, 'work'), { recursive: true })
    await exec('git', ['clone', '--quiet', '--local', '--no-checkout', src, ws])
    await git(ws, 'checkout', '--quiet', '--detach', commit)
    return ws
  }

  /**
   * Agent workspace: tree at `commit` with NO history — a single fresh commit, no remotes/refs.
   * A plain clone would let the agent `git log --all` / `git show <fix_commit>`. Its `.git` is
   * agent-writable: never run host git in it after an agent ran (use TaskRepo for that).
   */
  async createIsolated(repo: string, commit: string, name: string): Promise<string> {
    const ws = await this.create(repo, commit, name)
    await rm(join(ws, '.git'), { recursive: true, force: true })
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: 'tiller',
      GIT_AUTHOR_EMAIL: 'tiller@localhost',
      GIT_COMMITTER_NAME: 'tiller',
      GIT_COMMITTER_EMAIL: 'tiller@localhost',
      GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
      GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
    }
    for (const args of [
      ['init', '--quiet', '--initial-branch=main'],
      ['add', '-A'],
      ['commit', '--quiet', '--no-verify', '--no-gpg-sign', '-m', 'base'],
    ]) {
      await exec('git', args, { cwd: ws, env, maxBuffer: 64 * 1024 * 1024 })
    }
    return ws
  }

  /** Overwrite `files` in the workspace with their content at `commit` (hidden test injection). */
  async checkoutFiles(ws: string, commit: string, files: string[]) {
    await git(ws, 'checkout', commit, '--', ...files)
  }

  /** Switch the whole tree to `commit`, keeping untracked files (node_modules). */
  async switchTo(ws: string, commit: string) {
    await git(ws, 'checkout', '--quiet', '--force', '--detach', commit)
  }

  dispose(ws: string) {
    return rm(ws, { recursive: true, force: true })
  }
}

export async function applyPatch(ws: string, patchFile: string) {
  await git(ws, 'apply', '--whitespace=nowarn', patchFile)
}

/** Paths a patch touches (new path of renames). */
export function patchFiles(patch: string): string[] {
  const files = new Set<string>()
  for (const l of patch.split('\n')) {
    const m = /^diff --git a\/.* b\/(.*)$/.exec(l)
    if (m?.[1]) files.add(m[1])
  }
  return [...files]
}

export function diffStats(patch: string): { files: number; lines: number } {
  let files = 0
  let lines = 0
  for (const l of patch.split('\n')) {
    if (l.startsWith('diff --git ')) files++
    else if (
      (l.startsWith('+') && !l.startsWith('+++')) ||
      (l.startsWith('-') && !l.startsWith('---'))
    )
      lines++
  }
  return { files, lines }
}
