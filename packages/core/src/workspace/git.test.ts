import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { forgeAuth, GitWorkspaces } from './git.js'

const g = (cwd: string, ...a: string[]) =>
  execFileSync('git', a, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  }).trim()

it('isolated workspace has no history beyond base', async () => {
  const cache = mkdtempSync(join(tmpdir(), 'tiller-git-'))
  const repo = join(cache, 'repos', 'o__r')
  execFileSync('mkdir', ['-p', repo])
  g(repo, 'init', '-q')
  writeFileSync(join(repo, 'a.txt'), 'base')
  g(repo, 'add', '-A')
  g(repo, 'commit', '-qm', 'base')
  const base = g(repo, 'rev-parse', 'HEAD')
  writeFileSync(join(repo, 'a.txt'), 'fix')
  g(repo, 'commit', '-qam', 'the fix')
  const fix = g(repo, 'rev-parse', 'HEAD')

  const ws = await new GitWorkspaces(cache).createIsolated('o/r', base, 'iso')
  expect(g(ws, 'log', '--all', '--oneline').split('\n')).toHaveLength(1)
  expect(() => g(ws, 'cat-file', '-t', fix)).toThrow()
  expect(g(ws, 'show', 'HEAD:a.txt')).toBe('base')
})

it("the factory's credential is a header for the forge only, and git never prompts", () => {
  const env = { ...process.env, ...forgeAuth('Authorization: Basic abc') }
  const header = (url: string) => {
    try {
      return execFileSync('git', ['config', '--get-urlmatch', 'http.extraHeader', url], {
        encoding: 'utf8',
        env,
      }).trim()
    } catch {
      return ''
    }
  }
  expect(header('https://github.com/o/r.git')).toBe('Authorization: Basic abc')
  // a redirect or a submodule elsewhere does not get it
  expect(header('https://example.com/o/r.git')).toBe('')
  expect(header('https://github.com.example.com/o/r.git')).toBe('')
  expect(env.GIT_TERMINAL_PROMPT).toBe('0')
  // without a credential: no header, still no prompt
  expect(forgeAuth()).toEqual({ GIT_TERMINAL_PROMPT: '0' })
})

it('fetch brings what the remote has now into the cache', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tiller-git-'))
  const origin = join(root, 'origin')
  execFileSync('mkdir', ['-p', origin])
  g(origin, 'init', '-q')
  writeFileSync(join(origin, 'a.txt'), '1')
  g(origin, 'add', '-A')
  g(origin, 'commit', '-qm', 'one')
  const ws = new GitWorkspaces(join(root, 'cache'), { auth: 'Authorization: Basic abc' })
  execFileSync('mkdir', ['-p', join(root, 'cache', 'repos')])
  g(root, 'clone', '-q', origin, ws.repoCache('o/r'))
  writeFileSync(join(origin, 'a.txt'), '2')
  g(origin, 'commit', '-qam', 'two')
  await ws.fetch('o/r')
  expect(g(ws.repoCache('o/r'), 'rev-parse', 'origin/HEAD')).toBe(g(origin, 'rev-parse', 'HEAD'))
})
