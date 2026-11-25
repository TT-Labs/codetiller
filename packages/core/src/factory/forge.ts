import { GitHubApi } from './github.js'

export interface PullRequest {
  number: number
  url: string
}

export interface NewPullRequest {
  /** owner/name */
  repo: string
  head: string
  title: string
  body: string
}

export interface PrStatus {
  state: 'open' | 'closed'
  merged: boolean
  /** the forge cannot merge it into its base as it is; null while the forge is still working that out */
  conflict: boolean | null
  /** commit the PR branch is at */
  head?: string
}

/** One check of the repository's CI on a commit. */
export interface CiCheck {
  name: string
  url: string | null
  /** set when the forge can hand out the log of this check (a GitHub Actions job) */
  job?: number
}

/** What the repository's own CI says about a commit. */
export interface CiStatus {
  /** `none` = the commit has no checks (no CI, or it has not started) */
  state: 'none' | 'pending' | 'passed' | 'failed'
  failing: CiCheck[]
  total: number
}

export interface PrComment {
  id: number
  /** `comment` = PR conversation, `review` = inline on the diff */
  source: 'comment' | 'review'
  author: string
  /** GitHub author_association: OWNER, MEMBER, COLLABORATOR, CONTRIBUTOR, NONE, … */
  association: string
  body: string
  /** inline comments: file and line they sit on */
  path?: string
  line?: number
}

/**
 * The factory owns forge credentials; the agent container never sees them.
 * Token today = fine-grained PAT / installation token from the environment; minting short-lived
 * GitHub App installation tokens goes behind this same interface.
 */
export interface Forge {
  remoteUrl(repo: string): string
  /** HTTP header for git push (kept out of argv) */
  gitAuth(): string
  openDraft(pr: NewPullRequest): Promise<PullRequest>
  status(repo: string, number: number): Promise<PrStatus>
  /** conversation and inline comments of a PR, oldest first within each kind */
  comments(repo: string, number: number): Promise<PrComment[]>
  comment(repo: string, number: number, body: string): Promise<void>
  /** show the author their comment was picked up */
  acknowledge(repo: string, comment: PrComment): Promise<void>
  /** the repository's CI on a commit; absent = this forge cannot say */
  ci?(repo: string, sha: string): Promise<CiStatus>
  /** the end of a failing check's log, where it says what failed; null = not available */
  ciLog?(repo: string, check: CiCheck): Promise<string | null>
}

// conclusions of a finished check that mean it did not pass
const FAILED = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure'])

/**
 * The part of a CI job log that says what failed: the lines up to the last error marker, without
 * timestamps and colour codes. Logs are long and mostly setup; the agent needs the failure.
 */
export function logTail(log: string, lines = 120): string {
  const clean = log
    .split('\n')
    // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI colour codes start with ESC
    .map((l) => l.replace(/^\uFEFF?\d{4}-\d\d-\d\dT[\d:.]+Z /, '').replace(/\u001b\[[0-9;]*m/g, ''))
  const last = clean.findLastIndex((l) => l.includes('##[error]'))
  const end = last === -1 ? clean.length : last + 1
  return clean
    .slice(Math.max(0, end - lines), end)
    .filter((l) => !l.startsWith('##[group]') && !l.startsWith('##[endgroup]'))
    .join('\n')
    .trim()
}

interface GitHubComment {
  id: number
  user: { login: string } | null
  author_association: string
  body: string | null
  path?: string
  line?: number | null
  original_line?: number | null
}

export class GitHubForge implements Forge {
  private readonly api: GitHubApi

  constructor(
    private readonly token: string,
    fetcher: typeof fetch = fetch,
    base?: string,
  ) {
    this.api = new GitHubApi(token, fetcher, base)
  }

  remoteUrl(repo: string) {
    return `https://github.com/${repo}.git`
  }

  gitAuth() {
    const basic = Buffer.from(`x-access-token:${this.token}`).toString('base64')
    return `Authorization: Basic ${basic}`
  }

  /** Draft PR against the repo's default branch; merge stays a human decision. */
  async openDraft(pr: NewPullRequest): Promise<PullRequest> {
    const { default_branch } = await this.api.call<{ default_branch: string }>(
      'GET',
      `/repos/${pr.repo}`,
    )
    const created = await this.api.call<{ number: number; html_url: string }>(
      'POST',
      `/repos/${pr.repo}/pulls`,
      { title: pr.title, head: pr.head, base: default_branch, body: pr.body, draft: true },
    )
    return { number: created.number, url: created.html_url }
  }

  async status(repo: string, number: number): Promise<PrStatus> {
    const pr = await this.api.call<{
      state: 'open' | 'closed'
      merged: boolean
      mergeable: boolean | null
      head?: { sha: string }
    }>('GET', `/repos/${repo}/pulls/${number}`)
    return {
      state: pr.state,
      merged: pr.merged,
      conflict: pr.mergeable === null || pr.mergeable === undefined ? null : !pr.mergeable,
      head: pr.head?.sha,
    }
  }

  /**
   * What the token may do in a repository, for `tiller doctor`: reads only. `push` is the role
   * GitHub reports; whether a fine-grained token also carries the write permission is not
   * readable from the API and shows on the first push.
   */
  async access(repo: string): Promise<{ push: boolean; ci: true | string }> {
    const r = await this.api.call<{ default_branch: string; permissions?: { push?: boolean } }>(
      'GET',
      `/repos/${repo}`,
    )
    const head = await this.api.call<{ sha: string }>(
      'GET',
      `/repos/${repo}/commits/${encodeURIComponent(r.default_branch)}`,
    )
    const ci = await this.ci(repo, head.sha).then(
      () => true as const,
      (e: Error) => (/: (40\d) /.exec(e.message)?.[1] ?? e.message.slice(0, 80)) as string,
    )
    return { push: r.permissions?.push === true, ci }
  }

  /** Check runs (GitHub Actions and other apps) and commit statuses (older CI services) together. */
  async ci(repo: string, sha: string): Promise<CiStatus> {
    // A token may be allowed to read one of the two and not the other (check runs need
    // "Checks", statuses "Commit statuses"): what it can read is used; none at all is an error.
    const denied: string[] = []
    const read = <T>(path: string, empty: T) =>
      this.api.call<T>('GET', path).catch((e: Error) => {
        if (!/: 40[34] /.test(e.message)) throw e
        denied.push(e.message.slice(0, 200))
        return empty
      })
    const [runs, combined] = await Promise.all([
      read<{
        check_runs: {
          id: number
          name: string
          status: string
          conclusion: string | null
          html_url: string | null
          app?: { slug?: string } | null
        }[]
      }>(`/repos/${repo}/commits/${sha}/check-runs?per_page=100`, { check_runs: [] }),
      read<{ statuses: { context: string; state: string; target_url: string | null }[] }>(
        `/repos/${repo}/commits/${sha}/status`,
        { statuses: [] },
      ),
    ])
    if (denied.length === 2) throw new Error(`CI is not readable with this token: ${denied[0]}`)
    interface Check extends CiCheck {
      pending: boolean
      failed: boolean
    }
    const checks: Check[] = [
      ...runs.check_runs.map((r) => ({
        name: r.name,
        url: r.html_url,
        pending: r.status !== 'completed',
        failed: r.conclusion !== null && FAILED.has(r.conclusion),
        // an Actions job and its check run share the id
        ...(r.app?.slug === 'github-actions' ? { job: r.id } : {}),
      })),
      ...combined.statuses.map((s) => ({
        name: s.context,
        url: s.target_url,
        pending: s.state === 'pending',
        failed: s.state === 'failure' || s.state === 'error',
      })),
    ]
    const failing: CiCheck[] = checks
      .filter((c) => c.failed)
      .map((c) => ({ name: c.name, url: c.url, ...(c.job === undefined ? {} : { job: c.job }) }))
    return {
      // a failed check decides even while others still run
      state: !checks.length
        ? 'none'
        : failing.length
          ? 'failed'
          : checks.some((c) => c.pending)
            ? 'pending'
            : 'passed',
      failing,
      total: checks.length,
    }
  }

  async ciLog(repo: string, check: CiCheck): Promise<string | null> {
    if (check.job === undefined) return null
    return this.api.text(`/repos/${repo}/actions/jobs/${check.job}/logs`).then(logTail, () => null)
  }

  async comments(repo: string, number: number): Promise<PrComment[]> {
    const map = (source: PrComment['source']) => (c: GitHubComment) => ({
      id: c.id,
      source,
      author: c.user?.login ?? '',
      association: c.author_association,
      body: c.body ?? '',
      ...(c.path ? { path: c.path, line: c.line ?? c.original_line ?? undefined } : {}),
    })
    const [conversation, inline] = await Promise.all([
      this.api.list<GitHubComment>(`/repos/${repo}/issues/${number}/comments`),
      this.api.list<GitHubComment>(`/repos/${repo}/pulls/${number}/comments`),
    ])
    return [...conversation.map(map('comment')), ...inline.map(map('review'))]
  }

  async comment(repo: string, number: number, body: string) {
    await this.api.call('POST', `/repos/${repo}/issues/${number}/comments`, { body })
  }

  async acknowledge(repo: string, comment: PrComment) {
    const kind = comment.source === 'review' ? 'pulls' : 'issues'
    await this.api.call('POST', `/repos/${repo}/${kind}/comments/${comment.id}/reactions`, {
      content: 'eyes',
    })
  }
}
