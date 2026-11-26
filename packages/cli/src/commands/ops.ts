import { execFile, spawn } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import { networkInterfaces } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import {
  auditSandbox,
  DEFAULT_IMAGE,
  DockerGateway,
  DockerSandbox,
  doctor,
  doctorOk,
  freeBytesOf,
  GitHubForge,
  loadConfig,
  missingCommands,
  modelAccess,
  renderDoctor,
  type Sandbox,
  Store,
  WorkItems,
} from '@codetiller/core'
import { startServer } from '@codetiller/server'
import type { Command } from 'commander'

import {
  dockerSandbox,
  KUBE,
  kube,
  loadFactoryConfig,
  loadPrices,
  loadProfile,
  modelGateway,
  ON_KUBERNETES,
  openFactory,
  own,
  ROOT,
  registryProxy,
  runWorker,
  uiToken,
} from '../env.js'

/** `tiller ui | tools | gateway | doctor | setup | audit | daemon`: running and checking an installation. */
export function register(program: Command) {
  program
    .command('ui')
    .description(
      'local factory UI: tasks, inbox, run conversations, evals (http://127.0.0.1:<port>)',
    )
    .option('--port <port>', '', '4317')
    .option(
      '--host <address>',
      'address to listen on; 0.0.0.0 in a container whose port the host publishes',
      '127.0.0.1',
    )
    .option(
      '--url <url>',
      'address people open the UI at, when it is not this machine (a reverse proxy, a server name)',
    )
    .option('--api-only', 'serve the API only (web dev: pnpm --filter @codetiller/web dev)')
    .action(async (opts: { port: string; host: string; url?: string; apiOnly?: boolean }) => {
      const { store, factory, sandbox } = openFactory(console.log, { worker: true })
      // packages/web/dist, from both src/ (tsx) and dist/ (built)
      const webDir = opts.apiOnly
        ? undefined
        : fileURLToPath(new URL('../../web/dist', import.meta.url))
      // worker executes only runs a human queued (no automatic spawn)
      const stopWorker = await runWorker(factory, sandbox)
      const token = uiToken()
      // the web dev server proxies with its own Host
      const ports = opts.apiOnly ? [opts.port, '5173'] : [opts.port]
      // answered: this machine by its loopback names, and the one public address it was told
      const site = opts.url ? new URL(opts.url) : undefined
      const hosts = [
        ...ports.flatMap((p) => [`127.0.0.1:${p}`, `localhost:${p}`]),
        ...(site ? [site.host] : []),
      ]
      const server = startServer(
        { store, root: resolve('.'), factory, token, hosts },
        { port: Number(opts.port), host: opts.host, webDir },
      )
      // the link carries the token once; the page keeps it and drops it from the address
      const base = site ? site.origin : `http://127.0.0.1:${opts.apiOnly ? '5173' : opts.port}`
      const url = `${base}/?token=${token}`
      const note = opts.apiOnly ? ` (API on :${opts.port}; web dev server on :5173)` : ''
      console.log(`tiller ui → ${url}${note}`)
      if (!factory.canRun) console.log('ANTHROPIC_API_KEY not set: tasks can be queued, not run')
      const stop = async () => {
        await stopWorker()
        server.close(() => store.close())
        // open connections (a page following a run) must not keep a stopped factory alive
        if ('closeAllConnections' in server) server.closeAllConnections()
      }
      process.on('SIGINT', stop)
      process.on('SIGTERM', stop)
    })

  program
    .command('tools')
    .description('commands agents tried that the sandbox images lack (scans run transcripts)')
    .action(async () => {
      const dir = resolve('artifacts')
      const totals = new Map<string, { count: number; runs: number }>()
      let runs = 0
      let affected = 0
      for (const id of await readdir(dir).catch(() => [])) {
        const raw = await readFile(resolve(dir, id, 'transcript.jsonl'), 'utf8').catch(() => null)
        if (raw === null) continue
        runs++
        const missing = missingCommands(raw)
        if (missing.length) affected++
        for (const m of missing) {
          const t = totals.get(m.command) ?? { count: 0, runs: 0 }
          totals.set(m.command, { count: t.count + m.count, runs: t.runs + 1 })
        }
      }
      console.log(`${affected} of ${runs} runs hit a missing command`)
      for (const [command, t] of [...totals].sort((a, b) => b[1].runs - a[1].runs))
        console.log(`${command.padEnd(16)} ${String(t.runs).padStart(4)} runs  ${t.count} times`)
    })

  program
    .command('gateway <action>')
    .description(
      'model gateway and registry proxy containers: `stop` removes them (the next run starts fresh ones)',
    )
    .action(async (action: string) => {
      if (action !== 'stop') throw new Error('usage: tiller gateway stop')
      if (ON_KUBERNETES)
        throw new Error(
          'on Kubernetes the gateway and the proxy are Deployments: kubectl rollout restart',
        )
      const key = process.env.ANTHROPIC_API_KEY ?? ''
      await new DockerGateway({ key, script: '' }).stop()
      await registryProxy().stop()
      console.log('model gateway and registry proxy stopped')
    })

  /** IPv4 addresses of this machine (or of tiller's own container) other than loopback. */
  const ownAddresses = () =>
    Object.values(networkInterfaces())
      .flat()
      .filter((a) => a && a.family === 'IPv4' && !a.internal)
      .map((a) => (a as { address: string }).address)

  const run = promisify(execFile)
  const docker = (args: string[]) => run('docker', args).then((r) => r.stdout)

  const dockerDoctor = () => ({
    sandbox: new DockerSandbox() as Sandbox,
    runtime: {
      name: 'docker',
      version: () =>
        docker(['version', '--format', '{{.Server.Version}} {{.Server.Os}}/{{.Server.Arch}}']).then(
          (v) => `daemon ${v.trim()}`,
        ),
      fix: 'start docker; in a container, mount /var/run/docker.sock and add the group that owns it',
    },
    imageFix: 'tiller setup',
    sharedFix: `mount the directory into tiller's container at the path it has on the docker host (${resolve('.')}:${resolve('.')})`,
  })

  /** On Kubernetes: the API answers and may be asked for pods; the gateway answers the factory. */
  function kubernetesDoctor() {
    const k = KUBE
    return {
      // a cluster the factory could not read gets no probe pod: the runtime check says why
      sandbox: (k && !('problem' in k)
        ? dockerSandbox()
        : { exec: () => Promise.reject() }) as Sandbox,
      runtime: {
        name: 'kubernetes',
        version: async () => {
          const c = kube()
          const v = await c.api.call('GET', '/version')
          const pods = await c.api.call('GET', `/api/v1/namespaces/${c.namespace}/pods?limit=1`)
          if (pods.status !== 200)
            throw new Error(
              `the service account may not list pods in ${c.namespace} (${pods.status})`,
            )
          const health = await fetch(new URL('/healthz', c.gatewayUrl)).then(
            (r) => r.status,
            (e: Error) => e.message,
          )
          if (health !== 200) throw new Error(`the model gateway does not answer: ${health}`)
          const git = (v.body as { gitVersion?: string }).gitVersion ?? `HTTP ${v.status}`
          return `cluster ${git}, namespace ${c.namespace}, gateway and registry proxy found`
        },
        fix: 'kubectl apply -k deploy/kubernetes, and create the secret it names',
      },
      imageFix: 'push it to a registry the cluster pulls from (TILLER_BASE_IMAGE names it)',
      sharedFix: `mount the claim ${k?.claim} at ${resolve('.')} in tiller's pod`,
    }
  }

  /** The checks of `tiller doctor` on this working dir; opens the database (and so migrates it). */
  async function checkInstallation() {
    const store = new Store(resolve('tiller.db'), resolve('artifacts'))
    const token = process.env.TILLER_GITHUB_TOKEN
    const forge = token ? new GitHubForge(token) : undefined
    try {
      return await doctor({
        home: resolve('.'),
        ...(ON_KUBERNETES ? kubernetesDoctor() : dockerDoctor()),
        image: DEFAULT_IMAGE,
        git: () => run('git', ['--version']).then((r) => r.stdout),
        uid: process.getuid?.() ?? -1,
        // on Kubernetes the key is the gateway's: it is there when the gateway answers
        modelKey: ON_KUBERNETES
          ? 'held by the model gateway; the factory has none'
          : Boolean(process.env.ANTHROPIC_API_KEY),
        forgeToken: Boolean(token),
        repos: [
          ...new Set([
            ...new WorkItems(store).repos().map((r) => r.repo),
            ...loadFactoryConfig().projects.map((p) => p.repo),
          ]),
        ],
        repoAccess: forge ? (repo) => forge.access(repo) : undefined,
        schema: store.migrated.to,
        freeBytes: freeBytesOf(resolve('.')),
      })
    } finally {
      store.close()
    }
  }

  program
    .command('doctor')
    .description(
      'check this installation: docker, the sandbox image, workspaces shared with the docker daemon, credentials, repositories; exit 1 when a check fails',
    )
    .action(async () => {
      const checks = await checkInstallation()
      console.log(renderDoctor(checks))
      if (!doctorOk(checks)) process.exitCode = 1
    })

  program
    .command('setup')
    .description(
      'prepare a docker host for tiller: build the sandbox base image when it is missing, then `tiller doctor`',
    )
    .option('--rebuild', 'build the image even when there is one')
    .action(async (opts: { rebuild?: boolean }) => {
      if (ON_KUBERNETES)
        throw new Error(
          `on Kubernetes the cluster pulls ${DEFAULT_IMAGE} from a registry: push it there (TILLER_BASE_IMAGE names it), then tiller doctor`,
        )
      const have = await new DockerSandbox().imageId(DEFAULT_IMAGE)
      if (have && !opts.rebuild) console.log(`${DEFAULT_IMAGE} is there (${have.slice(7, 19)})`)
      else {
        console.log(`building ${DEFAULT_IMAGE} (Node, Go, Python and the agent CLI: a few GB)`)
        const code = await new Promise<number | null>((done, fail) =>
          spawn('docker', ['build', '-t', DEFAULT_IMAGE, resolve(ROOT, 'images', 'base')], {
            stdio: 'inherit',
          })
            .on('error', fail)
            .on('close', done),
        )
        if (code !== 0) throw new Error(`docker build failed (exit ${code})`)
      }
      console.log('')
      const checks = await checkInstallation()
      console.log(renderDoctor(checks))
      if (!doctorOk(checks)) process.exitCode = 1
    })

  program
    .command('audit')
    .description(
      'Probe the trust boundary inside the containers the factory starts (no model call); exit 1 on a failed probe',
    )
    .option('--image <image>', 'image that is probed', DEFAULT_IMAGE)
    .option('--profile <name>', 'probe the image of this sandbox profile (datasets/<name>) instead')
    .option('--config <name>', '', 'default')
    .option('--port <port>', 'where the factory UI/API listens', '4317')
    .action(async (opts: { image: string; profile?: string; config: string; port: string }) => {
      const key = process.env.ANTHROPIC_API_KEY ?? ''
      if (!key && !ON_KUBERNETES) throw new Error('ANTHROPIC_API_KEY not set (.env)')
      const image = opts.profile
        ? (await loadProfile(resolve('datasets', opts.profile))).image
        : opts.image
      const config = await loadConfig(own('configs', `${opts.config}.yaml`))
      // a run as the factory would open it: one model, a budget no probe gets near
      const access = await modelAccess(key ? { ANTHROPIC_API_KEY: key } : {}, modelGateway(key), {
        label: 'audit',
        config,
        prices: loadPrices(),
      })
      const results = await auditSandbox({
        sandbox: dockerSandbox(),
        image,
        config,
        access,
        port: Number(opts.port),
        hosts: ownAddresses(),
        kubeApi: process.env.KUBERNETES_SERVICE_HOST
          ? `${process.env.KUBERNETES_SERVICE_HOST}:${process.env.KUBERNETES_SERVICE_PORT ?? 443}`
          : undefined,
        workDir: resolve('.cache', 'work'),
      })
      console.log(
        `model access: ${access.via}${access.network ? ` (network ${access.network})` : ''}\n`,
      )
      let last = ''
      for (const r of results) {
        if (r.container !== last) console.log(`${last ? '\n' : ''}${r.container} container`)
        last = r.container
        console.log(
          `  ${r.status.padEnd(5)} ${r.probe.padEnd(21)}${r.observed.padEnd(18)}${r.want}`,
        )
      }
      await access.close()
      // from the host itself: any process of this user can reach the port, so the API must refuse
      // a call without the token here too
      const api = await fetch(`http://127.0.0.1:${opts.port}/api/health`).then(
        (r) => String(r.status),
        () => 'not running',
      )
      const apiOk = api === '401' || api === 'not running'
      console.log(
        `\nhost\n  ${(apiOk ? 'ok' : 'FAIL').padEnd(5)} ${'api_no_token'.padEnd(21)}${api.padEnd(18)}factory API answers no call without the token`,
      )
      if (!apiOk) process.exitCode = 1
      const failed = results.filter((r) => r.status === 'FAIL')
      const open = results.filter((r) => r.status === 'open')
      console.log(
        `\n${failed.length ? `${failed.length} probe(s) FAILED: the boundary does not hold` : 'boundary holds for every probe'}${open.length ? ` · ${open.length} known open gap(s)` : ''}`,
      )
      if (failed.length) process.exitCode = 1
    })

  program
    .command('daemon')
    .description('tillerd without the UI: import labelled issues, execute runs humans queued')
    .action(async () => {
      const { store, factory, sandbox } = openFactory(console.log, { worker: true })
      if (!factory.canRun) console.log('ANTHROPIC_API_KEY not set: tasks can be queued, not run')
      if (!factory.canImport)
        console.log('intake off: needs TILLER_GITHUB_TOKEN and factory.projects in tiller.yaml')
      const stopWorker = await runWorker(factory, sandbox)
      console.log('tiller daemon running (ctrl-c to stop)')
      const stop = async () => {
        await stopWorker()
        store.close()
      }
      process.on('SIGINT', stop)
      process.on('SIGTERM', stop)
    })
}
