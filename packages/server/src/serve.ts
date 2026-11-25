import { readFile } from 'node:fs/promises'
import { extname, join, normalize, sep } from 'node:path'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { createApi, knownHost } from './app.js'
import type { ServerContext } from './context.js'

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
}

export interface ServeOptions {
  port: number
  /** local only by default: the API exposes repo code and transcripts */
  host?: string
  /** built web app (packages/web/dist); omitted = API only (use the Vite dev server) */
  webDir?: string
}

export function createServer(ctx: ServerContext, webDir?: string) {
  // the page itself is served to known hosts only as well; it needs no token (it holds no data)
  const app = new Hono().use(knownHost(ctx.hosts)).route('/', createApi(ctx))
  if (webDir) {
    const root = normalize(webDir)
    app.get('*', async (c) => {
      const rel = normalize(decodeURIComponent(new URL(c.req.url).pathname)).replace(/^[/\\]+/, '')
      const path = join(root, rel)
      const file =
        path.startsWith(root + sep) && extname(path) ? await readFile(path).catch(() => null) : null
      if (file)
        return c.body(file, 200, {
          'content-type': TYPES[extname(path)] ?? 'application/octet-stream',
        })
      // SPA fallback: client-side routes
      const index = await readFile(join(root, 'index.html')).catch(() => null)
      return index ? c.html(index.toString()) : c.text('web app not built: pnpm build', 404)
    })
  }
  return app
}

export function startServer(ctx: ServerContext, opts: ServeOptions) {
  const app = createServer(ctx, opts.webDir)
  return serve({ fetch: app.fetch, port: opts.port, hostname: opts.host ?? '127.0.0.1' })
}
