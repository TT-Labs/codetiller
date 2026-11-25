import { execFile } from 'node:child_process'
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

import { forgeAuth } from '../workspace/git.js'

const exec = promisify(execFile)

const exists = (p: string) =>
  access(p).then(
    () => true,
    () => false,
  )

const IDENT = ['-c', 'user.name=tiller', '-c', 'user.email=tiller@localhost']

/**
 * Trusted host-side git for one work item. The git dir lives in `<holder>/.git`,
 * which is never mounted into a container; the agent-writable workspace is only its work tree.
 * The host must never run git *inside* the workspace: a `.git/config` planted there (fsmonitor,
 * filters, hooks) would execute on the host. A `.git` in the workspace is the agent's scratch repo
 * and is ignored here.
 */
export class TaskRepo {
  private readonly gitDir: string

  constructor(
    readonly holder: string,
    readonly workTree: string,
  ) {
    this.gitDir = join(holder, '.git')
  }

  exists() {
    return exists(this.gitDir)
  }

  async git(args: string[], env?: Record<string, string>): Promise<string> {
    const { stdout } = await exec(
      'git',
      [
        '--git-dir',
        this.gitDir,
        '--work-tree',
        this.workTree,
        // belt and braces: nothing in this git dir is agent-writable, but never run hooks anyway
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'core.fsmonitor=false',
        ...args,
      ],
      { cwd: this.holder, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, ...env } },
    )
    return stdout
  }

  /**
   * Clone `src` (repo cache) and put `branch` at `base`. A missing workspace is checked out fresh
   * and gets a history-less scratch repo for the agent; an existing one (legacy layout) is adopted
   * as-is, so its changes land in the next commit.
   */
  async init(src: string, base: string, branch: string) {
    await rm(this.holder, { recursive: true, force: true })
    await mkdir(dirname(this.holder), { recursive: true })
    await exec('git', ['clone', '--quiet', '--local', '--no-checkout', src, this.holder])
    await this.git(['update-ref', `refs/heads/${branch}`, base])
    await this.git(['symbolic-ref', 'HEAD', `refs/heads/${branch}`])
    if (await exists(this.workTree)) {
      await this.git(['reset', '--quiet', '--mixed'])
      return
    }
    await mkdir(this.workTree, { recursive: true })
    await this.git(['reset', '--quiet', '--hard'])
    // safe to run git in the workspace here only: no agent has touched it yet
    for (const args of [
      ['init', '--quiet', '--initial-branch=main'],
      ['add', '-A'],
      [...IDENT, 'commit', '--quiet', '--no-verify', '--no-gpg-sign', '-m', 'base'],
    ]) {
      await exec('git', args, { cwd: this.workTree, maxBuffer: 64 * 1024 * 1024 })
    }
  }

  async head(): Promise<string> {
    return (await this.git(['rev-parse', 'HEAD'])).trim()
  }

  /** A merge is open: it had conflicts, and the next commit concludes it. */
  merging() {
    return exists(join(this.gitDir, 'MERGE_HEAD'))
  }

  /** Bring `commit` from another local repository (the repo cache) into this git dir. */
  async fetch(src: string, commit: string) {
    await this.git(['fetch', '--quiet', src, commit])
  }

  /**
   * Merge `commit` (already fetched) into the branch. Clean: the merge commit. Conflicts: their
   * paths, with the merge left open: the work tree holds the conflict markers for the agent to
   * resolve, and the next {@link commitAll} concludes the merge.
   */
  async merge(
    commit: string,
    message: string,
  ): Promise<{ head: string } | { conflicts: string[] }> {
    const args = ['merge', '--no-ff', '--no-edit', '--no-verify', '--no-gpg-sign', '-m', message]
    try {
      await this.git([...IDENT, ...args, commit])
      return { head: await this.head() }
    } catch (e) {
      const unmerged = await this.git(['diff', '--name-only', '--diff-filter=U'])
      const conflicts = unmerged.split('\n').filter(Boolean)
      // not a conflict (unrelated histories, a dirty tree): that is an error, not work for the agent
      if (conflicts.length === 0) throw e
      return { conflicts }
    }
  }

  /** Files of `commit` that still carry conflict markers: a merge that was committed unresolved. */
  async markers(commit: string): Promise<string[]> {
    const out = await this.git(['grep', '-l', '-E', '^(<<<<<<<|>>>>>>>)( |$)', commit]).catch(
      () => '', // git grep exits 1 when nothing matches
    )
    return out
      .split('\n')
      .filter(Boolean)
      .map((l) => l.slice(commit.length + 1))
  }

  /** Commit everything in the workspace; returns the new head, or undefined when nothing changed. */
  async commitAll(message: string): Promise<string | undefined> {
    await this.git(['add', '-A'])
    // an open merge is concluded even when the resolution equals what the branch already had
    const changed = (await this.git(['diff', '--cached', '--name-only'])).trim()
    if (!changed && !(await this.merging())) return undefined
    await this.git([...IDENT, 'commit', '--quiet', '--no-verify', '--no-gpg-sign', '-m', message])
    return this.head()
  }

  /**
   * Uncommitted workspace changes vs HEAD incl. new files (respects the repo's .gitignore) as a
   * binary-safe patch; `exclude` paths are left out. Stages what it reports.
   */
  async changes(exclude: string[] = []): Promise<string> {
    await this.git(['add', '-A', '--', '.', ...exclude.map((e) => `:(exclude)${e}`)])
    return this.git(['diff', '--cached', '--binary', 'HEAD'])
  }

  diff(from: string, to: string) {
    return this.git(['diff', '--binary', from, to])
  }

  /**
   * Regular files directly under `dir` at `commit`, read from the git dir: what the repository
   * said there, whatever the agent has since written into the workspace. Symlinks are skipped.
   */
  async files(commit: string, dir: string): Promise<{ path: string; text: string }[]> {
    const listing = await this.git(['ls-tree', commit, `${dir.replace(/\/+$/, '')}/`]).catch(
      () => '',
    )
    const paths = listing
      .split('\n')
      .map((l) => /^(\d+) blob [0-9a-f]+\t(.+)$/.exec(l))
      .filter((m) => m && (m[1] === '100644' || m[1] === '100755'))
      .map((m) => (m as RegExpExecArray)[2] as string)
    return Promise.all(
      paths.map(async (path) => ({ path, text: await this.git(['show', `${commit}:${path}`]) })),
    )
  }

  /** Clean tree of `commit` in a fresh sibling dir (verification never sees the live workspace). */
  async exportTree(commit: string): Promise<string> {
    const dir = await mkdtemp(join(dirname(this.holder), 'verify-'))
    const env = { GIT_INDEX_FILE: join(dir, '.tiller-index') }
    try {
      await this.git(['read-tree', commit], env)
      await this.git(['checkout-index', '-a', `--prefix=${dir}/`], env)
    } catch (e) {
      await rm(dir, { recursive: true, force: true })
      throw e
    }
    await rm(env.GIT_INDEX_FILE, { force: true })
    return dir
  }

  /** Remove the git dir and the workspace. */
  async dispose() {
    await rm(this.workTree, { recursive: true, force: true })
    await rm(this.holder, { recursive: true, force: true })
  }

  /** Push the task branch; `auth` is an HTTP header kept out of argv and of the stored config. */
  async push(url: string, branch: string, auth?: string) {
    await this.git(
      ['push', '--quiet', url, `refs/heads/${branch}:refs/heads/${branch}`],
      forgeAuth(auth),
    )
  }
}
