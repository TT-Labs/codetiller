import { createHash, timingSafeEqual } from 'node:crypto'
import { Hono, type MiddlewareHandler } from 'hono'
import type { ServerContext } from './context.js'
import { benchmarkRoutes } from './routes/benchmarks.js'
import { compareRoutes } from './routes/compare.js'
import { runRoutes } from './routes/runs.js'
import { taskRoutes } from './routes/tasks.js'

/**
 * HTTP API, mounted at /api. Route modules are chained so `AppType` carries every route for the
 * typed web client (hono/client). New areas (live runs, reviews, datasets) = new route module here.
 */
export function createApi(ctx: ServerContext) {
  return new Hono()
    .basePath('/api')
    .use(knownHost(ctx.hosts))
    .use(withToken(ctx.token))
    .use(sameOriginWrites)
    .get('/health', (c) => c.json({ ok: true }))
    .route('/tasks', taskRoutes(ctx))
    .route('/benchmarks', benchmarkRoutes(ctx))
    .route('/runs', runRoutes(ctx))
    .route('/compare', compareRoutes(ctx))
}

/**
 * The API listens on localhost, so any web page the user visits could POST to it. Writes must be
 * JSON (a cross-site form can't send it without a CORS preflight, which we never answer) and,
 * when the browser sends an Origin, come from this host.
 */
const originHost = (origin: string) => {
  try {
    return new URL(origin).host
  } catch {
    return null // e.g. `Origin: null` from sandboxed frames
  }
}

export const TOKEN_HEADER = 'x-tiller-token'
const digest = (s: string) => createHash('sha256').update(s).digest()

/** Reads included: transcripts and diffs are the repository's code. */
export const withToken = (token: string | undefined): MiddlewareHandler => {
  if (!token) return (_c, next) => next()
  const want = digest(token)
  return async (c, next) => {
    const got = c.req.header(TOKEN_HEADER)
    // compared as digests: equal length, constant time
    if (!got || !timingSafeEqual(digest(got), want))
      return c.json({ ok: false, error: 'unauthorized: open the link `tiller ui` printed' }, 401)
    return next()
  }
}

/**
 * Answer only to the names this server is reached by. A page on another site can point a
 * hostname of its own at 127.0.0.1 (DNS rebinding) and would then be same-origin with the API.
 */
export const knownHost = (hosts: string[] | undefined): MiddlewareHandler => {
  if (!hosts) return (_c, next) => next()
  const known = new Set(hosts)
  return async (c, next) => {
    if (!known.has(c.req.header('host') ?? ''))
      return c.json({ ok: false, error: 'unknown host' }, 403)
    return next()
  }
}

const sameOriginWrites: MiddlewareHandler = async (c, next) => {
  if (c.req.method === 'GET' || c.req.method === 'HEAD') return next()
  const json = c.req.header('content-type')?.startsWith('application/json')
  const origin = c.req.header('origin')
  const host = c.req.header('host')
  if (!json || (origin !== undefined && originHost(origin) !== host))
    return c.json({ ok: false, error: 'cross-origin or non-JSON write rejected' }, 403)
  return next()
}

export type AppType = ReturnType<typeof createApi>
