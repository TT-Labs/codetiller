// Model gateway: the only thing an agent container can reach. It forwards the
// model API calls an agent needs to one fixed upstream and adds the API key itself, so the agent
// holds no credential and has no other way out. It also holds what the agent must not be able to
// change: which models a run may call and how much it may spend. Runs in its own container; no
// dependencies.
import crypto from 'node:crypto'
import http from 'node:http'
import https from 'node:https'
import { pathToFileURL } from 'node:url'

// What an agent may ask the model API for. Everything else under /v1/ (batches, files, admin)
// is refused: each is a place to park data or spend money that no agent run needs.
const ALLOWED = [
  ['POST', /^\/v1\/messages(\?.*)?$/],
  ['POST', /^\/v1\/messages\/count_tokens(\?.*)?$/],
  ['GET', /^\/v1\/models(\/[\w.-]+)?(\?.*)?$/],
]
const BILLED = /^\/v1\/messages(\?.*)?$/

// Tools the model API runs on its own servers can reach the internet for the agent (web search,
// web fetch, remote MCP servers): a way out that no network rule on the container closes. Only
// tools the client executes pass: those without a type, `custom`, and the client-side families.
const CLIENT_TOOL = /^(custom$|bash_|text_editor_|computer_|memory_)/
const MAX_BODY = 32 * 1024 * 1024
// the most a model writes in one answer: what a request without a usable `max_tokens` is held to
const MAX_OUTPUT = 128_000

// never forwarded from the agent: it must not choose the credential or the destination, and the
// answer has to come back readable (usage is counted from it)
const DROPPED = new Set([
  'host',
  'x-api-key',
  'authorization',
  'proxy-authorization',
  'connection',
  'content-length',
  'transfer-encoding',
  'accept-encoding',
])

/** why a /v1/messages body may not pass, or null */
export function forbidden(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'body is not a JSON object'
  if (
    body.mcp_servers !== undefined &&
    !(Array.isArray(body.mcp_servers) && body.mcp_servers.length === 0)
  )
    return 'mcp_servers (remote MCP)'
  if (body.tools !== undefined && !Array.isArray(body.tools)) return 'tools is not a list'
  for (const tool of body.tools ?? []) {
    const type = tool?.type
    if (type !== undefined && !(typeof type === 'string' && CLIENT_TOOL.test(type)))
      return `server-side tool ${JSON.stringify(type)}`
  }
  // priced differently from the table a run's budget is counted with
  if (body.speed !== undefined && body.speed !== 'standard')
    return `speed ${JSON.stringify(body.speed)} (not budgeted)`
  return null
}

const PRICE_FIELDS = ['input', 'output', 'cache_read', 'cache_write_5m', 'cache_write_1h']
const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)

/** The price entry for a model id: its own, or the one it is a dated snapshot of. */
export function priceOf(prices, model) {
  if (typeof model !== 'string') return undefined
  if (Object.hasOwn(prices, model)) return prices[model]
  const dated = /^(.+)-\d{8}$/.exec(model)
  return dated && Object.hasOwn(prices, dated[1]) ? prices[dated[1]] : undefined
}

/**
 * USD of one answer's `usage` at a model's prices (USD per 1M tokens). `long` = the prices of a
 * request whose prompt (input + cache reads + cache writes) is over `long.over` tokens.
 */
export function cost(usage, price) {
  const input = num(usage?.input_tokens)
  const read = num(usage?.cache_read_input_tokens)
  const written = num(usage?.cache_creation_input_tokens)
  const w1h = num(usage?.cache_creation?.ephemeral_1h_input_tokens)
  // without the breakdown a cache write counts as a 5-minute one
  const w5m = Math.max(num(usage?.cache_creation?.ephemeral_5m_input_tokens), written - w1h, 0)
  const p = price.long && input + read + w5m + w1h > price.long.over ? price.long : price
  const usd =
    (input * p.input +
      num(usage?.output_tokens) * p.output +
      read * p.cache_read +
      w5m * p.cache_write_5m +
      w1h * p.cache_write_1h) /
    1e6
  // inference pinned to one geography is billed 1.1× on every token category
  const geo = usage?.inference_geo
  return usd * (typeof geo === 'string' && geo !== 'global' && geo !== 'not_available' ? 1.1 : 1)
}

/** The most a request can cost: every byte of it a token at the dearest input price, all of `max_tokens` written. */
function worstCase(bytes, maxTokens, price) {
  const each = (p) => Math.max(...PRICE_FIELDS.filter((f) => f !== 'output').map((f) => p[f]))
  const input = Math.max(each(price), price.long ? each(price.long) : 0)
  const output = Math.max(price.output, price.long?.output ?? 0)
  const tokens = Number.isInteger(maxTokens) && maxTokens > 0 ? maxTokens : MAX_OUTPUT
  return (bytes * input + Math.min(tokens, MAX_OUTPUT) * output) / 1e6
}

/**
 * Follows an answer on its way to the agent and keeps the last `usage` it carried: the fields
 * of `message_start` and `message_delta` of a stream, or the `usage` of a plain JSON answer.
 */
function usageTap(contentType) {
  const usage = {}
  let seen = false
  const merge = (u) => {
    if (u && typeof u === 'object') {
      Object.assign(usage, u)
      seen = true
    }
  }
  const stream = /text\/event-stream/i.test(contentType ?? '')
  let rest = ''
  return {
    write(chunk) {
      rest += chunk.toString('utf8')
      if (!stream) return
      const lines = rest.split('\n')
      rest = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.startsWith('data:') || !line.includes('"usage"')) continue
        try {
          const ev = JSON.parse(line.slice(5))
          if (ev.type === 'message_start') merge(ev.message?.usage)
          else if (ev.type === 'message_delta') merge(ev.usage)
        } catch {
          // not an event of ours
        }
      }
    },
    end() {
      if (!stream) {
        try {
          merge(JSON.parse(rest).usage)
        } catch {
          // an answer without usage costs nothing we can count
        }
      }
      return seen ? usage : undefined
    },
  }
}

const readBody = (req, limit = MAX_BODY) =>
  new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > limit) reject(new Error('body too large'))
      else chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
/** Runs are opened and closed from inside the gateway's own container only (`docker exec`). */
export const fromLoopback = (req) => LOOPBACK.has(req.socket.remoteAddress ?? '')

export const ADMIN_HEADER = 'x-tiller-admin'
/**
 * Where the factory cannot enter the gateway's container (Kubernetes), it opens runs over the
 * network and proves itself with a secret only the two of them hold. An agent has the same
 * address and no secret; one shorter than 32 characters is not accepted as one.
 */
export function withAdminToken(token) {
  const want = Buffer.from(String(token ?? ''))
  if (want.length < 32) return fromLoopback
  return (req) => {
    if (fromLoopback(req)) return true
    const got = Buffer.from(String(req.headers[ADMIN_HEADER] ?? ''))
    return got.length === want.length && crypto.timingSafeEqual(got, want)
  }
}

const ERROR_TYPE = {
  401: 'authentication_error',
  402: 'billing_error',
  403: 'permission_error',
  413: 'request_too_large',
  429: 'rate_limit_error',
}

/** What the factory may set for a run; throws on anything else. */
function runFrom(body, now) {
  const fail = (why) => {
    throw new Error(why)
  }
  if (!body || typeof body !== 'object') fail('body is not a JSON object')
  if (typeof body.token !== 'string' || !/^[\w-]{24,200}$/.test(body.token)) fail('bad token')
  if (!(num(body.budget_usd) > 0)) fail('budget_usd must be positive')
  const models = body.models
  if (!Array.isArray(models) || !models.length || models.some((m) => typeof m !== 'string'))
    fail('models must be a list of model ids')
  const prices = {}
  for (const model of models) {
    const price = body.prices?.[model]
    const complete = (p) => p && PRICE_FIELDS.every((f) => num(p[f]) > 0)
    if (!complete(price) || (price.long && !(complete(price.long) && num(price.long.over) > 0)))
      fail(`no complete price for ${model}`)
    prices[model] = price
  }
  return {
    token: body.token,
    label: String(body.label ?? '').slice(0, 80),
    budget_usd: body.budget_usd,
    models,
    prices,
    max_parallel:
      Number.isInteger(body.max_parallel) && body.max_parallel > 0 ? body.max_parallel : 8,
    // a run nobody closed (factory died) stops being served
    expires: now + (num(body.ttl_s) || 3600) * 1000,
    spent_usd: 0,
    reserved_usd: 0,
    active: 0,
    requests: 0,
    refused: 0,
    reasons: {},
    budget_hit: false,
    tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
    by_model: {},
  }
}

const report = (run) => ({
  label: run.label,
  budget_usd: run.budget_usd,
  spent_usd: Math.round(run.spent_usd * 1e6) / 1e6,
  requests: run.requests,
  refused: run.refused,
  reasons: run.reasons,
  budget_hit: run.budget_hit,
  tokens: run.tokens,
  models: run.by_model,
})

/**
 * The gateway as an http server (not listening yet). `upstream` is where calls go, `key` what
 * they carry. `admin` says which requests may open and close runs.
 */
export function createGateway({ upstream, key, log = console.log, admin = fromLoopback }) {
  const target = new URL(upstream)
  const transport = target.protocol === 'http:' ? http : https
  let forwarded = 0
  let refused = 0
  /** token → run: the agent's "API key" is the name of its run, nothing more */
  const runs = new Map()

  const refuse = (res, status, why, run, headers = {}) => {
    refused++
    if (run) {
      run.refused++
      const reason = why.replace(/\$[\d.]+/g, '$…')
      run.reasons[reason] = (run.reasons[reason] ?? 0) + 1
    }
    // the reason only: never a body, never a header
    log(`refused ${status}${run ? ` [${run.label}]` : ''}: ${why}`)
    // shaped like the model API's own errors so a client shows the reason; never retried unless said so
    res.writeHead(status, {
      'content-type': 'application/json',
      'x-should-retry': 'false',
      ...headers,
    })
    res.end(
      `${JSON.stringify({ type: 'error', error: { type: ERROR_TYPE[status] ?? 'api_error', message: `gateway: ${why}` } })}\n`,
    )
  }

  const runOf = (req) => {
    const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')?.[1]
    const run = runs.get(String(req.headers['x-api-key'] ?? bearer ?? ''))
    if (run && run.expires < Date.now()) {
      runs.delete(run.token)
      return undefined
    }
    return run
  }

  const adminCall = async (req, res, url) => {
    const json = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    const token = /^\/admin\/runs\/([\w-]+)$/.exec(url)?.[1]
    if (req.method === 'POST' && url === '/admin/runs') {
      try {
        const run = runFrom(
          JSON.parse((await readBody(req, 1024 * 1024)).toString('utf8')),
          Date.now(),
        )
        runs.set(run.token, run)
        log(`run opened [${run.label}]: $${run.budget_usd} on ${run.models.join(', ')}`)
        return json(200, { ok: true })
      } catch (e) {
        return json(400, { error: e.message })
      }
    }
    req.resume()
    if (req.method === 'GET' && url === '/admin/runs')
      return json(200, [...runs.values()].map(report))
    const run = token && runs.get(token)
    if (!run) return json(404, { error: 'no such run' })
    if (req.method === 'DELETE') {
      runs.delete(token)
      log(
        `run closed [${run.label}]: $${run.spent_usd.toFixed(4)} in ${run.requests} requests, ${run.refused} refused`,
      )
    } else if (req.method !== 'GET') return json(405, { error: 'method not allowed' })
    return json(200, report(run))
  }

  const server = http.createServer(async (req, res) => {
    const url = req.url ?? ''
    if (req.method === 'GET' && url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(
        JSON.stringify({ ok: true, upstream: target.host, forwarded, refused, runs: runs.size }),
      )
    }
    if (url.startsWith('/admin/')) {
      if (admin(req)) return adminCall(req, res, url)
      req.resume()
      return refuse(res, 403, 'run administration is not reachable from here')
    }
    // origin-form paths of the allowed endpoints only: no absolute URLs (proxy use), no traversal
    const allowed = ALLOWED.some(([method, path]) => req.method === method && path.test(url))
    if (!allowed || url.includes('..')) {
      req.resume()
      const what = `${req.method} ${url.split('?')[0].slice(0, 80)}`
      return refuse(res, 403, `${what} is not an allowed model API call`)
    }
    const run = runOf(req)
    if (!run) {
      req.resume()
      return refuse(res, 401, 'no open run for this key')
    }
    let body
    try {
      body = await readBody(req)
    } catch (e) {
      return refuse(res, 413, e.message, run)
    }
    let price
    let model
    let reserve = 0
    const billed = BILLED.test(url)
    if (req.method === 'POST') {
      let parsed
      let why
      try {
        parsed = JSON.parse(body.toString('utf8'))
        why = forbidden(parsed)
      } catch {
        why = 'body is not JSON'
      }
      if (why) return refuse(res, 403, why, run)
      model = parsed.model
      price = priceOf(run.prices, model)
      if (!price)
        return refuse(
          res,
          403,
          `model ${JSON.stringify(String(model).slice(0, 80))} is not allowed for this run`,
          run,
        )
      if (billed) {
        if (run.spent_usd >= run.budget_usd) {
          run.budget_hit = true
          const digits = run.budget_usd < 0.1 ? 4 : 2
          const spent = `$${run.spent_usd.toFixed(digits)} of $${run.budget_usd.toFixed(digits)}`
          return refuse(res, 402, `the budget of this run is spent (${spent})`, run)
        }
        if (run.active >= run.max_parallel)
          return refuse(res, 429, `more than ${run.max_parallel} requests at once`, run, {
            'x-should-retry': 'true',
            'retry-after': '1',
          })
        // One request alone may take a run over its budget, by its own cost at most. Requests
        // beside it may not: they wait until what is in flight has been counted.
        reserve = worstCase(body.length, parsed.max_tokens, price)
        if (run.active > 0 && run.spent_usd + run.reserved_usd + reserve > run.budget_usd)
          return refuse(res, 429, 'close to the budget: one request at a time', run, {
            'x-should-retry': 'true',
            'retry-after': '2',
          })
        run.active++
        run.reserved_usd += reserve
      }
    }
    let open = billed
    /** count the answer (once): what it cost, or nothing when it never came */
    const settle = (usage) => {
      if (!open) return
      open = false
      run.active--
      run.reserved_usd = Math.max(0, run.reserved_usd - reserve)
      if (!usage) return
      const usd = cost(usage, price)
      run.spent_usd += usd
      run.requests++
      run.tokens.input += num(usage.input_tokens)
      run.tokens.output += num(usage.output_tokens)
      run.tokens.cache_read += num(usage.cache_read_input_tokens)
      run.tokens.cache_write += num(usage.cache_creation_input_tokens)
      run.by_model[model] ??= { requests: 0, usd: 0 }
      const m = run.by_model[model]
      m.requests++
      m.usd = Math.round((m.usd + usd) * 1e6) / 1e6
      if (run.spent_usd >= run.budget_usd) run.budget_hit = true
    }
    const headers = Object.fromEntries(
      Object.entries(req.headers).filter(([name]) => !DROPPED.has(name.toLowerCase())),
    )
    const up = transport.request(
      {
        protocol: target.protocol,
        host: target.hostname,
        port: target.port || (target.protocol === 'http:' ? 80 : 443),
        method: req.method,
        path: url,
        // the body was read whole: send it as received, with its length
        headers: {
          ...headers,
          host: target.host,
          'x-api-key': key,
          'content-length': body.length,
          'accept-encoding': 'identity',
        },
      },
      (answer) => {
        forwarded++
        res.writeHead(answer.statusCode ?? 502, answer.headers)
        if (!billed) return answer.pipe(res)
        const tap = usageTap(answer.headers['content-type'])
        answer.on('data', (c) => {
          tap.write(c)
          res.write(c)
        })
        answer.on('end', () => {
          settle(tap.end())
          res.end()
        })
        // cut off on the way: what was seen until then is what gets counted
        answer.on('error', () => {
          settle(tap.end())
          res.destroy()
        })
        res.on('close', () => {
          if (open) {
            settle(tap.end())
            answer.destroy()
          }
        })
      },
    )
    up.on('error', (e) => {
      settle(undefined)
      if (res.headersSent) res.destroy()
      else
        refuse(res, 502, `upstream error: ${e.code ?? e.message}`, run, {
          'x-should-retry': 'true',
        })
    })
    up.end(body)
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
  const key = process.env.ANTHROPIC_API_KEY
  if (!key) {
    console.error('gateway: ANTHROPIC_API_KEY not set')
    process.exit(1)
  }
  const upstream = process.env.TILLER_UPSTREAM ?? 'https://api.anthropic.com'
  const port = Number(process.env.PORT ?? 8080)
  const server = createGateway({
    upstream,
    key,
    admin: withAdminToken(process.env.TILLER_ADMIN_TOKEN),
  })
  server.listen(port, '0.0.0.0', () => console.log(`gateway: :${port} → ${new URL(upstream).host}`))
  for (const s of ['SIGTERM', 'SIGINT']) process.on(s, () => server.close(() => process.exit(0)))
}
