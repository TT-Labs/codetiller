import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)

const gh = async <T>(...args: string[]): Promise<T> => {
  const { stdout } = await exec('gh', args, { maxBuffer: 64 * 1024 * 1024 })
  return JSON.parse(stdout) as T
}

export const isTestFile = (p: string) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(p)

export interface Draft {
  id: string
  repo: string
  pr: number
  base_commit: string
  fix_commit: string
  issue: { title: string; body: string; url: string }
  hidden_tests: string[]
  source_files: string[]
  created_at: string
  difficulty: 'small' | 'medium' | 'large'
  flags: string[] // reasons a human should look closer
}

interface PrJson {
  number: number
  title: string
  mergedAt: string
  mergeCommit: { oid: string } | null
  closingIssuesReferences: { number: number; url: string }[]
  files: { path: string; additions: number; deletions: number }[]
}

export interface MineOptions {
  repo: string
  since: string // YYYY-MM-DD
  limit?: number
  maxSourceFiles?: number
  /** test file must be runnable by the repo test command (e.g. hono `main` project = src/**) */
  testFilter?: (path: string) => boolean
  log?: (m: string) => void
}

/** Links that may point to a ready-made fix → leakage risk. */
const LEAK = /github\.com\/[^\s)]+\/(tree|commit|compare|pull)\/|```diff/i

/**
 * Candidate = merged PR that closes an issue, changes test files,
 * touches ≤ maxSourceFiles non-test files, squash-merged (single parent).
 */
export async function mineCandidates(opts: MineOptions): Promise<Draft[]> {
  const {
    repo,
    since,
    limit = 300,
    maxSourceFiles = 10,
    testFilter = () => true,
    log = () => {},
  } = opts
  const prs = await gh<PrJson[]>(
    'pr',
    'list',
    '-R',
    repo,
    '--state',
    'merged',
    '--limit',
    String(limit),
    '--search',
    `merged:>=${since}`,
    '--json',
    'number,title,mergedAt,mergeCommit,closingIssuesReferences,files',
  )
  log(`${prs.length} merged PRs since ${since}`)
  const drafts: Draft[] = []
  for (const pr of prs) {
    const issueRef = pr.closingIssuesReferences[0]
    if (!issueRef || !pr.mergeCommit) continue
    const tests = pr.files.map((f) => f.path).filter(isTestFile)
    const src = pr.files.filter((f) => !isTestFile(f.path))
    if (tests.length === 0 || src.length === 0 || src.length > maxSourceFiles) continue
    if (!tests.every(testFilter)) continue
    const fix = pr.mergeCommit.oid
    const commit = await gh<{ parents: { sha: string }[] }>('api', `repos/${repo}/commits/${fix}`)
    const parent = commit.parents[0]
    if (!parent || commit.parents.length !== 1) continue // merge commit: base ambiguous
    const issue = await gh<{ title: string; body: string; url: string }>(
      'issue',
      'view',
      String(issueRef.number),
      '-R',
      repo,
      '--json',
      'title,body,url',
    )
    const loc = src.reduce((n, f) => n + f.additions + f.deletions, 0)
    const flags: string[] = []
    if (LEAK.test(issue.body)) flags.push('issue body links code / diff (leakage?)')
    if (pr.closingIssuesReferences.length > 1) flags.push('closes multiple issues')
    if (issue.body.trim().length < 80) flags.push('short issue body')
    drafts.push({
      id: `${repo.split('/')[1]}-${pr.number}`,
      repo,
      pr: pr.number,
      base_commit: parent.sha,
      fix_commit: fix,
      issue: { title: issue.title, body: issue.body, url: issue.url },
      hidden_tests: tests,
      source_files: src.map((f) => f.path),
      created_at: pr.mergedAt.slice(0, 10),
      difficulty: loc < 30 ? 'small' : loc < 150 ? 'medium' : 'large',
      flags,
    })
    log(`  candidate ${pr.number}: ${pr.title}${flags.length ? `  [${flags.join('; ')}]` : ''}`)
  }
  return drafts
}
