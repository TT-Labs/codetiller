const PAGE = 100
const MAX_PAGES = 10

/** Minimal GitHub REST client shared by the forge and tracker adapters; the token never leaves the host. */
export class GitHubApi {
  constructor(
    private readonly token: string,
    private readonly fetcher: typeof fetch = fetch,
    private readonly base = 'https://api.github.com',
  ) {}

  async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const send = () =>
      this.fetcher(`${this.base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      })
    // A request can fail on the network without GitHub having said anything ("fetch failed":
    // a dropped connection, a short outage). A read is safe to send again, once; a write may
    // have arrived, so it is not.
    const res = await send().catch((e: Error) => {
      if (method === 'GET') return send()
      throw new Error(`GitHub ${method} ${path}: ${e.message}`)
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`GitHub ${method} ${path}: ${res.status} ${text.slice(0, 300)}`)
    }
    return (await res.json()) as T
  }

  /** A read whose answer is text (a job log: GitHub redirects to where it is stored). */
  async text(path: string): Promise<string> {
    const send = () =>
      this.fetcher(`${this.base}${path}`, {
        headers: {
          authorization: `Bearer ${this.token}`,
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
        },
      })
    const res = await send().catch(() => send())
    if (!res.ok) throw new Error(`GitHub GET ${path}: ${res.status}`)
    return res.text()
  }

  /** Every item of a list endpoint (100 per page, at most 10 pages). */
  async list<T>(path: string): Promise<T[]> {
    const out: T[] = []
    const sep = path.includes('?') ? '&' : '?'
    for (let page = 1; page <= MAX_PAGES; page++) {
      const batch = await this.call<T[]>('GET', `${path}${sep}per_page=${PAGE}&page=${page}`)
      out.push(...batch)
      if (batch.length < PAGE) break
    }
    return out
  }
}
