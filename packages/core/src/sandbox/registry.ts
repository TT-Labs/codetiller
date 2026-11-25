import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { sha256 } from '../util/hash.js'

const exec = promisify(execFile)
const PORT = 8081

/** How a dependency-install container reaches the package registries: its network and its env. */
export interface InstallAccess {
  /** docker network without a route out: the registry proxy is the only thing on it */
  network: string
  /** registry settings of the package managers, pointing at the proxy; no credential */
  env: Record<string, string>
}

/**
 * Installs run code the agent chose and need the registry. They get no route
 * to the internet, only this proxy, which reads from the configured registries and nothing else.
 */
export interface RegistryProxy {
  ensure(): Promise<InstallAccess>
  stop(): Promise<void>
}

export interface DockerRegistryProxyOptions {
  /** host path of `images/gateway/registry.mjs` */
  script: string
  /** name → upstream URL, served at `/<name>/`; default: npm, the Go module proxy and PyPI */
  registries?: Record<string, string>
  /** any image with node; the proxy has no dependencies */
  image?: string
  name?: string
  network?: string
}

/** the network installs are on; in Kubernetes the label a NetworkPolicy selects them by */
export const INSTALL_NETWORK = 'tiller-install'

/** What an install gets to find the proxy at `host`: registry settings, no credential. */
export function installAccess(host: string, network = INSTALL_NETWORK, port = PORT): InstallAccess {
  const base = `http://${host}:${port}`
  return {
    network,
    env: {
      // npm, pnpm (which reads its own prefix, not npm's), bun, yarn (classic reads npm's
      // setting; berry has its own and must be told that plain http is meant) and corepack
      npm_config_registry: `${base}/npm/`,
      pnpm_config_registry: `${base}/npm/`,
      BUN_CONFIG_REGISTRY: `${base}/npm/`,
      YARN_NPM_REGISTRY_SERVER: `${base}/npm`,
      YARN_UNSAFE_HTTP_WHITELIST: host,
      COREPACK_NPM_REGISTRY: `${base}/npm`,
      // Go modules and, through the proxy's /sumdb/, their checksums
      GOPROXY: `${base}/go/`,
      // Python: pip and uv; the index is plain http inside the closed network
      PIP_INDEX_URL: `${base}/pypi/simple/`,
      PIP_TRUSTED_HOST: host,
      UV_DEFAULT_INDEX: `${base}/pypi/simple/`,
      UV_INDEX_URL: `${base}/pypi/simple/`,
      UV_INSECURE_HOST: host,
      // nothing else answers: do not wait for update checks or telemetry
      npm_config_update_notifier: 'false',
      DO_NOT_TRACK: '1',
    },
  }
}

/**
 * A proxy somebody else runs (a Deployment and a Service in Kubernetes). Installs reach it by
 * address: they have no DNS.
 */
export class ServiceRegistryProxy implements RegistryProxy {
  constructor(private readonly host: () => Promise<string>) {}

  async ensure(): Promise<InstallAccess> {
    return installAccess(await this.host())
  }

  /** not the factory's to stop */
  async stop() {}
}

/**
 * The proxy as a docker container on two networks: the default bridge (to reach the registries)
 * and an internal network of its own. Installs are not on the agents' network: an agent has no
 * use for a registry, and an install none for the model gateway.
 */
export class DockerRegistryProxy implements RegistryProxy {
  private readonly name: string
  private readonly network: string
  private readonly image: string
  private ready: Promise<InstallAccess> | undefined

  constructor(private readonly opts: DockerRegistryProxyOptions) {
    this.name = opts.name ?? 'tiller-registry'
    this.network = opts.network ?? INSTALL_NETWORK
    this.image = opts.image ?? 'codetiller/base:dev'
  }

  private docker(args: string[], env?: Record<string, string>) {
    return exec('docker', args, { env: { ...process.env, ...env } }).then((r) => r.stdout.trim())
  }

  ensure(): Promise<InstallAccess> {
    this.ready ??= this.start().catch((e) => {
      this.ready = undefined
      throw e
    })
    return this.ready
  }

  private async start(): Promise<InstallAccess> {
    const access = installAccess(this.name, this.network)
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
        `docker network ${this.network} exists but is not internal: installs on it could reach the internet`,
      )
    const registries = JSON.stringify(this.opts.registries ?? {})
    // script or registry list changed → replace
    const want = sha256(`${await readFile(this.opts.script, 'utf8')}\n${registries}`).slice(0, 16)
    const label = '{{index .Config.Labels "tiller.registry"}}'
    const state = await this.docker([
      'inspect',
      '-f',
      `{{.State.Running}} ${label}`,
      this.name,
    ]).catch(() => '')
    if (state !== `true ${want}`) {
      await this.docker(['rm', '-f', this.name]).catch(() => {})
      await this.run(want, registries).catch(async (e) => {
        // another factory process may have started the same proxy in between
        const now = await this.docker(['inspect', '-f', label, this.name]).catch(() => '')
        if (now !== want) throw e
      })
    }
    await this.healthy()
    return access
  }

  private async run(fingerprint: string, registries: string) {
    await this.docker(
      [
        'create',
        '--name',
        this.name,
        '--label',
        `tiller.registry=${fingerprint}`,
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
        ...(this.opts.registries ? ['-e', 'TILLER_REGISTRIES'] : []),
        this.image,
        'node',
        '/registry.mjs',
      ],
      { TILLER_REGISTRIES: registries },
    )
    // The script is copied in, not mounted: a mount names a path of the docker host, and the
    // factory may itself run in a container whose files the host does not have.
    await this.docker(['cp', this.opts.script, `${this.name}:/registry.mjs`])
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
    throw new Error(`registry proxy did not come up: ${logs.slice(-500)}`)
  }

  async stop() {
    this.ready = undefined
    await this.docker(['rm', '-f', this.name]).catch(() => {})
  }
}
