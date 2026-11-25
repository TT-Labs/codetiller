import { mkdir, mkdtemp, readdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { type KubeApi, KubernetesSandbox } from './kubernetes.js'

type Pod = {
  metadata: { name: string; labels: Record<string, string> }
  spec: {
    containers: {
      command: string[]
      volumeMounts: { name: string; mountPath: string; subPath?: string; readOnly?: boolean }[]
      securityContext: unknown
      resources: unknown
      env: unknown
    }[]
    [k: string]: unknown
  }
}

/**
 * A cluster of one fake kubelet: `run` is what the pod's container does with its output
 * directory; the answers to GET are the states it goes through.
 */
function cluster(
  home: string,
  run: (io: string, pod: Pod) => Promise<unknown[]>,
): KubeApi & { calls: string[]; pods: Pod[] } {
  const states = new Map<string, unknown[]>()
  const calls: string[] = []
  const pods: Pod[] = []
  return {
    calls,
    pods,
    async call(method, path, body) {
      calls.push(`${method} ${path.replace(/^\/api\/v1\/namespaces\/ns/, '')}`)
      if (method === 'POST') {
        const pod = body as Pod
        pods.push(pod)
        const io = join(home, pod.spec.containers[0]?.volumeMounts[0]?.subPath as string)
        states.set(pod.metadata.name, await run(io, pod))
        return { status: 201, body: pod }
      }
      if (method === 'DELETE') return { status: 200, body: {} }
      if (path.includes('labelSelector'))
        return { status: 200, body: { items: [{ metadata: { name: 'left-1' } }] } }
      const queue = states.get(path.split('/').pop() as string) ?? []
      const status = queue.length > 1 ? queue.shift() : queue[0]
      return status === 404 ? { status: 404, body: {} } : { status: 200, body: { status } }
    },
  }
}

const ended = (exitCode: number, reason?: string) => ({
  phase: exitCode ? 'Failed' : 'Succeeded',
  containerStatuses: [{ imageID: 'sha256:abc', state: { terminated: { exitCode, reason } } }],
})

const setup = async (
  run: (io: string, pod: Pod) => Promise<unknown[]>,
  opts: Partial<ConstructorParameters<typeof KubernetesSandbox>[0]> = {},
) => {
  const home = await mkdtemp(join(tmpdir(), 'tiller-kube-'))
  const api = cluster(home, run)
  const sandbox = new KubernetesSandbox({
    api,
    namespace: 'ns',
    home,
    claim: 'tiller-home',
    poll_ms: 5,
    ...opts,
  })
  return { home, api, sandbox }
}

it('a request becomes a pod: parts of the claim, no token, not root, no capabilities', async () => {
  const { home, sandbox } = await setup(async () => [ended(0)], {
    owner: 'w1',
    colocate: { 'app.kubernetes.io/name': 'tiller' },
    networks: {
      '*': { closed: 'https://10.43.0.1:443/version' },
      'tiller-agents': { open: 'http://10.43.0.9:8080/healthz' },
    },
  })
  const pod = sandbox.podFor(
    {
      image: 'codetiller/base:dev',
      cmd: ['sh', '-c', 'pnpm test'],
      mounts: [
        { host: join(home, '.cache/work/task-1'), container: '/workspace' },
        { host: join(home, '.cache/work/task-1.prompt'), container: '/prompt.md', readonly: true },
      ],
      volumes: [
        { name: 'tiller-deps-o-r-abc', container: '/workspace/node_modules', readonly: true },
      ],
      tmpfs: ['/workspace/node_modules/.vite'],
      network: 'none',
      env: { CI: 'true' },
      workdir: '/workspace',
      limits: { timeout_s: 900, memory: '4g', cpus: 2 },
    },
    'p1',
  ) as Pod
  expect(pod.metadata.labels).toEqual({
    'app.kubernetes.io/name': 'tiller-sandbox',
    'tiller-network': 'none',
    'tiller-owner': 'w1',
  })
  const c = pod.spec.containers[0] as Pod['spec']['containers'][number]
  expect(c.volumeMounts).toEqual([
    { name: 'home', mountPath: '/tiller-io', subPath: '.cache/io/p1' },
    { name: 'home', mountPath: '/workspace', subPath: '.cache/work/task-1' },
    { name: 'home', mountPath: '/prompt.md', subPath: '.cache/work/task-1.prompt', readOnly: true },
    {
      name: 'home',
      mountPath: '/workspace/node_modules',
      subPath: '.volumes/tiller-deps-o-r-abc',
      readOnly: true,
    },
    { name: 'scratch-0', mountPath: '/workspace/node_modules/.vite' },
  ])
  // our lines first, then what must be closed and open, then the command as it was asked
  expect(c.command.slice(0, 2)).toEqual(['sh', '-c'])
  expect(c.command.slice(3)).toEqual([
    'tiller',
    'https://10.43.0.1:443/version',
    '',
    'sh',
    '-c',
    'pnpm test',
  ])
  // an agent must also get through to its gateway before it starts
  const agent = sandbox.podFor(
    { image: 'i', cmd: ['claude'], network: 'tiller-agents', limits: { timeout_s: 1 } },
    'p2',
  ) as Pod
  expect(agent.spec.containers[0]?.command.slice(4, 6)).toEqual([
    'https://10.43.0.1:443/version',
    'http://10.43.0.9:8080/healthz',
  ])
  expect(c.securityContext).toEqual({
    allowPrivilegeEscalation: false,
    capabilities: { drop: ['ALL'] },
  })
  expect(c.resources).toEqual({
    limits: { cpu: '2', memory: '4Gi' },
    requests: { cpu: '250m', memory: '256Mi' },
  })
  expect(pod.spec).toMatchObject({
    restartPolicy: 'Never',
    automountServiceAccountToken: false,
    enableServiceLinks: false,
    activeDeadlineSeconds: 960,
    dnsPolicy: 'None',
    securityContext: { runAsUser: 1000, runAsGroup: 1000, runAsNonRoot: true },
    volumes: [
      { name: 'home', persistentVolumeClaim: { claimName: 'tiller-home' } },
      { name: 'scratch-0', emptyDir: { medium: 'Memory' } },
    ],
  })
  expect(JSON.stringify(pod.spec.affinity)).toContain('"topologyKey":"kubernetes.io/hostname"')
})

it('only the working dir is shared: a path outside it, or a volume name that leaves its directory, is refused', async () => {
  const { home, sandbox } = await setup(async () => [ended(0)])
  const req = { image: 'i', cmd: ['x'], limits: { timeout_s: 1 } }
  for (const host of ['/etc', join(home, '..', 'elsewhere'), home])
    expect(() => sandbox.podFor({ ...req, mounts: [{ host, container: '/x' }] }, 'p')).toThrow(
      'pods get only parts of the factory',
    )
  for (const name of ['../x', 'a/b', '.hidden'])
    expect(() => sandbox.podFor({ ...req, volumes: [{ name, container: '/x' }] }, 'p')).toThrow(
      'bad volume name',
    )
})

it('runs to the end: output from the files the pod wrote, live, exit code from the cluster', async () => {
  const live: string[] = []
  const { home, api, sandbox } = await setup(async (io) => {
    await writeFile(join(io, 'stdout'), '{"n":1}\n{"n":2}\n')
    await writeFile(join(io, 'stderr'), 'warn\n')
    return [{ phase: 'Pending' }, { phase: 'Running', containerStatuses: [{}] }, ended(3)]
  })
  const res = await sandbox.exec({
    image: 'img',
    cmd: ['run'],
    volumes: [{ name: 'deps-1', container: '/deps' }],
    limits: { timeout_s: 30 },
    onStdout: (c) => live.push(c),
  })
  expect(res).toMatchObject({
    exitCode: 3,
    timedOut: false,
    stdout: '{"n":1}\n{"n":2}\n',
    stderr: 'warn\n',
  })
  expect(live.join('')).toBe(res.stdout)
  // known from the pod that ran; asked about another image, the sandbox starts a pod to find out
  const before = api.pods.length
  expect(await sandbox.imageId('img')).toBe('sha256:abc')
  expect(api.pods).toHaveLength(before)
  expect(await sandbox.imageId('other')).toBe('sha256:abc')
  expect(api.pods.at(-1)?.spec.containers[0]?.command.slice(-1)).toEqual(['true'])
  // the volume is a directory of the claim the factory made; the pod and its output are gone
  expect(await readdir(join(home, '.volumes'))).toEqual(['deps-1'])
  expect(await readdir(join(home, '.cache', 'io'))).toEqual([])
  expect(api.calls.at(-1)).toMatch(/^DELETE \/pods\/tiller-.*gracePeriodSeconds=0$/)
})

it('what a pod puts in place of its output is not followed', async () => {
  const { home, sandbox } = await setup(async (io) => {
    // the factory's secrets, as an agent would try to get them into a transcript
    await writeFile(join(home, '.env'), 'ANTHROPIC_API_KEY=sk-secret\n')
    await symlink(join(home, '.env'), join(io, 'stdout'))
    await mkdir(join(io, 'stderr'))
    return [ended(0)]
  })
  const res = await sandbox.exec({ image: 'i', cmd: ['x'], limits: { timeout_s: 30 } })
  expect(res.stdout).toBe('')
  expect(res.stderr).toBe('')
  expect(res.exitCode).toBe(0)
})

it('a pod over its time is stopped; one that cannot start is given up with the reason', async () => {
  const slow = await setup(async () => [{ phase: 'Running', containerStatuses: [{}] }])
  const res = await slow.sandbox.exec({ image: 'i', cmd: ['x'], limits: { timeout_s: 0.05 } })
  expect(res).toMatchObject({ exitCode: 137, timedOut: true })
  expect(slow.api.calls.filter((c) => c.startsWith('DELETE'))).toHaveLength(1)

  const oom = await setup(async () => [ended(137, 'OOMKilled')])
  expect(
    (await oom.sandbox.exec({ image: 'i', cmd: ['x'], limits: { timeout_s: 30 } })).stderr,
  ).toBe('out of memory')

  const gone = await setup(async () => [404])
  expect(
    await gone.sandbox.exec({ image: 'i', cmd: ['x'], limits: { timeout_s: 30 } }),
  ).toMatchObject({ exitCode: 137, stderr: 'the pod is gone (deleted or evicted)' })

  const refused = await setup(async () => [])
  refused.api.call = async () => ({
    status: 403,
    body: { message: 'violates PodSecurity "restricted:latest"' },
  })
  expect(
    await refused.sandbox.exec({ image: 'i', cmd: ['x'], limits: { timeout_s: 30 } }),
  ).toMatchObject({
    exitCode: 125,
    stderr: 'the cluster refused the pod (403): violates PodSecurity "restricted:latest"',
  })
})

it('a stopping worker ends its pods and starts no more; the next one removes leftovers', async () => {
  const { api, sandbox } = await setup(
    async () => [{ phase: 'Running', containerStatuses: [{}] }],
    {
      owner: 'w1',
    },
  )
  const running = sandbox.exec({ image: 'i', cmd: ['x'], limits: { timeout_s: 30 } })
  await new Promise((r) => setTimeout(r, 30))
  expect(await sandbox.killAll()).toBe(1)
  expect(api.calls.filter((c) => c.startsWith('DELETE'))).toHaveLength(1)
  await expect(sandbox.exec({ image: 'i', cmd: ['x'], limits: { timeout_s: 1 } })).rejects.toThrow(
    'shutting down',
  )
  // the fake keeps answering "running": end the wait the way a deleted pod does
  api.call = async () => ({ status: 404, body: {} })
  expect((await running).exitCode).toBe(137)

  const next = await setup(async () => [], { owner: 'w1' })
  expect(await next.sandbox.reap()).toBe(1)
  expect(next.api.calls).toEqual([
    'GET /pods?labelSelector=tiller-owner%3Dw1',
    'DELETE /pods/left-1?gracePeriodSeconds=0',
  ])
})
