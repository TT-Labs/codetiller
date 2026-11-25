import { expect, it } from 'vitest'
import { parseGoTestJson } from './gotest.js'

const ev = (o: object) => JSON.stringify(o)

it('parses tests, subtests and package results', () => {
  const out = [
    ev({ Action: 'start', Package: 'm/a' }),
    ev({ Action: 'run', Package: 'm/a', Test: 'TestX' }),
    ev({ Action: 'output', Package: 'm/a', Test: 'TestX/sub', Output: 'boom\n' }),
    ev({ Action: 'fail', Package: 'm/a', Test: 'TestX/sub' }),
    ev({ Action: 'fail', Package: 'm/a', Test: 'TestX' }),
    ev({ Action: 'pass', Package: 'm/a', Test: 'TestY' }),
    ev({ Action: 'fail', Package: 'm/a' }),
    ev({ Action: 'skip', Package: 'm/cmd' }),
    'not json',
  ].join('\n')
  expect(parseGoTestJson(out)).toEqual([
    { id: 'm/a > TestX/sub', passed: false, message: 'boom\n' },
    { id: 'm/a > TestX', passed: false, message: undefined },
    { id: 'm/a > TestY', passed: true },
    { id: 'm/a > (package)', passed: false, message: undefined },
  ])
})

it('a package that does not compile is a failing case', () => {
  const out = [
    ev({ Action: 'output', Package: 'm/b', Output: './x.go:3:1: syntax error\n' }),
    ev({ Action: 'fail', Package: 'm/b' }),
  ].join('\n')
  expect(parseGoTestJson(out)).toEqual([
    { id: 'm/b > (package)', passed: false, message: './x.go:3:1: syntax error\n' },
  ])
})
