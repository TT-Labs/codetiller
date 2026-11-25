// Registry proxy: the only thing a dependency-install container can reach.
// An install runs code the agent chose (install scripts, a lockfile it edited) and needs the
// package registry. Given the open network, that code could send the repository anywhere. Here
// it can only read from the configured registries: GET and HEAD, no credentials, no other host.
// Runs in its own container, without the model key; no dependencies.
import http from 'node:http'
import https from 'node:https'
import { pathToFileURL } from 'node:url'
import { gunzipSync, gzipSync } from 'node:zlib'

// what a package manager needs to send to read a registry; everything else stays behind
// (authorization and cookies above all: an install must not act as anyone at the registry).
// Of the encodings only gzip is asked for, and only when the client takes it: package metadata
// has to be read here (see below), and it is large enough that sending it plain is slow.
const FORWARDED = ['accept', 'user-agent', 'if-none-match', 'if-modified-since', 'range']
const NOT_PASSED_BACK = new Set([
  'set-cookie',
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'trailer',
  'upgrade',
])
// package metadata is small next to this; a larger JSON answer is passed on as it is
const MAX_REWRITE = 64 * 1024 * 1024

export const DEFAULT_REGISTRIES = {
  npm: 'https://registry.npmjs.org',
  go: 'https://proxy.golang.org',
  // the Python index names its files at a second host
  pypi: 'https://pypi.org',
  pythonhosted: 'https://files.pythonhosted.org',
}

/** The proxy as an http server (not listening yet). `registries`: name → upstream, served at `/<name>/…`. */
export function createRegistryProxy({ registries = DEFAULT_REGISTRIES, log = console.log } = {}) {
  const upstreams = new Map(Object.entries(registries).map(([name, url]) => [name, new URL(url)]))
  /**
   * Registries name files by absolute URL (npm tarballs in package metadata, PyPI files at a
   * second host, redirects), and package managers fetch exactly that. The install cannot reach
   * those hosts: every URL of a configured registry is pointed back at this proxy.
   */
  const pointBack = (text, host) => {
    let out = text
    for (const [name, url] of upstreams)
      out = out.replaceAll(
        `${url.origin}${url.pathname.replace(/\/$/, '')}/`,
        `http://${host}/${name}/`,
      )
    return out
  }
  let forwarded = 0
  let refused = 0
  const refuse = (res, status, why, headers = {}) => {
    refused++
    log(`refused ${status}: ${why}`)
    res.writeHead(status, { 'content-type': 'text/plain', ...headers })
    res.end(`registry proxy: ${why}\n`)
  }

  const server = http.createServer((req, res) => {
    req.resume()
    const url = req.url ?? ''
    if (req.method === 'GET' && url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(
        JSON.stringify({ ok: true, registries: [...upstreams.keys()], forwarded, refused }),
      )
    }
    // reading only: a write to a registry is a way to publish what the install can see
    if (req.method !== 'GET' && req.method !== 'HEAD')
      return refuse(res, 405, `${req.method} is not allowed: registries are read-only here`, {
        allow: 'GET, HEAD',
      })
    const match = /^\/([a-z0-9-]+)(\/.*)$/.exec(url)
    const target = match && upstreams.get(match[1])
    // origin-form paths under a configured registry only: no absolute URLs (proxy use), no traversal
    if (!match || !target || url.includes('..'))
      return refuse(res, 404, `${url.split('?')[0].slice(0, 80)} is not a configured registry`)
    const transport = target.protocol === 'http:' ? http : https
    const gzip = /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''))
    const headers = Object.fromEntries(
      FORWARDED.filter((h) => req.headers[h] !== undefined).map((h) => [h, req.headers[h]]),
    )
    const up = transport.request(
      {
        protocol: target.protocol,
        host: target.hostname,
        port: target.port || (target.protocol === 'http:' ? 80 : 443),
        method: req.method,
        path: target.pathname.replace(/\/$/, '') + match[2],
        headers: { ...headers, host: target.host, 'accept-encoding': gzip ? 'gzip' : 'identity' },
      },
      (answer) => {
        forwarded++
        // the registry's cookies stay behind, and so do headers about its connection to us,
        // which say nothing about ours to the client
        const rest = Object.fromEntries(
          Object.entries(answer.headers).filter(([name]) => !NOT_PASSED_BACK.has(name)),
        )
        // a redirect within the registries stays within the proxy
        if (typeof rest.location === 'string')
          rest.location = pointBack(rest.location, req.headers.host)
        // package metadata (JSON) and index pages (HTML) carry the file URLs
        const json = /json|html/i.test(String(answer.headers['content-type'] ?? ''))
        const size = Number(answer.headers['content-length'] ?? 0)
        const encoding = String(answer.headers['content-encoding'] ?? 'identity')
        const readable = encoding === 'identity' || encoding === 'gzip'
        if (!json || !readable || req.method === 'HEAD' || size > MAX_REWRITE) {
          res.writeHead(answer.statusCode ?? 502, rest)
          return answer.pipe(res)
        }
        const chunks = []
        answer.on('data', (c) => chunks.push(c))
        answer.on('error', () => res.destroy())
        answer.on('end', () => {
          const {
            'content-length': _n,
            'content-encoding': _e,
            'transfer-encoding': _t,
            ...headers
          } = rest
          let body
          try {
            const raw = Buffer.concat(chunks)
            const text = (encoding === 'gzip' ? gunzipSync(raw) : raw).toString('utf8')
            body = Buffer.from(pointBack(text, req.headers.host))
          } catch {
            return refuse(res, 502, 'unreadable answer from the registry')
          }
          if (gzip) {
            body = gzipSync(body)
            headers['content-encoding'] = 'gzip'
          }
          res.writeHead(answer.statusCode ?? 502, { ...headers, 'content-length': body.length })
          res.end(body)
        })
      },
    )
    up.on('error', (e) => {
      if (res.headersSent) res.destroy()
      else refuse(res, 502, `upstream error: ${e.code ?? e.message}`)
    })
    up.end()
  })

  // CONNECT would make this a tunnel to anywhere
  server.on('connect', (_req, socket) => {
    refused++
    log('refused 403: CONNECT')
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n')
  })
  return server
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const registries = process.env.TILLER_REGISTRIES
    ? JSON.parse(process.env.TILLER_REGISTRIES)
    : DEFAULT_REGISTRIES
  const port = Number(process.env.PORT ?? 8081)
  const server = createRegistryProxy({ registries })
  server.listen(port, '0.0.0.0', () =>
    console.log(`registry proxy: :${port} → ${Object.keys(registries).join(', ')}`),
  )
  for (const s of ['SIGTERM', 'SIGINT']) process.on(s, () => server.close(() => process.exit(0)))
}
