import http from 'node:http'
import net, { type AddressInfo } from 'node:net'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { accounted, type GatewayUsage } from './gateway.js'
import { type ModelPrice, PRICES } from './prices.js'

// the gateway is a dependency-free script that runs in its own container (images/gateway)
interface GatewayModule {
  forbidden(body: unknown): string | null
  cost(usage: unknown, price: ModelPrice): number
  createGateway(o: {
    upstream: string
    key: string
    log?: (m: string) => void
    admin?: (req: http.IncomingMessage) => boolean
  }): http.Server
  withAdminToken(token?: string): (req: http.IncomingMessage) => boolean
}
const script = new URL('../../../../images/gateway/gateway.mjs', import.meta.url).href
let gw: GatewayModule
let upstream: http.Server
let gateway: http.Server
let base: string
const seen: { method: string; url: string; headers: http.IncomingHttpHeaders; body: string }[] = []
const refusals: string[] = []
/** what the stand-in model API answers next (default: `{"ok":true}`) */
const replies: {
  json?: unknown
  status?: number
  sse?: { type: string; [k: string]: unknown }[]
  hold?: Promise<void>
}[] = []
const SONNET = PRICES['claude-sonnet-5-5'] as ModelPrice

const admin = (method: string, path: string, body?: unknown) =>
  fetch(`${base}${path}`, { method, body: body ? JSON.stringify(body) : undefined })
let n = 0
/** open a run as the factory does; returns the key the agent would hold */
async function openRun(grant: Record<string, unknown> = {}) {
  const token = `tiller-run-${String(++n).padStart(24, '0')}`
  const res = await admin('POST', '/admin/runs', {
    token,
    label: `test ${n}`,
    budget_usd: 1,
    models: ['claude-sonnet-5-5'],
    prices: { 'claude-sonnet-5-5': SONNET },
    ttl_s: 60,
    ...grant,
  })
  expect(res.status).toBe(200)
  return token
}
const usageOf = async (token: string) =>
  (await (await admin('GET', `/admin/runs/${token}`)).json()) as GatewayUsage
let key: string

const listen = (s: http.Server) =>
  new Promise<number>((r) => s.listen(0, '127.0.0.1', () => r((s.address() as AddressInfo).port)))

beforeAll(async () => {
  gw = (await import(/* @vite-ignore */ script)) as GatewayModule
  // stands in for the model API: records what reaches it
  upstream = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => {
      body += c
    })
    req.on('end', async () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body })
      const reply = replies.shift()
      if (reply?.hold) await reply.hold
      if (reply?.sse) {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        // split mid-line: events do not arrive aligned to chunks
        const text = reply.sse
          .map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
          .join('')
        res.write(text.slice(0, 37))
        await new Promise((r) => setTimeout(r, 5))
        return res.end(text.slice(37))
      }
      res.writeHead(reply?.status ?? 200, {
        'content-type': 'application/json',
        'request-id': 'req_1',
      })
      res.end(JSON.stringify(reply?.json ?? { ok: true }))
    })
  })
  const port = await listen(upstream)
  gateway = gw.createGateway({
    upstream: `http://127.0.0.1:${port}`,
    key: 'REAL-KEY',
    log: (m) => refusals.push(m),
  })
  base = `http://127.0.0.1:${await listen(gateway)}`
  key = await openRun()
})

afterAll(() => {
  gateway.close()
  upstream.close()
})

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })

it('forwards a model call with the real key in place of whatever the agent sent', async () => {
  const body = {
    model: 'claude-sonnet-5-5',
    messages: [],
    tools: [
      { name: 'Bash', input_schema: {} },
      { type: 'custom', name: 'x' },
      { type: 'bash_20250124', name: 'bash' },
    ],
  }
  const res = await post('/v1/messages?beta=true', body, {
    authorization: 'Bearer agent-chosen',
    'anthropic-beta': 'some-beta',
  })
  expect(res.status).toBe(200)
  expect(res.headers.get('request-id')).toBe('req_1')
  expect(await res.json()).toEqual({ ok: true })
  const call = seen.at(-1)
  expect(call).toMatchObject({
    method: 'POST',
    url: '/v1/messages?beta=true',
    body: JSON.stringify(body),
  })
  expect(call?.headers['x-api-key']).toBe('REAL-KEY')
  expect(call?.headers.authorization).toBeUndefined()
  // the answer must come back readable: usage is counted from it
  expect(call?.headers['accept-encoding']).toBe('identity')
  expect(call?.headers['anthropic-beta']).toBe('some-beta')
})

it('refuses tools the model API would run on its own servers, and remote MCP', async () => {
  const before = seen.length
  for (const body of [
    { tools: [{ type: 'web_fetch_20250910', name: 'web_fetch' }] },
    { tools: [{ type: 'web_search_20250305', name: 'web_search' }] },
    { tools: [{ type: 'code_execution_20250825', name: 'code_execution' }] },
    { tools: [{ name: 'ok' }, { type: 'something_new', name: 'x' }] },
    { tools: [{ type: 7 }] },
    { tools: 'web_fetch' },
    { mcp_servers: [{ type: 'url', url: 'https://evil.example/mcp' }] },
    [],
  ])
    expect((await post('/v1/messages', body)).status).toBe(403)
  expect((await post('/v1/messages', 'not json')).status).toBe(403)
  // nothing of it reached the model API
  expect(seen.length).toBe(before)
  expect(refusals.join('\n')).toContain('server-side tool "web_fetch_20250910"')
  expect(refusals.join('\n')).toContain('mcp_servers (remote MCP)')
  expect(gw.forbidden({ tools: [], mcp_servers: [] })).toBeNull()
})

it('serves only the calls an agent run needs', async () => {
  const before = seen.length
  expect((await fetch(`${base}/v1/models`, { headers: { 'x-api-key': key } })).status).toBe(200)
  expect(
    (await post('/v1/messages/count_tokens', { model: 'claude-sonnet-5-5', messages: [] })).status,
  ).toBe(200)
  for (const [method, path] of [
    ['POST', '/v1/messages/batches'],
    ['POST', '/v1/files'],
    ['GET', '/v1/messages'],
    ['GET', '/v1/organizations/api_keys'],
    ['GET', '/'],
    ['GET', '/v1/models/../messages'],
    ['DELETE', '/v1/models'],
  ] as const) {
    const res = await fetch(`${base}${path}`, {
      method,
      ...(method === 'POST' ? { body: '{}' } : {}),
    })
    expect([path, res.status]).toEqual([path, 403])
  }
  expect(seen.length).toBe(before + 2)
})

it('is not a proxy: absolute URLs and CONNECT go nowhere', async () => {
  const { port } = new URL(base)
  // a raw socket: fetch cannot send an absolute-URI request line or CONNECT
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
  const before = seen.length
  expect(
    await raw(
      'GET http://example.com/v1/models HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n\r\n',
    ),
  ).toMatch(/^HTTP\/1\.1 403/)
  expect(await raw('CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n')).toMatch(
    /^HTTP\/1\.1 403/,
  )
  expect(seen.length).toBe(before)
})

it('health says nothing about the key', async () => {
  const text = await (await fetch(`${base}/healthz`)).text()
  expect(JSON.parse(text)).toMatchObject({ ok: true })
  expect(text).not.toContain('REAL-KEY')
})

const ask = (token: string, body: Record<string, unknown> = {}) =>
  fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: { 'x-api-key': token },
    body: JSON.stringify({ model: 'claude-sonnet-5-5', max_tokens: 100, messages: [], ...body }),
  })

it('serves nothing without an open run: unknown, closed and expired keys are refused', async () => {
  const before = seen.length
  expect((await ask('provided-by-the-gateway')).status).toBe(401)
  expect((await fetch(`${base}/v1/models`)).status).toBe(401)
  const token = await openRun()
  expect((await ask(token)).status).toBe(200)
  expect((await admin('DELETE', `/admin/runs/${token}`)).status).toBe(200)
  expect((await ask(token)).status).toBe(401)
  const brief = await openRun({ ttl_s: 0.001 })
  await new Promise((r) => setTimeout(r, 10))
  expect((await ask(brief)).status).toBe(401)
  expect(seen.length).toBe(before + 1)
})

it('forwards only the models of the run', async () => {
  const token = await openRun()
  const before = seen.length
  const res = await ask(token, { model: 'claude-opus-5-5' })
  expect(res.status).toBe(403)
  expect(((await res.json()) as { error: { message: string } }).error.message).toBe(
    'gateway: model "claude-opus-5-5" is not allowed for this run',
  )
  expect((await ask(token, { model: undefined })).status).toBe(403)
  expect((await ask(token, { speed: 'fast' })).status).toBe(403)
  expect(
    (
      await fetch(`${base}/v1/messages/count_tokens`, {
        method: 'POST',
        headers: { 'x-api-key': token },
        body: JSON.stringify({ model: 'claude-opus-5-5', messages: [] }),
      })
    ).status,
  ).toBe(403)
  // a dated snapshot of the run's model is the same model
  expect((await ask(token, { model: 'claude-sonnet-5-5-20260901' })).status).toBe(200)
  expect(seen.length).toBe(before + 1)
  expect(await usageOf(token)).toMatchObject({
    refused: 4,
    reasons: { 'model "claude-opus-5-5" is not allowed for this run': 2 },
  })
})

it('counts what a run spends from the answers, plain and streamed', async () => {
  const token = await openRun()
  replies.push({
    json: {
      usage: {
        input_tokens: 1000,
        output_tokens: 2000,
        cache_read_input_tokens: 100_000,
        cache_creation_input_tokens: 10_000,
        cache_creation: { ephemeral_5m_input_tokens: 4000, ephemeral_1h_input_tokens: 6000 },
      },
    },
  })
  expect((await ask(token)).status).toBe(200)
  // 1000×2 + 2000×10 + 100000×0.1 + 4000×2.5 + 6000×4, per million
  expect((await usageOf(token)).spent_usd).toBeCloseTo(0.066, 9)
  replies.push({
    sse: [
      {
        type: 'message_start',
        message: { usage: { input_tokens: 10, cache_read_input_tokens: 50_000, output_tokens: 1 } },
      },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'a "usage" in the text' } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3000 } },
      { type: 'message_stop' },
    ],
  })
  const streamed = await ask(token, { stream: true })
  expect(await streamed.text()).toContain('event: message_stop')
  // 10×2 + 50000×0.1 + 3000×10
  const usage = await usageOf(token)
  expect(usage.spent_usd).toBeCloseTo(0.066 + 0.03502, 9)
  expect(usage).toMatchObject({
    requests: 2,
    refused: 0,
    budget_hit: false,
    tokens: { input: 1010, output: 5000, cache_read: 150_000, cache_write: 10_000 },
    models: { 'claude-sonnet-5-5': { requests: 2 } },
  })
  // an error answer costs nothing; count_tokens is free
  replies.push({ status: 529, json: { type: 'error', error: { type: 'overloaded_error' } } })
  expect((await ask(token)).status).toBe(529)
  expect((await usageOf(token)).requests).toBe(2)
})

it('stops a run at its budget: one request may cross it, none starts after', async () => {
  const token = await openRun({ budget_usd: 0.05 })
  const before = seen.length
  replies.push(
    { json: { usage: { output_tokens: 4000 } } },
    { json: { usage: { output_tokens: 2000 } } },
  )
  expect((await ask(token)).status).toBe(200) // $0.04
  expect((await ask(token)).status).toBe(200) // $0.06: over, by this request
  const res = await ask(token)
  expect(res.status).toBe(402)
  expect(res.headers.get('x-should-retry')).toBe('false')
  expect(((await res.json()) as { error: { message: string } }).error.message).toBe(
    'gateway: the budget of this run is spent ($0.0600 of $0.0500)',
  )
  expect(seen.length).toBe(before + 2)
  expect(await usageOf(token)).toMatchObject({ budget_hit: true, requests: 2, refused: 1 })
  // the count is what closing the run returns to the factory
  const closed = (await (await admin('DELETE', `/admin/runs/${token}`)).json()) as GatewayUsage
  expect(closed.spent_usd).toBeCloseTo(0.06, 9)
})

it('near the budget requests go one at a time, and never more than the cap at once', async () => {
  // worst case of one request here: 128000 tokens out at $10/M = $1.28 > budget
  const token = await openRun({ budget_usd: 1, max_parallel: 2 })
  let release = () => {}
  const hold = new Promise<void>((r) => {
    release = r
  })
  replies.push({ hold, json: { usage: { output_tokens: 10 } } })
  const first = ask(token, { max_tokens: 128_000 })
  await new Promise((r) => setTimeout(r, 20))
  const beside = await ask(token, { max_tokens: 128_000 })
  expect(beside.status).toBe(429)
  expect(beside.headers.get('x-should-retry')).toBe('true')
  release()
  expect((await first).status).toBe(200)
  // counted and released: the next one passes
  expect((await ask(token, { max_tokens: 128_000 })).status).toBe(200)

  const wide = await openRun({ budget_usd: 1000, max_parallel: 2 })
  let go = () => {}
  const wait = new Promise<void>((r) => {
    go = r
  })
  replies.push({ hold: wait }, { hold: wait })
  const held = [ask(wide), ask(wide)]
  await new Promise((r) => setTimeout(r, 20))
  const third = await ask(wide)
  expect(third.status).toBe(429)
  go()
  expect((await Promise.all(held)).map((r) => r.status)).toEqual([200, 200])
})

it("runs are opened from the gateway's own container only, with complete prices", async () => {
  for (const bad of [
    { budget_usd: 0 },
    { models: [] },
    { models: ['claude-opus-5-5'] }, // no price given for it
    { prices: { 'claude-sonnet-5-5': { ...SONNET, cache_read: undefined } } },
    { token: 'short' },
  ]) {
    const res = await admin('POST', '/admin/runs', {
      token: 'tiller-run-000000000000000000000bad',
      budget_usd: 1,
      models: ['claude-sonnet-5-5'],
      prices: { 'claude-sonnet-5-5': SONNET },
      ...bad,
    })
    expect([bad, res.status]).toEqual([bad, 400])
  }
  expect((await admin('GET', '/admin/runs/tiller-run-000000000000000000000bad')).status).toBe(404)
  // from anywhere else (an agent container) the same calls are refused
  const closed = gw.createGateway({
    upstream: 'http://127.0.0.1:1',
    key: 'k',
    admin: () => false,
    log: () => {},
  })
  const port = await listen(closed)
  try {
    for (const [method, path] of [
      ['POST', '/admin/runs'],
      ['GET', '/admin/runs'],
      ['DELETE', `/admin/runs/${key}`],
    ] as const) {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        body: method === 'POST' ? '{}' : undefined,
      })
      expect(res.status).toBe(403)
    }
  } finally {
    closed.close()
  }
})

it('prices a request by the table: long prompts, hour-long cache writes, pinned geography', () => {
  const haiku = PRICES['claude-haiku-5-5'] as ModelPrice
  expect(gw.cost({ input_tokens: 100_000, output_tokens: 1000 }, haiku)).toBeCloseTo(0.0105, 9)
  // over 100k of prompt, cache reads included: the whole request at the higher rates
  expect(
    gw.cost({ input_tokens: 1, cache_read_input_tokens: 100_000, output_tokens: 1000 }, haiku),
  ).toBeCloseTo((0.5 + 100_000 * 0.05 + 2500) / 1e6, 9)
  // no breakdown: cache writes count as 5-minute ones
  expect(gw.cost({ cache_creation_input_tokens: 1_000_000 }, SONNET)).toBeCloseTo(2.5, 9)
  expect(gw.cost({ output_tokens: 1_000_000, inference_geo: 'us' }, SONNET)).toBeCloseTo(11, 9)
  expect(gw.cost({ output_tokens: 1_000_000, inference_geo: 'global' }, SONNET)).toBeCloseTo(10, 9)
  expect(gw.cost({ input_tokens: -5, output_tokens: 'x' }, SONNET)).toBe(0)
})

it("a run's cost and a budget stop are taken from the gateway's count, not from the agent", () => {
  const agent = {
    exit: 'error' as const,
    cost_usd: 0.9,
    cost_source: 'reported' as const,
    duration_s: 1,
    transcript: '',
  }
  const usage = { spent_usd: 0.25, budget_hit: true } as GatewayUsage
  expect(accounted(agent, usage)).toMatchObject({
    exit: 'budget',
    cost_usd: 0.25,
    cost_source: 'gateway',
    agent_cost_usd: 0.9,
  })
  // an agent that finished is not turned into a failure by having reached the budget on the way
  expect(accounted({ ...agent, exit: 'ok' }, usage).exit).toBe('ok')
  expect(accounted(agent, { ...usage, budget_hit: false }).exit).toBe('error')
  // no gateway (or it lost the run): the agent's figure stands, marked as such
  expect(accounted(agent, undefined)).toBe(agent)
})

it('over the network a run is administered only with the secret of the factory', () => {
  const secret = 'a'.repeat(48)
  const from = (address: string, header?: string) =>
    ({
      socket: { remoteAddress: address },
      headers: header === undefined ? {} : { 'x-tiller-admin': header },
    }) as unknown as http.IncomingMessage
  const admin = gw.withAdminToken(secret)
  expect(admin(from('10.42.0.7', secret))).toBe(true)
  // an agent on the same network: no secret, a wrong one, a prefix of it
  expect(admin(from('10.42.0.9'))).toBe(false)
  expect(admin(from('10.42.0.9', 'b'.repeat(48)))).toBe(false)
  expect(admin(from('10.42.0.9', secret.slice(0, 40)))).toBe(false)
  // the gateway's own loopback still counts (docker exec)
  expect(admin(from('127.0.0.1'))).toBe(true)
  // no secret configured, or one too short to be one: loopback only, whatever is sent
  expect(gw.withAdminToken(undefined)(from('10.42.0.7', ''))).toBe(false)
  expect(gw.withAdminToken('short')(from('10.42.0.7', 'short'))).toBe(false)
})
