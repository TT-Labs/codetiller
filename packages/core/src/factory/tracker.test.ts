import { expect, it } from 'vitest'
import { GitHubIssues, ProjectSchema } from './tracker.js'

it('lists labelled open issues, skipping pull requests', async () => {
  const urls: string[] = []
  const fetcher = (async (url: string) => {
    urls.push(url)
    return new Response(
      JSON.stringify([
        { number: 9, title: 'B', body: null, html_url: 'https://github.com/o/r/issues/9' },
        { number: 4, title: 'PR', body: '', html_url: 'x', pull_request: {} },
        { number: 3, title: 'A', body: 'text', html_url: 'https://github.com/o/r/issues/3' },
      ]),
      { status: 200 },
    )
  }) as typeof fetch
  const issues = await new GitHubIssues('tok', fetcher).ready('o/r', 'ready for ai')
  expect(issues).toEqual([
    { number: 3, title: 'A', body: 'text', url: 'https://github.com/o/r/issues/3' },
    { number: 9, title: 'B', body: '', url: 'https://github.com/o/r/issues/9' },
  ])
  expect(urls).toEqual([
    'https://api.github.com/repos/o/r/issues?state=open&labels=ready%20for%20ai&per_page=100&page=1',
  ])
})

it('follows pagination', async () => {
  let calls = 0
  const fetcher = (async () => {
    calls++
    const n = calls === 1 ? 100 : 2
    const batch = Array.from({ length: n }, (_, i) => ({
      number: calls * 1000 + i,
      title: 't',
      body: '',
      html_url: 'u',
    }))
    return new Response(JSON.stringify(batch), { status: 200 })
  }) as unknown as typeof fetch
  expect(await new GitHubIssues('tok', fetcher).ready('o/r', 'tiller')).toHaveLength(102)
  expect(calls).toBe(2)
})

it('project config defaults the label and validates the repo', () => {
  expect(ProjectSchema.parse({ repo: 'o/r', profile: 'p', config: 'c' }).label).toBe('tiller')
  expect(() => ProjectSchema.parse({ repo: 'nope', profile: 'p', config: 'c' })).toThrow()
})
