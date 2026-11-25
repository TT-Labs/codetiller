import { expect, it } from 'vitest'
import {
  diffForPrompt,
  MAX_DIFF_CHARS,
  parseReview,
  renderReview,
  reviewVerdict,
} from './review.js'

const answer = (report: unknown) => `Read it.\n\n\`\`\`json\n${JSON.stringify(report)}\n\`\`\``

it('reads the findings from the last JSON block and renders them for the human', () => {
  const r = parseReview(
    answer({
      summary: 'Adds a JSON 404.',
      findings: [
        {
          kind: 'quality',
          file: 'apps/api/server.go',
          line: 8,
          title: 'test package in server code',
          detail: 'net/http/httptest is imported into the binary.',
        },
        {
          kind: 'quality',
          weight: 'note',
          file: 'auth.go',
          line: 3,
          title: 'same limit elsewhere',
        },
        // the reader called it a note; a finding about the checks is never one
        {
          kind: 'verification',
          weight: 'note',
          file: 'vitest.config.ts',
          title: 'alias replaces the code under test',
        },
      ],
    }),
  )
  expect(reviewVerdict(r)).toBe('concerns')
  expect(renderReview(r)).toBe(
    [
      'second reader: 2 concerns, 1 note',
      '',
      'Adds a JSON 404.',
      '',
      '- [quality] `apps/api/server.go:8` test package in server code: net/http/httptest is imported into the binary.',
      '- [verification] `vitest.config.ts` alias replaces the code under test',
      '- [note] `auth.go:3` same limit elsewhere',
    ].join('\n'),
  )
  // remarks alone are not concerns
  const remarks = parseReview(
    answer({ findings: [{ kind: 'quality', weight: 'note', title: 't' }] }),
  )
  expect(reviewVerdict(remarks)).toBe('notes')
  expect(renderReview(remarks).split('\n')[0]).toBe('second reader: no concerns, 1 note')
})

it('no findings is a verdict of its own; a loosely shaped answer is still read', () => {
  const clean = parseReview(answer({ summary: 'Does what the issue asks.', findings: [] }))
  expect(reviewVerdict(clean)).toBe('ok')
  expect(renderReview(clean)).toBe('second reader: no concerns\n\nDoes what the issue asks.')
  // an unknown kind, a line that is not a number, missing fields
  const loose = parseReview(answer({ findings: [{ kind: 'nitpick', line: 'x', title: 't' }] }))
  expect(loose.findings).toEqual([
    { kind: 'quality', weight: 'change', file: '', title: 't', detail: '' },
  ])
  expect(() => parseReview('no block here')).toThrow('no JSON block')
  expect(() => parseReview(answer({ findings: [{ kind: 'quality' }] }))).toThrow()
})

it('a diff too long for the prompt is cut, and the reader is told', () => {
  expect(diffForPrompt('abc')).toBe('abc')
  const long = diffForPrompt('x'.repeat(MAX_DIFF_CHARS + 500))
  expect(long.length).toBeLessThan(MAX_DIFF_CHARS + 200)
  expect(long).toContain('500 more characters; read the files in /workspace')
})
