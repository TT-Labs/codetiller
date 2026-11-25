import http from 'node:http'
import net, { type AddressInfo } from 'node:net'
import { gzipSync } from 'node:zlib'
import { afterAll, beforeAll, expect, it } from 'vitest'

// the proxy is a dependency-free script that runs in its own container (images/gateway)
interface ProxyModule {
  createRegistryProxy(o: {
    registries: Record<string, string>
    log?: (m: string) => void
  }): http.Server
}
const script = new URL('../../../../images/gateway/registry.mjs', import.meta.url).href
let upstream: http.Server
let proxy: http.Server
let base: string
let registry: string
const seen: { method: string; url: string; headers: http.IncomingHttpHeaders }[] = []

const listen = (s: http.Server) =>
  new Promise<number>((r) => s.listen(0, '127.0.0.1', () => r((s.address() as AddressInfo).port)))

beforeAll(async () => {
  const mod = (await import(/* @vite-ignore */ script)) as ProxyModule
  // stands in for a package registry: records what reaches it
  upstream = http.createServer((req, res) => {
    seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers })
    if (req.url?.endsWith('.tgz')) {
      res.writeHead(200, { 'content-type': 'application/octet-stream' })
      return res.end(Buffer.from([0x1f, 0x8b, 0x00, 0xff]))
    }
    const meta = JSON.stringify({
      name: 'left-pad',
      dist: { tarball: `${registry}left-pad/-/left-pad-1.3.0.tgz` },
    })
    // a registry compresses when asked to
    const gzip = req.headers['accept-encoding'] === 'gzip'
    res.writeHead(200, {
      'content-type': 'application/vnd.npm.install-v1+json',
      'set-cookie': 'session=1',
      etag: '"v1"',
      ...(gzip ? { 'content-encoding': 'gzip' } : {}),
    })
    res.end(gzip ? gzipSync(meta) : meta)
  })
  const port = await listen(upstream)
  registry = `http://127.0.0.1:${port}/registry/`
  proxy = mod.createRegistryProxy({
    registries: { npm: registry },
    log: () => {},
  })
  base = `http://127.0.0.1:${await listen(proxy)}`
})

afterAll(() => {
  proxy.close()
  upstream.close()
})

it('reads from the configured registry without passing credentials on', async () => {
  const res = await fetch(`${base}/npm/@scope%2fpkg?x=1`, {
    headers: {
      accept: 'application/vnd.npm.install-v1+json',
      authorization: 'Bearer npm_token_of_whoever',
      cookie: 'a=b',
      'x-anything': 'else',
    },
  })
  expect(res.status).toBe(200)
  // tarball URLs in the metadata point back at the proxy: the install cannot reach the registry
  const meta = (await res.json()) as { dist: { tarball: string } }
  expect(meta.dist.tarball).toBe(`${base}/npm/left-pad/-/left-pad-1.3.0.tgz`)
  const tarball = await fetch(meta.dist.tarball)
  expect(new Uint8Array(await tarball.arrayBuffer())).toEqual(
    new Uint8Array([0x1f, 0x8b, 0x00, 0xff]),
  )
  expect(seen.at(-1)?.url).toBe('/registry/left-pad/-/left-pad-1.3.0.tgz')
  seen.pop()
  expect(res.headers.get('etag')).toBe('"v1"')
  // the registry's cookies do not reach the install either
  expect(res.headers.get('set-cookie')).toBeNull()
  const call = seen.at(-1)
  expect(call).toMatchObject({ method: 'GET', url: '/registry/@scope%2fpkg?x=1' })
  expect(call?.headers.accept).toBe('application/vnd.npm.install-v1+json')
  expect(call?.headers.authorization).toBeUndefined()
  expect(call?.headers.cookie).toBeUndefined()
  expect(call?.headers['x-anything']).toBeUndefined()
})

it('refuses writes, other paths and use as a proxy', async () => {
  const before = seen.length
  for (const method of ['PUT', 'POST', 'DELETE', 'PATCH']) {
    const res = await fetch(`${base}/npm/pkg`, {
      method,
      body: method === 'DELETE' ? undefined : '{}',
    })
    expect([method, res.status]).toEqual([method, 405])
  }
  for (const path of ['/', '/other/pkg', '/npm', '/npm/../admin', '/go/mod'])
    expect([path, (await fetch(`${base}${path}`)).status]).toEqual([path, 404])
  const { port } = new URL(base)
  const raw = (request: string) =>
    new Promise<string>((resolve) => {
      let out = ''
      const sock = net.connect(Number(port), '127.0.0.1', () => sock.write(request))
      sock.on('data', (c) => {
        out += c
      })
      sock.on('close', () => resolve(out))
      sock.on('error', () => resolve(out))
    })
  expect(
    await raw('GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n\r\n'),
  ).toMatch(/^HTTP\/1\.1 404/)
  expect(await raw('CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n')).toMatch(
    /^HTTP\/1\.1 403/,
  )
  expect(seen.length).toBe(before)
})

it('rewrites compressed metadata too, and compresses only for a client that asked', async () => {
  // fetch asks for gzip (and decodes it): the registry was asked for gzip, the answer is rewritten
  const res = await fetch(`${base}/npm/left-pad`)
  expect(seen.at(-1)?.headers['accept-encoding']).toBe('gzip')
  expect(res.headers.get('content-encoding')).toBe('gzip')
  expect(((await res.json()) as { dist: { tarball: string } }).dist.tarball).toBe(
    `${base}/npm/left-pad/-/left-pad-1.3.0.tgz`,
  )
  // a client that takes no encoding gets plain text, and the registry is asked for none
  const { port } = new URL(base)
  const plain = await new Promise<string>((resolve) => {
    let out = ''
    const sock = net.connect(Number(port), '127.0.0.1', () =>
      sock.write(
        'GET /npm/left-pad HTTP/1.1\r\nHost: tiller-registry:8081\r\nConnection: close\r\n\r\n',
      ),
    )
    sock.on('data', (c) => {
      out += c
    })
    sock.on('close', () => resolve(out))
  })
  expect(seen.at(-1)?.headers['accept-encoding']).toBe('identity')
  expect(plain).not.toMatch(/content-encoding/i)
  // the address the client used is the one the tarballs are given
  expect(plain).toContain(
    '"tarball":"http://tiller-registry:8081/npm/left-pad/-/left-pad-1.3.0.tgz"',
  )
})

it("points every registry's file URLs back at itself: index pages, a second host, redirects", async () => {
  const mod = (await import(/* @vite-ignore */ script)) as ProxyModule
  // a Python index: an HTML page whose links are absolute URLs at another host, and a redirect
  const files = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream' })
    res.end('wheel')
  })
  const filesPort = await listen(files)
  const index = http.createServer((req, res) => {
    if (req.url === '/simple/Requests/') {
      res.writeHead(301, { location: `http://127.0.0.1:${indexPort}/simple/requests/` })
      return res.end()
    }
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(
      `<a href="http://127.0.0.1:${filesPort}/packages/ab/requests-2.0-py3-none-any.whl#sha256=abc">requests</a>`,
    )
  })
  const indexPort = await listen(index)
  const py = mod.createRegistryProxy({
    registries: {
      pypi: `http://127.0.0.1:${indexPort}`,
      pythonhosted: `http://127.0.0.1:${filesPort}`,
    },
    log: () => {},
  })
  const at = `http://127.0.0.1:${await listen(py)}`
  try {
    const moved = await fetch(`${at}/pypi/simple/Requests/`, { redirect: 'manual' })
    expect(moved.status).toBe(301)
    expect(moved.headers.get('location')).toBe(`${at}/pypi/simple/requests/`)
    const page = await (await fetch(`${at}/pypi/simple/requests/`)).text()
    expect(page).toBe(
      `<a href="${at}/pythonhosted/packages/ab/requests-2.0-py3-none-any.whl#sha256=abc">requests</a>`,
    )
    const file = /href="([^"#]+)/.exec(page)?.[1] as string
    expect(await (await fetch(file)).text()).toBe('wheel')
  } finally {
    py.close()
    index.close()
    files.close()
  }
})
