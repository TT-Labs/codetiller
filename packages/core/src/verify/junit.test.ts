import { expect, it } from 'vitest'
import { parseJUnitXml } from './junit.js'

it('reads a pytest report: passed, failed with its message, error; skipped tests are left out', () => {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<testsuites name="pytest tests"><testsuite name="pytest" errors="1" failures="1" skipped="1" tests="5">
<testcase classname="tests.test_signer" name="test_sign" time="0.001" />
<testcase classname="tests.test_signer" name="test_bad[a &amp; b]" time="0.002"><failure message="assert 1 == 2">def test_bad():
&gt;   assert 1 == 2
E   assert 1 == 2</failure></testcase>
<testcase classname="tests.test_signer.TestTimed" name="test_later" time="0.1"><skipped type="pytest.skip" message="later">x</skipped></testcase>
<testcase classname="tests.test_io" name="test_open"><error message="fixture 'tmp' not found"/></testcase>
<testcase classname="tests.test_io" name="test_close" time="0.0"></testcase>
</testsuite></testsuites>`
  expect(parseJUnitXml(xml)).toEqual([
    { id: 'tests.test_signer > test_sign', passed: true },
    {
      id: 'tests.test_signer > test_bad[a & b]',
      passed: false,
      message: 'assert 1 == 2\ndef test_bad():\n>   assert 1 == 2\nE   assert 1 == 2',
    },
    { id: 'tests.test_io > test_open', passed: false, message: "fixture 'tmp' not found" },
    { id: 'tests.test_io > test_close', passed: true },
  ])
})

it('names a case by its suite when it has no classname; refuses what is not a report', () => {
  const xml = `<testsuite name="math"><testcase name="adds"/><testcase name='fails'><failure><![CDATA[a < b]]></failure></testcase></testsuite>`
  expect(parseJUnitXml(xml)).toEqual([
    { id: 'math > adds', passed: true },
    { id: 'math > fails', passed: false, message: 'a < b' },
  ])
  expect(() => parseJUnitXml('{"testResults":[]}')).toThrow('not a JUnit XML report')
  expect(parseJUnitXml('<testsuites></testsuites>')).toEqual([])
})
