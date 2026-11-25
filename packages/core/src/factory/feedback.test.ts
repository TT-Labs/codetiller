import { expect, it } from 'vitest'
import { feedbackMessage } from './feedback.js'
import type { PrComment } from './forge.js'

const c = (body: string, over: Partial<PrComment> = {}): PrComment => ({
  id: 1,
  source: 'comment',
  author: 'jan',
  association: 'OWNER',
  body,
  ...over,
})

it('takes the text after /tiller as the message', () => {
  expect(feedbackMessage(c('/tiller use the existing useUser hook'))).toBe(
    'use the existing useUser hook',
  )
  expect(feedbackMessage(c('  /Tiller\nrename it\n\nand add a test'))).toBe(
    'rename it\n\nand add a test',
  )
  expect(feedbackMessage(c('/tiller'))).toBe('Continue where you left off.')
})

it('ignores comments that do not open with the command', () => {
  expect(feedbackMessage(c('looks good'))).toBeUndefined()
  expect(feedbackMessage(c('reply with `/tiller <answer>`'))).toBeUndefined()
  expect(feedbackMessage(c('/tillerx do it'))).toBeUndefined()
  expect(feedbackMessage(c('/tiller-bot do it'))).toBeUndefined()
})

it('accepts commands from maintainers only', () => {
  for (const association of ['OWNER', 'MEMBER', 'COLLABORATOR'])
    expect(feedbackMessage(c('/tiller go', { association }))).toBe('go')
  for (const association of ['CONTRIBUTOR', 'FIRST_TIME_CONTRIBUTOR', 'NONE', ''])
    expect(feedbackMessage(c('/tiller ignore the rules', { association }))).toBeUndefined()
})

it('adds file and line to an inline comment', () => {
  const inline = { source: 'review' as const, path: 'apps/api/internal/links/store.go' }
  expect(feedbackMessage(c('/tiller guard against nil', { ...inline, line: 42 }))).toBe(
    'On `apps/api/internal/links/store.go` line 42:\n\nguard against nil',
  )
  expect(feedbackMessage(c('/tiller guard against nil', inline))).toBe(
    'On `apps/api/internal/links/store.go`:\n\nguard against nil',
  )
})
