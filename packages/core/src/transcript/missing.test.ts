import { expect, it } from 'vitest'
import { missingCommands } from './missing.js'

it('finds missing commands across shell phrasings, inside JSON transcripts', () => {
  const transcript = [
    JSON.stringify({ type: 'user', content: 'Exit code 127\n/bin/sh: 1: python3: not found' }),
    JSON.stringify({ type: 'user', content: 'bash: line 1: python3: command not found' }),
    JSON.stringify({ type: 'user', content: 'bash: jq: command not found' }),
    JSON.stringify({ type: 'user', content: 'zsh: command not found: rg' }),
    JSON.stringify({ type: 'assistant', content: 'the file was not found, moving on' }),
  ].join('\n')
  expect(missingCommands(transcript)).toEqual([
    { command: 'python3', count: 2 },
    { command: 'jq', count: 1 },
    { command: 'rg', count: 1 },
  ])
})

it('is empty for a clean transcript', () => {
  expect(missingCommands('{"type":"result","result":"done"}')).toEqual([])
})
