import { expect, it } from 'vitest'
import {
  gate,
  PreflightLimitsSchema,
  type PreflightReport,
  PreflightReportSchema,
  parsePreflight,
  renderPreflight,
  resolveLimits,
  tolerated,
} from './preflight.js'

const limits = PreflightLimitsSchema.parse({})
const report = (over: Partial<PreflightReport> = {}): PreflightReport =>
  PreflightReportSchema.parse({
    summary: 'Add a thing.',
    files: ['a.ts'],
    concepts: ['x'],
    ...over,
  })

it('reads the last fenced JSON block and fills missing lists', () => {
  const text =
    'Example:\n```json\n{"summary": "example"}\n```\nMy assessment:\n```json\n{"summary": "Real", "files": ["a.go", "a_test.go"]}\n```\n'
  expect(parsePreflight(text)).toEqual({
    summary: 'Real',
    files: ['a.go', 'a_test.go'],
    concepts: [],
    dependencies: [],
    risks: [],
    questions: [],
    subtasks: [],
  })
  expect(() => parsePreflight('I think it is fine.')).toThrow(/no JSON block/)
  expect(() => parsePreflight('```json\n{"files": "many"}\n```')).toThrow()
  expect(() => parsePreflight('```json\n{"subtasks": [{"body": "no title"}]}\n```')).toThrow()
  expect(() => parsePreflight(undefined)).toThrow(/no JSON block/)
})

it('accepts list entries the agent structured on its own', () => {
  const r = parsePreflight(
    `\`\`\`json\n${JSON.stringify({
      files: ['a.go', { path: 'b.go', reason: 'new handler' }],
      questions: [
        { question: 'Sessions or tokens?', options: ['cookie session', 'JWT'] },
        '',
        null,
      ],
      risks: [42],
    })}\n\`\`\``,
  )
  expect(r.files).toEqual(['a.go', 'b.go — new handler'])
  expect(r.questions).toEqual(['Sessions or tokens? — cookie session; JWT'])
  expect(r.risks).toEqual(['42'])
})

it('defaults: enabled, 10 files, 3 concepts, 20 % tolerance', () => {
  expect(limits).toEqual({ enabled: true, max_files: 10, max_concepts: 3, tolerance: 0.2 })
})

it('tolerates a small overrun: two files over a limit of ten is not worth a split', () => {
  const files = (n: number) => Array.from({ length: n }, (_, i) => `f${i}.ts`)
  expect(tolerated(limits)).toEqual({ files: 12, concepts: 3 })
  expect(gate(report({ files: files(12) }), limits)).toBe('pass')
  expect(gate(report({ files: files(13) }), limits)).toBe('too_large')
  // the tolerance is a share of the limit, so it scales with it; zero switches it off
  expect(tolerated({ ...limits, max_files: 20, max_concepts: 5 })).toEqual({
    files: 24,
    concepts: 6,
  })
  expect(gate(report({ files: files(11) }), { ...limits, tolerance: 0 })).toBe('too_large')
  expect(renderPreflight(report({ files: files(12) }), 'pass', limits).split('\n')[0]).toBe(
    'Preflight passed · 12 files (limit 10, within tolerance up to 12) · 1 concepts (limit 3)',
  )
})

it('gates on the numbers; size wins over questions', () => {
  const files = (n: number) => Array.from({ length: n }, (_, i) => `f${i}.ts`)
  expect(gate(report(), limits)).toBe('pass')
  expect(gate(report({ files: files(10), concepts: ['a', 'b', 'c'] }), limits)).toBe('pass')
  expect(gate(report({ files: files(13) }), limits)).toBe('too_large')
  expect(gate(report({ concepts: ['a', 'b', 'c', 'd'] }), limits)).toBe('too_large')
  expect(gate(report({ questions: ['A or B?'] }), limits)).toBe('unclear')
  expect(gate(report({ files: files(13), questions: ['A or B?'] }), limits)).toBe('too_large')
  // the agent proposing a split does not block a task that fits
  expect(gate(report({ subtasks: [{ title: 'part', body: 'b' }] }), limits)).toBe('pass')
})

it('renders the verdict with its numbers and the next steps', () => {
  const big = report({
    files: Array.from({ length: 14 }, (_, i) => `f${i}.ts`),
    concepts: ['accounts', 'sharing'],
    risks: ['data migration'],
    subtasks: [
      { title: 'Accounts', body: 'b' },
      { title: 'Sharing', body: 'b' },
    ],
  })
  const text = renderPreflight(big, 'too_large', limits)
  expect(text.split('\n')[0]).toBe(
    'Preflight: too large for one run · 14 files (limit 10) · 2 concepts (limit 3)',
  )
  expect(text).toContain('Files:\n- f0.ts\n')
  expect(text).toContain('- f11.ts\n- … and 2 more\n\nRisks:')
  expect(
    renderPreflight({ ...big, files: [...big.files, 'f12.ts'] }, 'too_large', limits),
  ).toContain('- f11.ts\n- … and 3 more\n\nRisks:')
  expect(text).toContain('Proposed split:\n1. Accounts\n2. Sharing')
  expect(text).toContain('Next: split into these tasks')
  expect(renderPreflight(report({ questions: ['A or B?'] }), 'unclear', limits)).toContain(
    'Questions:\n1. A or B?\n\nNext: enqueue with your answers, or cancel.',
  )
  const pass = renderPreflight(report(), 'pass', limits)
  expect(pass).not.toContain('Next:')
  expect(pass).not.toContain('Proposed split')
})

it('resolves limits per repository: repo file over project entry over default, field by field', () => {
  expect(resolveLimits(limits)).toEqual({ ...limits, source: 'default' })
  expect(resolveLimits(limits, { max_files: 15 })).toEqual({
    enabled: true,
    max_files: 15,
    max_concepts: 3,
    tolerance: 0.2,
    source: 'project',
  })
  // the repository sets one number: the other still comes from the project
  expect(
    resolveLimits(limits, { max_files: 15, max_concepts: 5 }, 'preflight:\n  max_files: 25\n'),
  ).toEqual({ enabled: true, max_files: 25, max_concepts: 5, tolerance: 0.2, source: 'repository' })
  // tolerance is set per level like the limits
  expect(resolveLimits(limits, { tolerance: 0.5 }, 'preflight: { tolerance: 0 }').tolerance).toBe(0)
  expect(resolveLimits(limits, { tolerance: 0.5 }).tolerance).toBe(0.5)
  expect(resolveLimits(limits, undefined, 'preflight: { enabled: false }').enabled).toBe(false)
  // a file without a preflight section, or an empty one, changes nothing
  expect(resolveLimits(limits, { max_files: 15 }, 'other: 1\n').source).toBe('project')
  expect(resolveLimits(limits, undefined, '').source).toBe('default')
})

it('a broken repository config is an error that names the file, not a silent default', () => {
  expect(() => resolveLimits(limits, undefined, 'preflight:\n  max_fiels: 25\n')).toThrow(
    /^\.factory\/factory\.yaml: /,
  )
  expect(() => resolveLimits(limits, undefined, 'preflight: { max_files: 0 }')).toThrow(
    /\.factory\/factory\.yaml/,
  )
  expect(() => resolveLimits(limits, undefined, 'preflight: [')).toThrow(/\.factory\/factory\.yaml/)
})

it('says where non-default limits came from', () => {
  const r = report({ questions: ['A or B?'] })
  expect(
    renderPreflight(r, 'unclear', { ...limits, max_files: 25, source: 'repository' }),
  ).toContain(
    '1 files (limit 25) · 1 concepts (limit 3) · limits set by the repository (.factory/factory.yaml)',
  )
  expect(
    renderPreflight(r, 'unclear', { ...limits, source: 'default' }).split('\n')[0],
  ).not.toContain('limits set')
})
