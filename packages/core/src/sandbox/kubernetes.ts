import { constants, readFileSync } from 'node:fs'
import { mkdir, open, rm } from 'node:fs/promises'
import https from 'node:https'
import { isAbsolute, join, relative } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type { InstallAccess, RegistryProxy } from './registry.js'
import type { ExecRequest, ExecResult, WorkerSandbox } from './sandbox.js'

/** The few calls the sandbox makes to the Kubernetes API: pods of one namespace. */
export interface KubeApi {
  call(method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown }>
}

const ACCOUNT = '/var/run/secrets/kubernetes.io/serviceaccount'

/** The namespace of the pod this process runs in. */
export const inClusterNamespace = () => readFileSync(`${ACCOUNT}/namespace`, 'utf8').trim()

/**
 * The API as a pod sees it: the cluster's address from the environment, the pod's service
 * account as the credential. The token is read for every call: the kubelet replaces it.
 */
export class InClusterApi implements KubeApi {
  private readonly ca = readFileSync(`${ACCOUNT}/ca.crt`)
  private readonly host = process.env.KUBERNETES_SERVICE_HOST
  private readonly port = Number(process.env.KUBERNETES_SERVICE_PORT ?? 443)

  call(method: string, path: string, body?: unknown) {
    const { host, port, ca } = this
    if (!host) return Promise.reject(new Error('not in a Kubernetes pod (KUBERNETES_SERVICE_HOST)'))
    const token = readFileSync(`${ACCOUNT}/token`, 'utf8').trim()
    const payload = body === undefined ? undefined : JSON.stringify(body)
    return new Promise<{ status: number; body: unknown }>((resolve, reject) => {
      const req = https.request(
        {
          host,
          port,
          path,
          method,
          ca,
          headers: {
            authorization: `Bearer ${token}`,
            accept: 'application/json',
            ...(payload ? { 'content-type': 'application/json' } : {}),
          },
          timeout: 30_000,
        },
        (res) => {
          let text = ''
          res.setEncoding('utf8').on('data', (c: string) => {
            text += c
          })
          res.on('end', () => {
            let parsed: unknown = text
            try {
              parsed = JSON.parse(text)
            } catch {}
            resolve({ status: res.statusCode ?? 0, body: parsed })
          })
        },
      )
      req.on('timeout', () => req.destroy(new Error(`Kubernetes API ${method} ${path}: timed out`)))
      req.on('error', reject)
      req.end(payload)
    })
  }
}

export interface KubernetesSandboxOptions {
  api: KubeApi
  namespace: string
  /** the factory's working dir, where the claim is mounted in the factory's pod */
  home: string
  /** PersistentVolumeClaim holding the working dir: every pod gets parts of it, by sub-path */
  claim: string
  /** installs reach only this proxy */
  registry?: RegistryProxy
  /** the worker of this installation: label of its pods, so the next worker can remove leftovers */
  owner?: string
  /**
   * Labels of the factory's own pod. Sandbox pods are scheduled onto its node: a claim that one
   * node at a time may mount (ReadWriteOnce) is then enough.
   */
  colocate?: Record<string, string>
  /**
   * Per network (`none`, `tiller-agents`, ...; `*` for the rest) what a pod on it checks before
   * it runs anything. `closed`: a URL it must NOT be able to connect to (the cluster's API): a
   * cluster that does not enforce NetworkPolicy, or enforces it a moment after a pod starts,
   * would otherwise give an agent the open network without anyone noticing. `open`: a URL it
   * must be able to connect to (its gateway, its proxy), which may also take a moment.
   */
  networks?: Record<string, { closed?: string; open?: string }>
  /** how often a pod is asked for its state (ms) */
  poll_ms?: number
}

export const SANDBOX_LABEL = { 'app.kubernetes.io/name': 'tiller-sandbox' }
const IO = '/tiller-io'
const VOLUMES = '.volumes'
/** what one pod may leave in the factory's memory as its output */
const MAX_OUTPUT = 64 * 1024 * 1024
/** states a pod does not get out of on its own: the image is not there, the spec cannot run */
const STUCK =
  /^(ErrImagePull|ImagePullBackOff|InvalidImageName|ErrImageNeverPull|CreateContainerConfigError|CreateContainerError|RunContainerError)$/
/** how long a pod may sit in such a state, or unscheduled, before it is given up (s) */
const STUCK_S = 60

/**
 * Run before anything of the request, in the pod itself: $1 must not be reachable, $2 must be
 * (either may be empty), the rest is the command. Measured on k3s: a new pod has the open
 * network for a second or two before its policy is in place, so the command waits for that.
 * "Not reachable" is believed after two attempts in a row. Output goes to files the factory
 * reads from its own mount of the same claim: exact bytes, stdout and stderr apart.
 */
const WRAP = `closed="$1"; open="$2"; shift 2
fail() { echo "tiller: $1; nothing was run" > ${IO}/stderr; exit 126; }
connects() {
  if command -v curl >/dev/null 2>&1; then
    curl -sk -o /dev/null -m 1 "$1"; c=$?; [ "$c" != 7 ] && [ "$c" != 28 ]
  elif command -v node >/dev/null 2>&1; then
    node -e 'const u=new URL(process.argv[1]);const s=require("net").connect(Number(u.port)||(u.protocol==="https:"?443:80),u.hostname);s.on("connect",()=>process.exit(0));s.on("error",()=>process.exit(1));setTimeout(()=>process.exit(1),1000)' "$1"
  else fail "the image has neither curl nor node: the network isolation of this pod cannot be checked"; fi
}
i=0; quiet=0
while [ -n "$closed" ] && [ "$quiet" -lt 2 ]; do
  if connects "$closed"; then quiet=0; sleep 0.5; else quiet=$((quiet+1)); fi
  i=$((i+1)); [ "$i" -ge 40 ] && fail "this pod can reach $closed, which its network policy forbids: the cluster does not enforce NetworkPolicy"
done
i=0
while [ -n "$open" ] && ! connects "$open"; do
  i=$((i+1)); [ "$i" -ge 60 ] && fail "this pod cannot reach $open, which its network policy allows"
  sleep 0.5
done
exec "$@" > ${IO}/stdout 2> ${IO}/stderr`

interface PodStatus {
  phase?: string
  reason?: string
  message?: string
  conditions?: { type: string; status: string; reason?: string; message?: string }[]
  containerStatuses?: {
    imageID?: string
    state?: {
      waiting?: { reason?: string; message?: string }
      terminated?: { exitCode: number; reason?: string }
    }
  }[]
}

/** docker's `4g` / `256m` as a Kubernetes quantity */
const quantity = (memory: string) => {
  const m = /^(\d+)([kmg])b?$/i.exec(memory)
  return m ? `${m[1]}${(m[2] as string).toUpperCase()}i` : memory
}

/**
 * What a pod wrote, read as data. The pod owns the directory: a symlink (to a file of the
 * factory) or a pipe in place of the file is not followed and not waited on.
 */
async function readOutput(path: string, offset: number): Promise<Buffer> {
  const fh = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  ).catch(() => null)
  if (!fh) return Buffer.alloc(0)
  try {
    const st = await fh.stat()
    if (!st.isFile()) return Buffer.alloc(0)
    const length = Math.min(st.size, MAX_OUTPUT) - offset
    if (length <= 0) return Buffer.alloc(0)
    const buf = Buffer.alloc(length)
    const { bytesRead } = await fh.read(buf, 0, length, offset)
    return buf.subarray(0, bytesRead)
  } finally {
    await fh.close()
  }
}

/**
 * Sandbox on Kubernetes: every `exec` is a pod. The factory runs in the cluster with its working
 * dir on a PersistentVolumeClaim; a pod gets the directories of the request as sub-paths of that
 * claim and nothing else of it. No service account token, no capabilities, not root. Which pod
 * may reach what is the cluster's NetworkPolicy, selected by the `tiller-network` label.
 */
export class KubernetesSandbox implements WorkerSandbox {
  private readonly running = new Set<string>()
  private readonly imageIds = new Map<string, string>()
  private closed = false
  private readonly pods: string

  constructor(private readonly opts: KubernetesSandboxOptions) {
    this.pods = `/api/v1/namespaces/${opts.namespace}/pods`
  }

  async installAccess(): Promise<InstallAccess | undefined> {
    return this.opts.registry?.ensure()
  }

  /**
   * A cluster cannot be asked for an image without starting a pod with it: the first question
   * about an image starts one that does nothing. Null = the cluster could not get the image.
   */
  async imageId(image: string): Promise<string | null> {
    if (!this.imageIds.has(image))
      await this.exec({ image, cmd: ['true'], network: 'none', limits: { timeout_s: 120 } }).catch(
        () => null,
      )
    return this.imageIds.get(image) ?? null
  }

  /** A directory of the working dir as a path inside the claim. */
  private subPath(host: string): string {
    const rel = relative(this.opts.home, host)
    if (!rel || rel.startsWith('..') || isAbsolute(rel))
      throw new Error(
        `${host} is not inside ${this.opts.home}: pods get only parts of the factory's working dir`,
      )
    return rel
  }

  private volumePath(name: string): string {
    if (!/^[\w.-]+$/.test(name) || name.startsWith('.')) throw new Error(`bad volume name ${name}`)
    return join(VOLUMES, name)
  }

  /**
   * Named volumes are directories of the claim, made by the factory, so they belong to the
   * sandbox user from the start (no root container to hand them over, as docker needs).
   */
  async ownVolumes(volumes: { name: string }[]) {
    for (const v of volumes)
      await mkdir(join(this.opts.home, this.volumePath(v.name)), { recursive: true })
  }

  /** The pod of a request; its first lines are the checks of `KubernetesSandboxOptions.networks`. */
  podFor(req: ExecRequest, name: string): Record<string, unknown> {
    const [uid, gid] = (req.user ?? '1000:1000').split(':').map(Number) as [number, number]
    const network = req.network ?? 'default'
    const checks = { ...this.opts.networks?.['*'], ...this.opts.networks?.[network] }
    const l = req.limits
    const home = 'home'
    const mounts = [
      { name: home, mountPath: IO, subPath: this.subPath(this.ioDir(name)) },
      ...(req.mounts ?? []).map((m) => ({
        name: home,
        mountPath: m.container,
        subPath: this.subPath(m.host),
        ...(m.readonly ? { readOnly: true } : {}),
      })),
      ...(req.volumes ?? []).map((v) => ({
        name: home,
        mountPath: v.container,
        subPath: this.volumePath(v.name),
        ...(v.readonly ? { readOnly: true } : {}),
      })),
      ...(req.tmpfs ?? []).map((p, i) => ({ name: `scratch-${i}`, mountPath: p })),
    ]
    return {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: {
        name,
        labels: {
          ...SANDBOX_LABEL,
          'tiller-network': network,
          ...(this.opts.owner ? { 'tiller-owner': this.opts.owner } : {}),
        },
      },
      spec: {
        restartPolicy: 'Never',
        // nothing a pod runs may talk to the cluster as anyone
        automountServiceAccountToken: false,
        enableServiceLinks: false,
        // the cluster stops it even when the factory is gone
        activeDeadlineSeconds: l.timeout_s + 60,
        terminationGracePeriodSeconds: 2,
        // No DNS: a name is a way to send data out, and a pod reaches the gateway and the
        // registry proxy by address. Lookups fail at once instead of waiting for an answer.
        dnsPolicy: 'None',
        dnsConfig: { nameservers: ['127.0.0.1'] },
        securityContext: {
          runAsUser: uid,
          runAsGroup: gid,
          runAsNonRoot: uid !== 0,
          seccompProfile: { type: 'RuntimeDefault' },
        },
        ...(this.opts.colocate
          ? {
              affinity: {
                podAffinity: {
                  requiredDuringSchedulingIgnoredDuringExecution: [
                    {
                      labelSelector: { matchLabels: this.opts.colocate },
                      topologyKey: 'kubernetes.io/hostname',
                    },
                  ],
                },
              },
            }
          : {}),
        containers: [
          {
            name: 'main',
            image: req.image,
            imagePullPolicy: 'IfNotPresent',
            command: [
              'sh',
              '-c',
              WRAP,
              'tiller',
              checks.closed ?? '',
              checks.open ?? '',
              ...req.cmd,
            ],
            ...(req.workdir ? { workingDir: req.workdir } : {}),
            env: Object.entries(req.env ?? {}).map(([k, value]) => ({ name: k, value })),
            resources: {
              limits: { cpu: String(l.cpus ?? 2), memory: quantity(l.memory ?? '4g') },
              // scheduled by what it usually needs, stopped at what it may take at most
              requests: { cpu: '250m', memory: '256Mi' },
            },
            securityContext: {
              allowPrivilegeEscalation: false,
              capabilities: { drop: ['ALL'], ...(req.caps?.length ? { add: req.caps } : {}) },
            },
            volumeMounts: mounts,
          },
        ],
        volumes: [
          { name: home, persistentVolumeClaim: { claimName: this.opts.claim } },
          ...(req.tmpfs ?? []).map((_, i) => ({
            name: `scratch-${i}`,
            emptyDir: { medium: 'Memory' },
          })),
        ],
      },
    }
  }

  private ioDir(name: string) {
    return join(this.opts.home, '.cache', 'io', name)
  }

  private async remove(name: string) {
    await this.opts.api.call('DELETE', `${this.pods}/${name}?gracePeriodSeconds=0`).catch(() => {})
  }

  async exec(req: ExecRequest): Promise<ExecResult> {
    if (this.closed) throw new Error('the factory is shutting down')
    const name = `tiller-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    const started = performance.now()
    const io = this.ioDir(name)
    await mkdir(io, { recursive: true })
    await this.ownVolumes(req.volumes ?? [])
    const done = (exitCode: number | null, timedOut: boolean, stdout: string, stderr: string) => ({
      exitCode,
      timedOut,
      stdout,
      stderr,
      duration_s: (performance.now() - started) / 1000,
    })
    try {
      const made = await this.opts.api.call('POST', this.pods, this.podFor(req, name))
      if (made.status >= 300) {
        const why = (made.body as { message?: string } | null)?.message ?? JSON.stringify(made.body)
        // as docker answers a container it cannot start
        return done(125, false, '', `the cluster refused the pod (${made.status}): ${why}`)
      }
      this.running.add(name)
      const decoder = new StringDecoder('utf8')
      let stdout = ''
      let read = 0
      const pump = async () => {
        const chunk = await readOutput(join(io, 'stdout'), read)
        if (!chunk.length) return
        read += chunk.length
        const text = decoder.write(chunk)
        stdout += text
        if (text) req.onStdout?.(text)
      }
      const finish = async (exitCode: number | null, timedOut: boolean, note = '') => {
        await pump()
        stdout += decoder.end()
        const stderr = (await readOutput(join(io, 'stderr'), 0)).toString('utf8')
        return done(
          exitCode,
          timedOut,
          stdout,
          note ? `${stderr}${stderr ? '\n' : ''}${note}` : stderr,
        )
      }
      const deadline = started + req.limits.timeout_s * 1000
      let stuckSince: number | null = null
      for (;;) {
        await new Promise((r) => setTimeout(r, this.opts.poll_ms ?? 400))
        await pump()
        const res = await this.opts.api.call('GET', `${this.pods}/${name}`).catch(() => null)
        // the API not answering for a moment says nothing about the pod
        if (!res || res.status >= 500) {
          if (performance.now() > deadline) return finish(137, true)
          continue
        }
        if (res.status === 404) return finish(137, false, 'the pod is gone (deleted or evicted)')
        const status = (res.body as { status?: PodStatus }).status ?? {}
        const container = status.containerStatuses?.[0]
        if (container?.imageID) this.imageIds.set(req.image, container.imageID)
        const ended = container?.state?.terminated
        if (ended)
          return finish(ended.exitCode, false, ended.reason === 'OOMKilled' ? 'out of memory' : '')
        if (status.phase === 'Failed' || status.phase === 'Succeeded') {
          const late = status.reason === 'DeadlineExceeded'
          return finish(
            late ? 137 : status.phase === 'Succeeded' ? 0 : 1,
            late,
            status.message ?? '',
          )
        }
        if (performance.now() > deadline) return finish(137, true)
        // a pod that cannot start: no image, no node for it
        const waiting = container?.state?.waiting
        const unscheduled = status.conditions?.find(
          (c) => c.type === 'PodScheduled' && c.status === 'False',
        )
        const stuck =
          waiting?.reason && STUCK.test(waiting.reason)
            ? `${waiting.reason}: ${waiting.message ?? req.image}`
            : unscheduled
              ? `no node for the pod: ${unscheduled.message ?? unscheduled.reason ?? ''}`
              : null
        if (!stuck) stuckSince = null
        else {
          stuckSince ??= performance.now()
          if (performance.now() - stuckSince > STUCK_S * 1000) return finish(125, false, stuck)
        }
      }
    } finally {
      this.running.delete(name)
      await this.remove(name)
      await rm(io, { recursive: true, force: true }).catch(() => {})
    }
  }

  /** Stop every pod this process started; nothing new is started after. */
  async killAll(): Promise<number> {
    this.closed = true
    const names = [...this.running]
    await Promise.all(names.map((n) => this.remove(n)))
    return names.length
  }

  /** Remove pods a previous worker of this installation left running (it was killed). */
  async reap(): Promise<number> {
    if (!this.opts.owner) return 0
    const res = await this.opts.api
      .call(
        'GET',
        `${this.pods}?labelSelector=${encodeURIComponent(`tiller-owner=${this.opts.owner}`)}`,
      )
      .catch(() => null)
    const items = (res?.body as { items?: { metadata: { name: string } }[] } | null)?.items ?? []
    await Promise.all(items.map((p) => this.remove(p.metadata.name)))
    return items.length
  }
}
