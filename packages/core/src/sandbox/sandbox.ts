import { spawn } from 'node:child_process'
import type { InstallAccess, RegistryProxy } from './registry.js'

export interface Mount {
  host: string
  container: string
  readonly?: boolean
}

export interface ExecLimits {
  cpus?: number
  memory?: string
  pids?: number
  timeout_s: number
}

export interface ExecRequest {
  image: string
  cmd: string[]
  mounts?: Mount[]
  volumes?: { name: string; container: string; readonly?: boolean }[]
  user?: string // default 1000:1000 (non-root)
  /** `none`, or a named docker network (agents: the internal network of the model gateway); default: bridge */
  network?: string
  /** capabilities to keep; every other one is dropped (default: none) */
  caps?: string[]
  tmpfs?: string[] // writable scratch dirs (e.g. tool caches inside read-only volumes)
  env?: Record<string, string>
  workdir?: string
  limits: ExecLimits
  onStdout?: (chunk: string) => void
}

export interface ExecResult {
  exitCode: number | null
  timedOut: boolean
  stdout: string
  stderr: string
  duration_s: number
}

/** One interface; Docker now, E2B/Daytona/k8s later. */
export interface Sandbox {
  exec(req: ExecRequest): Promise<ExecResult>
  /** content id of an image (run manifest: which image exactly); null when unknown */
  imageId?(image: string): Promise<string | null>
  /**
   * How a dependency install reaches the package registries: a closed network and the registry
   * proxy's address. Absent (or undefined) = the install runs on the open network.
   */
  installAccess?(): Promise<InstallAccess | undefined>
  /**
   * Make new named volumes writable by the sandbox user. Absent = they start as root's and a
   * root container hands them over (docker); a backend that creates them itself does it here.
   */
  ownVolumes?(volumes: { name: string }[]): Promise<void>
}

/** A sandbox whose containers a worker can end when it stops, and clean up after a crash. */
export interface WorkerSandbox extends Sandbox {
  /** stop everything this process started; nothing new is started after */
  killAll(): Promise<number>
  /** remove what a previous worker of the same installation left running */
  reap(): Promise<number>
}

const OWNER_LABEL = 'tiller.owner'

export class DockerSandbox implements WorkerSandbox {
  /** names of the containers this process started and that have not ended */
  private readonly running = new Set<string>()
  /** after `killAll`: nothing new is started */
  private closed = false

  /**
   * `registry`: installs reach only this proxy; without it they get docker's default network.
   * `owner`: the worker of one installation. Its containers carry the name as a label, so the
   * next worker of that installation can remove what a killed one left running (`reap`).
   */
  constructor(private readonly opts: { registry?: RegistryProxy; owner?: string } = {}) {}

  private docker(args: string[]): Promise<string> {
    return new Promise((resolve) => {
      const child = spawn('docker', args)
      let out = ''
      child.stdout.setEncoding('utf8').on('data', (c: string) => {
        out += c
      })
      child.on('error', () => resolve(''))
      child.on('close', () => resolve(out))
    })
  }

  /**
   * Stop every container this process started. A factory that is shutting down calls it: a
   * container outlives the `docker run` that started it, and an agent nobody waits for would go
   * on spending and writing into a workspace the next run is given.
   */
  async killAll(): Promise<number> {
    this.closed = true
    const names = [...this.running]
    if (names.length) await this.docker(['kill', ...names])
    return names.length
  }

  /** Remove containers a previous worker of this installation left running (it was killed). */
  async reap(): Promise<number> {
    if (!this.opts.owner) return 0
    const ids = (
      await this.docker(['ps', '-q', '--filter', `label=${OWNER_LABEL}=${this.opts.owner}`])
    )
      .split('\n')
      .filter(Boolean)
    if (ids.length) await this.docker(['kill', ...ids])
    return ids.length
  }

  async installAccess(): Promise<InstallAccess | undefined> {
    return this.opts.registry?.ensure()
  }

  buildArgs(req: ExecRequest, name: string): string[] {
    const l = req.limits
    const args = ['run', '--rm', '--name', name, '--user', req.user ?? '1000:1000']
    if (this.opts.owner) args.push('--label', `${OWNER_LABEL}=${this.opts.owner}`)
    args.push('--cpus', String(l.cpus ?? 2), '--memory', l.memory ?? '4g')
    args.push('--pids-limit', String(l.pids ?? 512))
    // nothing here needs a capability or a setuid binary: drop them all, forbid regaining any
    args.push('--cap-drop', 'ALL', '--security-opt', 'no-new-privileges')
    for (const c of req.caps ?? []) args.push('--cap-add', c)
    for (const m of req.mounts ?? []) {
      args.push('-v', `${m.host}:${m.container}${m.readonly ? ':ro' : ''}`)
    }
    for (const v of req.volumes ?? []) {
      args.push('-v', `${v.name}:${v.container}${v.readonly ? ':ro' : ''}`)
    }
    if (req.network) args.push('--network', req.network)
    for (const p of req.tmpfs ?? []) args.push('--tmpfs', `${p}:uid=1000,gid=1000,exec`)
    // pass env by name only so secrets don't appear in argv
    for (const k of Object.keys(req.env ?? {})) args.push('-e', k)
    if (req.workdir) args.push('-w', req.workdir)
    return [...args, req.image, ...req.cmd]
  }

  imageId(image: string): Promise<string | null> {
    return new Promise((resolve) => {
      const child = spawn('docker', ['image', 'inspect', '--format', '{{.Id}}', image])
      let out = ''
      child.stdout.setEncoding('utf8').on('data', (c: string) => {
        out += c
      })
      child.on('error', () => resolve(null))
      child.on('close', (code) => resolve(code === 0 && out.trim() ? out.trim() : null))
    })
  }

  exec(req: ExecRequest): Promise<ExecResult> {
    if (this.closed) return Promise.reject(new Error('the factory is shutting down'))
    const name = `codetiller-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const started = performance.now()
    return new Promise((resolve, reject) => {
      const child = spawn('docker', this.buildArgs(req, name), {
        env: { ...process.env, ...req.env },
      })
      this.running.add(name)
      let stdout = ''
      let stderr = ''
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        spawn('docker', ['kill', name])
      }, req.limits.timeout_s * 1000)
      child.stdout.setEncoding('utf8').on('data', (c: string) => {
        stdout += c
        req.onStdout?.(c)
      })
      child.stderr.setEncoding('utf8').on('data', (c: string) => {
        stderr += c
      })
      child.on('error', (e) => {
        this.running.delete(name)
        reject(e)
      })
      child.on('close', (exitCode) => {
        this.running.delete(name)
        clearTimeout(timer)
        resolve({
          exitCode,
          timedOut,
          stdout,
          stderr,
          duration_s: (performance.now() - started) / 1000,
        })
      })
    })
  }
}
