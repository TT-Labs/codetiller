import { expect, it } from 'vitest'
import { DockerSandbox } from './sandbox.js'

it('builds docker args with limits, env by name only', () => {
  const args = new DockerSandbox().buildArgs(
    {
      image: 'codetiller/hono',
      cmd: ['echo', 'hi'],
      mounts: [{ host: '/tmp/ws', container: '/workspace' }],
      env: { ANTHROPIC_API_KEY: 'secret' },
      limits: { timeout_s: 10 },
    },
    'n',
  )
  expect(args).toContain('--pids-limit')
  expect(args.join(' ')).toContain('--cap-drop ALL --security-opt no-new-privileges')
  expect(args).not.toContain('--cap-add')
  expect(args).toContain('/tmp/ws:/workspace')
  expect(args.join(' ')).not.toContain('secret')
  expect(args.slice(-3)).toEqual(['codetiller/hono', 'echo', 'hi'])
})

it('adds network none when requested', () => {
  const args = new DockerSandbox().buildArgs(
    { image: 'i', cmd: ['x'], network: 'none', limits: { timeout_s: 1 } },
    'n',
  )
  expect(args.join(' ')).toContain('--network none')
})

it('joins a named network and keeps only the capabilities asked for', () => {
  const args = new DockerSandbox().buildArgs(
    {
      image: 'i',
      cmd: ['x'],
      network: 'tiller-agents',
      user: '0:0',
      caps: ['CHOWN'],
      limits: { timeout_s: 1 },
    },
    'n',
  )
  expect(args.join(' ')).toContain('--network tiller-agents')
  expect(args.join(' ')).toContain(
    '--cap-drop ALL --security-opt no-new-privileges --cap-add CHOWN',
  )
})

it("a worker's containers carry its name; other processes' do not", () => {
  const req = { image: 'i', cmd: ['x'], limits: { timeout_s: 1 } }
  expect(new DockerSandbox({ owner: 'abc123' }).buildArgs(req, 'n').join(' ')).toContain(
    '--label tiller.owner=abc123',
  )
  expect(new DockerSandbox().buildArgs(req, 'n')).not.toContain('--label')
})

it('after it stopped its containers a sandbox starts nothing new', async () => {
  const sandbox = new DockerSandbox()
  expect(await sandbox.killAll()).toBe(0)
  await expect(sandbox.exec({ image: 'i', cmd: ['x'], limits: { timeout_s: 1 } })).rejects.toThrow(
    'the factory is shutting down',
  )
})
