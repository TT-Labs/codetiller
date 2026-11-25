import { expect, it } from 'vitest'
import { detectProfile, type RepoFiles } from './detect.js'

const repo = (files: Record<string, string>): RepoFiles => ({
  paths: Object.keys(files),
  read: async (p) => files[p] ?? null,
})
const pkg = (o: object) => JSON.stringify(o)

it('a pnpm workspace with a vitest package and a Go module: one install each, two suites', async () => {
  const { profile, notes } = await detectProfile(
    repo({
      'package.json': pkg({ private: true }),
      'pnpm-lock.yaml': '',
      'pnpm-workspace.yaml': 'packages:\n  - apps/*\n',
      'apps/web/package.json': pkg({
        devDependencies: { vitest: '^4' },
        scripts: { typecheck: 'tsc --noEmit', build: 'vite build', test: 'vitest run' },
      }),
      'apps/web/src/a.test.ts': '',
      'apps/api/go.mod': 'module x',
      'apps/api/main_test.go': '',
      'node_modules/x/package.json': '{}',
    }),
  )
  expect(profile).toMatchObject({
    image: 'codetiller/base:dev',
    toolchains: [
      {
        lockfile: 'pnpm-lock.yaml',
        setup: 'pnpm install --frozen-lockfile',
        deps: ['node_modules', 'apps/web/node_modules'],
        test: 'cd apps/web && PATH="$PWD/node_modules/.bin:/workspace/node_modules/.bin:$PATH" vitest run --reporter=json --outputFile={{out}} {{files}}',
        cache: { volume: 'tiller-pnpm-store', path: '/home/node/.pnpm-store' },
      },
    ],
    parser: 'vitest-json',
    suites: [
      {
        name: 'apps-api',
        test: 'cd apps/api && go test -json ./... > {{out}}',
        parser: 'go-test-json',
        lockfile: 'apps/api/go.mod',
        setup: '(cd apps/api && go mod download)',
        deps: ['/home/node/go/pkg/mod'],
      },
    ],
  })
  // checks beyond the tests: the package's own checking scripts (not its build), and go vet
  expect(profile?.checks).toEqual([
    { name: 'typecheck (apps/web)', run: 'cd apps/web && npm run --silent typecheck' },
    { name: 'go vet (apps/api)', run: 'cd apps/api && go vet ./...' },
  ])
  expect(notes).toEqual([
    'JS: pnpm (pnpm-lock.yaml), workspace with 1 packages',
    'Go: module at apps/api',
    'checks: typecheck (apps/web), go vet (apps/api)',
  ])
})

it('npm with jest, yarn berry, bun, and the built-in node test runner', async () => {
  const jest = await detectProfile(
    repo({ 'package.json': pkg({ devDependencies: { jest: '^29' } }), 'package-lock.json': '' }),
  )
  expect(jest.profile?.toolchains[0]).toMatchObject({
    lockfile: 'package-lock.json',
    setup: 'npm ci',
    deps: ['node_modules'],
    test: 'PATH="$PWD/node_modules/.bin:/workspace/node_modules/.bin:$PATH" jest --json --outputFile={{out}} {{files}}',
  })
  expect(jest.profile?.parser).toBe('jest-json')
  const berry = await detectProfile(
    repo({
      'package.json': pkg({ devDependencies: { vitest: '1' } }),
      'yarn.lock': '',
      '.yarnrc.yml': '',
    }),
  )
  expect(berry.profile?.toolchains[0]?.setup).toBe('yarn install --immutable')
  const bun = await detectProfile(
    repo({ 'package.json': pkg({ scripts: { test: 'node --test' } }), 'bun.lock': '' }),
  )
  expect(bun.profile?.toolchains[0]).toMatchObject({
    setup: 'bun install --frozen-lockfile',
    test: 'node --test --test-reporter=junit --test-reporter-destination={{out}} {{files}}',
  })
  expect(bun.profile?.parser).toBe('junit-xml')
})

it('Python: a uv lockfile, a requirements file, or the project alone', async () => {
  const uv = await detectProfile(
    repo({ 'pyproject.toml': '[project]\nname = "x"\n', 'uv.lock': '', 'tests/test_a.py': '' }),
  )
  expect(uv.profile).toMatchObject({
    toolchains: [
      {
        lockfile: 'uv.lock',
        deps: ['.venv'],
        test: '.venv/bin/python -m pytest -p no:cacheprovider --junitxml={{out}} {{files}}',
        cache: { volume: 'tiller-uv-cache', path: '/home/node/.cache/uv' },
      },
    ],
    parser: 'junit-xml',
  })
  expect(uv.profile?.toolchains[0]?.setup).toContain('uv export --frozen')
  const plain = await detectProfile(
    repo({
      'services/api/pyproject.toml':
        '[project]\nname = "x"\n[project.optional-dependencies]\ntest = ["pytest"]\ndocs = ["sphinx"]\n',
      'services/api/tests/test_a.py': '',
    }),
  )
  expect(plain.profile?.toolchains[0]).toMatchObject({
    lockfile: 'services/api/pyproject.toml',
    setup:
      'cd services/api && uv venv .venv && uv pip install --python .venv/bin/python -e ".[test]" pytest',
    deps: ['services/api/.venv'],
    test: 'cd services/api && .venv/bin/python -m pytest -p no:cacheprovider --junitxml={{out}} {{files}}',
  })
  expect(plain.notes.join('\n')).toContain('no lockfile: dependencies are resolved at install time')
  // a Python project without tests is not picked up
  expect(
    (await detectProfile(repo({ 'pyproject.toml': '[project]\n', 'src/a.py': '' }))).profile,
  ).toBeNull()
})

it('says what it could not work out instead of guessing', async () => {
  const noRunner = await detectProfile(
    repo({ 'package.json': pkg({ devDependencies: { mocha: '10' } }), 'package-lock.json': '' }),
  )
  expect(noRunner.profile?.toolchains[0]?.test).toBe(`echo '{"testResults":[]}' > {{out}}`)
  expect(noRunner.notes.at(-1)).toMatch(/no test runner recognised/)
  const noLock = await detectProfile(repo({ 'package.json': '{}' }))
  expect(noLock.profile).toBeNull()
  expect(noLock.notes[0]).toMatch(/without a lockfile/)
  expect((await detectProfile(repo({ 'README.md': '' }))).notes.at(-1)).toMatch(
    /^nothing recognised/,
  )
})
