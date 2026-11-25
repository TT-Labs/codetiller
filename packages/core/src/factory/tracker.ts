import { z } from 'zod'
import { GitHubApi } from './github.js'
import { PreflightOverrideSchema } from './preflight.js'

/** tiller.yaml `factory.projects`: which repo to watch and how to run its tasks. */
export const ProjectSchema = z.object({
  /** GitHub owner/name */
  repo: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  /** datasets/<profile>/profile.yaml: sandbox image, deps, verification suites */
  profile: z.string(),
  /** configs/<config>.yaml: harness, model, skills, limits */
  config: z.string(),
  /** issues carrying this label are imported (never queued: a human does that) */
  label: z.string().default('tiller'),
  /** preflight limits for this repo; the repo's own `.factory/factory.yaml` overrides them */
  preflight: PreflightOverrideSchema.optional(),
})

export type Project = z.infer<typeof ProjectSchema>

export interface TrackerIssue {
  number: number
  title: string
  body: string
  url: string
}

/** The tracker only feeds intake; the factory owns its credentials. */
export interface Tracker {
  /** open issues marked for the factory */
  ready(repo: string, label: string): Promise<TrackerIssue[]>
}

interface GitHubIssue {
  number: number
  title: string
  body: string | null
  html_url: string
  pull_request?: unknown
}

export class GitHubIssues implements Tracker {
  private readonly api: GitHubApi

  constructor(token: string, fetcher: typeof fetch = fetch, base?: string) {
    this.api = new GitHubApi(token, fetcher, base)
  }

  async ready(repo: string, label: string): Promise<TrackerIssue[]> {
    const q = `state=open&labels=${encodeURIComponent(label)}`
    const issues = await this.api.list<GitHubIssue>(`/repos/${repo}/issues?${q}`)
    return (
      issues
        // the issues endpoint also returns pull requests
        .filter((i) => !i.pull_request)
        .map((i) => ({ number: i.number, title: i.title, body: i.body ?? '', url: i.html_url }))
        .sort((a, b) => a.number - b.number)
    )
  }
}
