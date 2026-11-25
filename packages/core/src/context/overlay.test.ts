import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { overlayContext } from './overlay.js'

const skill = [{ name: 's', version: 1, body: 'SKILL BODY' }]
const dir = () => mkdtempSync(join(tmpdir(), 'tiller-overlay-'))

it('no skills: nothing is written', async () => {
  const ws = dir()
  const o = await overlayContext(ws, 'CLAUDE.md', [])
  expect(o.rendered).toBe('')
  expect(existsSync(join(ws, 'CLAUDE.md'))).toBe(false)
})

it('missing file: created for the run, removed after', async () => {
  const ws = dir()
  const o = await overlayContext(ws, 'CLAUDE.md', skill)
  expect(readFileSync(join(ws, 'CLAUDE.md'), 'utf8')).toContain('SKILL BODY')
  await o.restore()
  expect(existsSync(join(ws, 'CLAUDE.md'))).toBe(false)
})

it('regular file: repo content first, restored byte for byte', async () => {
  const ws = dir()
  writeFileSync(join(ws, 'CLAUDE.md'), 'REPO RULES\n')
  const o = await overlayContext(ws, 'CLAUDE.md', skill)
  expect(o.rendered.indexOf('REPO RULES')).toBeLessThan(o.rendered.indexOf('SKILL BODY'))
  writeFileSync(join(ws, 'CLAUDE.md'), 'agent scribbled here')
  await o.restore()
  expect(readFileSync(join(ws, 'CLAUDE.md'), 'utf8')).toBe('REPO RULES\n')
})

it('symlink inside the workspace: target is read but never modified, link comes back', async () => {
  const ws = dir()
  writeFileSync(join(ws, 'AGENTS.md'), 'REPO RULES\n')
  symlinkSync('AGENTS.md', join(ws, 'CLAUDE.md'))
  const o = await overlayContext(ws, 'CLAUDE.md', skill)
  expect(o.rendered).toContain('REPO RULES')
  expect(lstatSync(join(ws, 'CLAUDE.md')).isSymbolicLink()).toBe(false)
  expect(readFileSync(join(ws, 'AGENTS.md'), 'utf8')).toBe('REPO RULES\n')
  await o.restore()
  expect(readlinkSync(join(ws, 'CLAUDE.md'))).toBe('AGENTS.md')
  expect(readFileSync(join(ws, 'AGENTS.md'), 'utf8')).toBe('REPO RULES\n')
})

it('symlink pointing outside the workspace is neither read nor written', async () => {
  const ws = dir()
  const outside = join(dir(), 'secret.txt')
  writeFileSync(outside, 'HOST SECRET')
  symlinkSync(outside, join(ws, 'CLAUDE.md'))
  const o = await overlayContext(ws, 'CLAUDE.md', skill)
  expect(o.rendered).not.toContain('HOST SECRET')
  // the agent swaps the file for another outside link during the run
  await o.restore()
  expect(readFileSync(outside, 'utf8')).toBe('HOST SECRET')
  expect(readlinkSync(join(ws, 'CLAUDE.md'))).toBe(outside)
})
