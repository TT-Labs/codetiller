import { expect, it } from 'vitest'
import { type CiCheck, GitHubForge, logTail } from './forge.js'
import { GitHubApi } from './github.js'

it('opens a draft PR against the default branch; token only in headers', async () => {
  const calls: { url: string; init: RequestInit }[] = []
  const fetcher = (async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    const body = url.endsWith('/pulls')
      ? { number: 7, html_url: 'https://github.com/o/r/pull/7' }
      : { default_branch: 'trunk' }
    return new Response(JSON.stringify(body), { status: 200 })
  }) as typeof fetch
  const forge = new GitHubForge('tok', fetcher)
  const pr = await forge.openDraft({ repo: 'o/r', head: 'tiller/t-1', title: 'T', body: 'B' })
  expect(pr).toEqual({ number: 7, url: 'https://github.com/o/r/pull/7' })
  expect(calls.map((c) => c.url)).toEqual([
    'https://api.github.com/repos/o/r',
    'https://api.github.com/repos/o/r/pulls',
  ])
  expect(JSON.parse(calls[1]?.init.body as string)).toEqual({
    title: 'T',
    head: 'tiller/t-1',
    base: 'trunk',
    body: 'B',
    draft: true,
  })
  expect(calls.every((c) => !c.url.includes('tok'))).toBe(true)
  expect(forge.remoteUrl('o/r')).toBe('https://github.com/o/r.git')
  expect(forge.gitAuth()).toMatch(/^Authorization: Basic /)
})

it('surfaces API errors', async () => {
  const fetcher = (async () => new Response('nope', { status: 403 })) as unknown as typeof fetch
  await expect(
    new GitHubForge('tok', fetcher).openDraft({ repo: 'o/r', head: 'h', title: 'T', body: 'B' }),
  ).rejects.toThrow(/403 nope/)
})

it('reads PR status and comments, replies and acknowledges', async () => {
  const calls: { method: string; url: string; body?: unknown }[] = []
  const fetcher = (async (url: string, init: RequestInit) => {
    calls.push({
      method: init.method as string,
      url: url.replace('https://api.github.com/repos/o/r', ''),
      ...(init.body ? { body: JSON.parse(init.body as string) } : {}),
    })
    const user = { login: 'jan' }
    const body = url.includes('/issues/7/comments?')
      ? [{ id: 1, user, author_association: 'OWNER', body: '/tiller go' }]
      : url.includes('/pulls/7/comments?')
        ? [
            { id: 2, user, author_association: 'MEMBER', body: 'x', path: 'a.ts', line: 4 },
            {
              id: 3,
              user: null,
              author_association: 'NONE',
              body: null,
              path: 'b.ts',
              line: null,
              original_line: 9,
            },
          ]
        : url.endsWith('/pulls/7')
          ? { state: 'closed', merged: true, title: 'ignored' }
          : {}
    return new Response(JSON.stringify(body), { status: 200 })
  }) as typeof fetch
  const forge = new GitHubForge('tok', fetcher)

  // no `mergeable` in the answer: the forge has not decided, which is not "no conflict"
  expect(await forge.status('o/r', 7)).toEqual({ state: 'closed', merged: true, conflict: null })
  const comments = await forge.comments('o/r', 7)
  expect(comments).toEqual([
    { id: 1, source: 'comment', author: 'jan', association: 'OWNER', body: '/tiller go' },
    {
      id: 2,
      source: 'review',
      author: 'jan',
      association: 'MEMBER',
      body: 'x',
      path: 'a.ts',
      line: 4,
    },
    { id: 3, source: 'review', author: '', association: 'NONE', body: '', path: 'b.ts', line: 9 },
  ])
  await forge.comment('o/r', 7, 'done')
  for (const c of comments.slice(0, 2)) await forge.acknowledge('o/r', c)
  expect(calls).toEqual([
    { method: 'GET', url: '/pulls/7' },
    { method: 'GET', url: '/issues/7/comments?per_page=100&page=1' },
    { method: 'GET', url: '/pulls/7/comments?per_page=100&page=1' },
    { method: 'POST', url: '/issues/7/comments', body: { body: 'done' } },
    { method: 'POST', url: '/issues/comments/1/reactions', body: { content: 'eyes' } },
    { method: 'POST', url: '/pulls/comments/2/reactions', body: { content: 'eyes' } },
  ])
})

it('a read that fails on the network is sent once more; a write is not', async () => {
  const calls: string[] = []
  let failures = 1
  const flaky = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push(`${init?.method} ${String(url)}`)
    if (failures-- > 0) throw new TypeError('fetch failed')
    return new Response('{"ok":true}', { status: 200 })
  }) as typeof fetch
  const api = new GitHubApi('t', flaky, 'https://gh.test')
  expect(await api.call('GET', '/repos/o/r/pulls/1')).toEqual({ ok: true })
  expect(calls).toHaveLength(2)
  failures = 1
  await expect(api.call('POST', '/repos/o/r/issues/1/comments', { body: 'x' })).rejects.toThrow(
    'GitHub POST /repos/o/r/issues/1/comments: fetch failed',
  )
  expect(calls).toHaveLength(3)
  // a read that keeps failing is an error, not a loop
  failures = 2
  await expect(api.call('GET', '/x')).rejects.toThrow('fetch failed')
  expect(calls).toHaveLength(5)
})

it('reads CI from check runs and commit statuses: a failure decides, running checks mean pending', async () => {
  const answers: Record<string, unknown> = {}
  const api = (async (url: string | URL | Request) => {
    const path = String(url).replace('https://gh.test', '')
    if (path.endsWith('/logs'))
      return new Response(
        "2026-11-17T08:00:00.1Z setup\n2026-11-17T08:00:01.1Z ##[group]Run pnpm typecheck\n2026-11-17T08:00:02.1Z src/a.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.\n2026-11-17T08:00:03.1Z \u001b[31m##[error]Process completed with exit code 2.\u001b[0m\n2026-11-17T08:00:04.1Z Post job cleanup.\n",
      )
    return new Response(JSON.stringify(answers[path.split('?')[0] as string]), { status: 200 })
  }) as typeof fetch
  const forge = new GitHubForge('t', api, 'https://gh.test')
  const runs = (list: object[]) => {
    answers['/repos/o/r/commits/abc/check-runs'] = { check_runs: list }
  }
  const statuses = (list: object[]) => {
    answers['/repos/o/r/commits/abc/status'] = { statuses: list }
  }
  const run = (name: string, status: string, conclusion: string | null, id = 1) => ({
    id,
    name,
    status,
    conclusion,
    html_url: `https://github.com/o/r/runs/${id}`,
    app: { slug: 'github-actions' },
  })
  // nothing reported: not "pending", there is simply no CI (yet)
  runs([])
  statuses([])
  expect(await forge.ci('o/r', 'abc')).toEqual({ state: 'none', failing: [], total: 0 })
  runs([run('api', 'completed', 'success'), run('web', 'in_progress', null, 2)])
  expect((await forge.ci('o/r', 'abc')).state).toBe('pending')
  runs([run('api', 'completed', 'success'), run('web', 'completed', 'success', 2)])
  statuses([{ context: 'ci/legacy', state: 'success', target_url: null }])
  expect(await forge.ci('o/r', 'abc')).toEqual({ state: 'passed', failing: [], total: 3 })
  // a failed check decides although another still runs; skipped and neutral are not failures
  runs([
    run('api', 'in_progress', null),
    run('web', 'completed', 'failure', 2),
    run('docs', 'completed', 'skipped', 3),
  ])
  statuses([{ context: 'ci/legacy', state: 'error', target_url: 'https://ci.example/1' }])
  const ci = await forge.ci('o/r', 'abc')
  expect(ci).toEqual({
    state: 'failed',
    total: 4,
    failing: [
      { name: 'web', url: 'https://github.com/o/r/runs/2', job: 2 },
      { name: 'ci/legacy', url: 'https://ci.example/1' },
    ],
  })
  // the log of an Actions job: the lines up to the error, without timestamps, colours and what follows
  expect(await forge.ciLog('o/r', ci.failing[0] as CiCheck)).toBe(
    "setup\nsrc/a.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.\n##[error]Process completed with exit code 2.",
  )
  // a status of another CI service has no log here
  expect(await forge.ciLog('o/r', ci.failing[1] as CiCheck)).toBeNull()
  expect(logTail('a\nb\nc', 2)).toBe('b\nc')
})

it('a token that may read only one kind of CI result still gives an answer; none at all is an error', async () => {
  const denied = new Set(['status'])
  const api = (async (url: string | URL | Request) => {
    const kind = String(url).includes('/check-runs') ? 'check-runs' : 'status'
    if (denied.has(kind))
      return new Response('{"message":"Resource not accessible by personal access token"}', {
        status: 403,
      })
    const body =
      kind === 'check-runs'
        ? {
            check_runs: [
              { id: 1, name: 'web', status: 'completed', conclusion: 'failure', html_url: null },
            ],
          }
        : { statuses: [] }
    return new Response(JSON.stringify(body), { status: 200 })
  }) as typeof fetch
  const forge = new GitHubForge('t', api, 'https://gh.test')
  expect(await forge.ci('o/r', 'abc')).toMatchObject({
    state: 'failed',
    failing: [{ name: 'web' }],
  })
  denied.add('check-runs')
  await expect(forge.ci('o/r', 'abc')).rejects.toThrow('CI is not readable with this token')
})
