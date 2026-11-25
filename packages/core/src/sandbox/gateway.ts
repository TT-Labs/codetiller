import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import type { AgentResult } from '../agents/agent.js'
import type { Config } from '../config/config.js'
import { sha256 } from '../util/hash.js'
import { type ModelPrice, PRICES, type Prices, priceFor } from './prices.js'

const exec = promisify(execFile)

/** How an agent container reaches the model: the network it joins and the env it gets. */
export interface Egress {
  /** docker network for the agent container */
  network: string
  /** model endpoint + a placeholder key: nothing in here is a credential */
  env: Record<string, string>
}

/** What one agent run may do through the gateway. Enforced there, out of the agent's reach. */
export interface RunGrant {
  /** shown in the gateway's log and listings, e.g. `T-9 run 3` */
  label: string
  /** spend after which no further model call of this run is forwarded */
  budget_usd: number
  /** the only models the run may call */
  models: string[]
  /** USD per 1M tokens for each of `models`: what the spend is counted with */
  prices: Record<string, ModelPrice>
  /** after this long the gateway forgets a run nobody closed */
  ttl_s: number
}

/** The gateway's own count of what a run did: from the model API's answers, not from the agent. */
export interface GatewayUsage {
  label: string
  budget_usd: number
  spent_usd: number
  /** answered model calls */
  requests: number
  refused: number
  /** why calls were refused → how often */
  reasons: Record<string, number>
  /** the run reached its budget: calls after that were refused */
  budget_hit: boolean
  tokens: { input: number; output: number; cache_read: number; cache_write: number }
  models: Record<string, { requests: number; usd: number }>
}

export interface OpenRun extends Egress {
  /** end the run at the gateway (its key stops working); undefined = the gateway lost track of it */
  close(): Promise<GatewayUsage | undefined>
}

/**
 * The trust boundary for model access. The agent never gets the API key and
 * has no route to the internet; it can reach one thing, a gateway that forwards model API calls
 * and adds the key itself. Every call belongs to a run the factory opened: the gateway holds the
 * run's models and budget and counts what it spends.
 */
export interface ModelGateway {
  /** start (or reuse) the gateway and open a run on it; what the agent container needs to use it */
  open(grant: RunGrant): Promise<OpenRun>
  stop(): Promise<void>
}

/** The grant of a run of `config`: its model, its budget, for as long as it may take. */
export function grantFor(label: string, config: Config, prices: Prices = PRICES): RunGrant {
  const price = priceFor(config.model, prices)
  if (!price)
    throw new Error(
      `no price for model ${config.model}: the gateway cannot budget it (add it under \`prices\` in tiller.yaml)`,
    )
  return {
    label,
    budget_usd: config.limits.budget_usd,
    models: [config.model],
    prices: { [config.model]: price },
    ttl_s: config.limits.timeout_s + 600,
  }
}

export interface DockerGatewayOptions {
  /** the real model API key: goes to the gateway container only */
  key: string
  /** host path of `images/gateway/gateway.mjs` */
  script: string
  /** any image with node; the gateway has no dependencies */
  image?: string
  name?: string
  network?: string
}

export interface ModelAccess {
  env: Record<string, string>
  /** undefined = docker's default bridge (open internet) */
  network?: string
  via: 'gateway' | 'direct'
  /** the container has no route to the internet: tools must not wait for one */
  offline: boolean
  /** call when the agent is done: ends the run at the gateway and returns its accounting */
  close(): Promise<GatewayUsage | undefined>
}

/**
 * What an agent container gets to reach the model. With a gateway: no credential and no other
 * route. Without one (tests, or an explicit opt-out) the key itself on the default network.
 */
export async function modelAccess(
  credentials: Record<string, string>,
  gateway: ModelGateway | undefined,
  run: { label: string; config: Config; prices?: Prices },
): Promise<ModelAccess> {
  if (!gateway)
    return { env: credentials, via: 'direct', offline: false, close: async () => undefined }
  const { network, env, close } = await gateway.open(grantFor(run.label, run.config, run.prices))
  return { env, network, via: 'gateway', offline: true, close }
}

/**
 * A run's result as the trusted side saw it: the cost the gateway counted in place of the
 * agent's own figure, and `budget` when the run ended because the gateway stopped serving it.
 */
export function accounted(agent: AgentResult, usage: GatewayUsage | undefined): AgentResult {
  if (!usage) return agent
  return {
    ...agent,
    exit: usage.budget_hit && agent.exit === 'error' ? 'budget' : agent.exit,
    cost_usd: usage.spent_usd,
    cost_source: 'gateway',
    agent_cost_usd: agent.cost_usd,
  }
}

/**
 * Run the agent on an opened access and close the run at the gateway whatever happens, so its
 * key stops working with the container. Returns the accounted result and the gateway's count.
 */
export async function runAccounted(
  access: ModelAccess,
  run: () => Promise<AgentResult>,
): Promise<{ agent: AgentResult; usage: GatewayUsage | undefined }> {
  let result: AgentResult
  try {
    result = await run()
  } catch (e) {
    await access.close().catch(() => undefined)
    throw e
  }
  const usage = await access.close().catch(() => undefined)
  return { agent: accounted(result, usage), usage }
}

const PORT = 8080
/** what the agent gets instead of a key until a run is opened: the gateway serves nothing for it */
export const PLACEHOLDER_KEY = 'provided-by-the-gateway'

/** What an agent gets to find the gateway at `base`: an address and a placeholder, no credential. */
export const agentEnv = (base: string): Record<string, string> => ({
  ANTHROPIC_BASE_URL: base,
  ANTHROPIC_API_KEY: PLACEHOLDER_KEY,
  // telemetry, update checks and the like have nowhere to go: do not let them wait
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  DISABLE_AUTOUPDATER: '1',
})

/** the network agents are on; in Kubernetes the label a NetworkPolicy selects them by */
export const AGENTS_NETWORK = 'tiller-agents'

/**
 * A gateway somebody else runs (a Deployment and a Service in Kubernetes): the factory does not
 * start it and cannot enter its container, so it opens runs over the network with the secret
 * the two share. `agentUrl` is how agents reach it: by address, they have no DNS.
 */
export class ServiceGateway implements ModelGateway {
  constructor(
    private readonly opts: {
      /** how the factory reaches it, e.g. `http://tiller-gateway:8080` */
      url: string
      /** how agents reach it; resolved once per run when it is a function */
      agentUrl: string | (() => Promise<string>)
      adminToken: string
      network?: string
      fetcher?: typeof fetch
    },
  ) {}

  private async admin(method: string, path: string, body?: unknown): Promise<string> {
    const res = await (this.opts.fetcher ?? fetch)(`${this.opts.url}${path}`, {
      method,
      headers: { 'x-tiller-admin': this.opts.adminToken },
      body: body ? JSON.stringify(body) : undefined,
    })
    const text = await res.text()
    if (!res.ok)
      throw new Error(`model gateway ${method} ${path}: ${res.status} ${text.slice(0, 200)}`)
    return text
  }

  async open(grant: RunGrant): Promise<OpenRun> {
    const { agentUrl } = this.opts
    const base = typeof agentUrl === 'function' ? await agentUrl() : agentUrl
    const token = `tiller-run-${randomBytes(24).toString('hex')}`
    await this.admin('POST', '/admin/runs', { token, ...grant })
    return {
      network: this.opts.network ?? AGENTS_NETWORK,
      env: { ...agentEnv(base), ANTHROPIC_API_KEY: token },
      close: () =>
        this.admin('DELETE', `/admin/runs/${token}`).then(
          (out) => JSON.parse(out) as GatewayUsage,
          () => undefined,
        ),
    }
  }

  async runs(): Promise<GatewayUsage[]> {
    return JSON.parse(await this.admin('GET', '/admin/runs')) as GatewayUsage[]
  }

  /** not the factory's to stop */
  async stop() {}
}

/**
 * Gateway as a docker container on two networks: the default bridge (to reach the model API) and
 * an internal network without a route out, which is the only network agent containers join.
 * One gateway serves every factory process on the host; it is replaced when the script or the
 * key changes.
 */
export class DockerGateway implements ModelGateway {
  private readonly name: string
  private readonly network: string
  private readonly image: string
  private ready: Promise<Egress> | undefined

  constructor(private readonly opts: DockerGatewayOptions) {
    this.name = opts.name ?? 'tiller-gateway'
    this.network = opts.network ?? AGENTS_NETWORK
    this.image = opts.image ?? 'codetiller/base:dev'
  }

  private docker(args: string[], env?: Record<string, string>) {
    return exec('docker', args, { env: { ...process.env, ...env } }).then((r) => r.stdout.trim())
  }

  /**
   * The agent's "API key" is the name of its run: random, worth nothing outside the gateway, and
   * only as much as the run's budget inside it.
   */
  async open(grant: RunGrant): Promise<OpenRun> {
    const egress = await this.ensure()
    const token = `tiller-run-${randomBytes(24).toString('hex')}`
    await this.admin('POST', '/admin/runs', { token, ...grant })
    return {
      network: egress.network,
      env: { ...egress.env, ANTHROPIC_API_KEY: token },
      close: () =>
        this.admin('DELETE', `/admin/runs/${token}`).then(
          (out) => JSON.parse(out) as GatewayUsage,
          () => undefined,
        ),
    }
  }

  /** Runs open on the gateway right now, with what each has spent. */
  async runs(): Promise<GatewayUsage[]> {
    await this.ensure()
    return JSON.parse(await this.admin('GET', '/admin/runs')) as GatewayUsage[]
  }

  /**
   * Run administration is served to the gateway's own loopback only, so it is called from inside
   * its container: nothing on the agents' network, and no port on the host, can open a run.
   */
  private admin(method: string, path: string, body?: unknown): Promise<string> {
    const call = `fetch('http://127.0.0.1:${PORT}'+process.env.TILLER_PATH,{method:process.env.TILLER_METHOD,body:process.env.TILLER_BODY||undefined}).then(async r=>{process.stdout.write(await r.text());process.exit(r.ok?0:1)},e=>{console.error(e.message);process.exit(1)})`
    return this.docker(
      // by name only: nothing of a run is in argv
      [
        'exec',
        '-e',
        'TILLER_PATH',
        '-e',
        'TILLER_METHOD',
        '-e',
        'TILLER_BODY',
        this.name,
        'node',
        '-e',
        call,
      ],
      { TILLER_PATH: path, TILLER_METHOD: method, TILLER_BODY: body ? JSON.stringify(body) : '' },
    )
  }

  ensure(): Promise<Egress> {
    this.ready ??= this.start().catch((e) => {
      this.ready = undefined
      throw e
    })
    return this.ready
  }

  private async start(): Promise<Egress> {
    const egress: Egress = {
      network: this.network,
      env: agentEnv(`http://${this.name}:${PORT}`),
    }
    await this.ensureNetwork()
    // script or key changed → replace; the label holds a fingerprint, never the key
    const want = sha256(`${await readFile(this.opts.script, 'utf8')}\n${this.opts.key}`).slice(
      0,
      16,
    )
    const state = await this.docker([
      'inspect',
      '-f',
      '{{.State.Running}} {{index .Config.Labels "tiller.gateway"}}',
      this.name,
    ]).catch(() => '')
    if (state !== `true ${want}`) {
      await this.docker(['rm', '-f', this.name]).catch(() => {})
      await this.run(want).catch(async (e) => {
        // another factory process may have started the same gateway in between
        const now = await this.docker([
          'inspect',
          '-f',
          '{{index .Config.Labels "tiller.gateway"}}',
          this.name,
        ]).catch(() => '')
        if (now !== want) throw e
      })
    }
    await this.healthy()
    return egress
  }

  /** The agents' network must have no route out: refuse a same-named network that has one. */
  private async ensureNetwork() {
    const internal = await this.docker([
      'network',
      'inspect',
      '-f',
      '{{.Internal}}',
      this.network,
    ]).catch(() => null)
    if (internal === null) await this.docker(['network', 'create', '--internal', this.network])
    else if (internal !== 'true')
      throw new Error(
        `docker network ${this.network} exists but is not internal: agents on it could reach the internet`,
      )
  }

  private async run(fingerprint: string) {
    await this.docker(
      [
        'create',
        '--name',
        this.name,
        '--label',
        `tiller.gateway=${fingerprint}`,
        '--restart',
        'unless-stopped',
        '--user',
        '1000:1000',
        '--cap-drop',
        'ALL',
        '--security-opt',
        'no-new-privileges',
        '--memory',
        '256m',
        '--pids-limit',
        '128',
        // by name only: the key is not in argv
        '-e',
        'ANTHROPIC_API_KEY',
        this.image,
        'node',
        '/gateway.mjs',
      ],
      { ANTHROPIC_API_KEY: this.opts.key },
    )
    // The script is copied in, not mounted: a mount names a path of the docker host, and the
    // factory may itself run in a container whose files the host does not have.
    await this.docker(['cp', this.opts.script, `${this.name}:/gateway.mjs`])
    await this.docker(['network', 'connect', this.network, this.name])
    await this.docker(['start', this.name])
  }

  private async healthy() {
    const check = `fetch('http://127.0.0.1:${PORT}/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))`
    for (let i = 0; i < 40; i++) {
      const ok = await this.docker(['exec', this.name, 'node', '-e', check]).then(
        () => true,
        () => false,
      )
      if (ok) return
      await new Promise((r) => setTimeout(r, 250))
    }
    const logs = await this.docker(['logs', '--tail', '20', this.name]).catch(() => '')
    throw new Error(`model gateway did not come up: ${logs.slice(-500)}`)
  }

  async stop() {
    this.ready = undefined
    await this.docker(['rm', '-f', this.name]).catch(() => {})
  }
}
