import { type RepoProfile, RepoProfileSchema } from '../profile/profile.js'

/**
 * Onboarding: propose a sandbox profile for a repository from what is in it, so a team
 * starts from something that runs instead of an empty file. Pure: it sees the file list and reads
 * the few files it asks for. The proposal is checked by running it (`tiller repo add`), and the
 * repository's own `.factory/factory.yaml` replaces it once it exists.
 */
export interface RepoFiles {
  /** repo-relative paths of every tracked file */
  paths: string[]
  read(path: string): Promise<string | null>
}

export interface Detection {
  profile: RepoProfile | null
  /** what was found and what a human should check, in the order it was decided */
  notes: string[]
}

export const DEFAULT_IMAGE = process.env.TILLER_BASE_IMAGE || 'codetiller/base:dev'
const MAX_DEPTH = 3
/** nested dependency dirs beyond this are not worth a volume each: hoist, or list them by hand */
const MAX_NESTED = 24
const IGNORED =
  /(^|\/)(node_modules|vendor|testdata|fixtures?|examples?|third_party|dist|build|\.[^/]+)\//

/** a command that must exit 0, beyond the tests */
interface Check {
  name: string
  run: string
}

/** package scripts that check without changing anything, by the names repositories give them */
const CHECK_SCRIPTS = ['typecheck', 'type-check', 'tsc', 'lint']

/** The checking scripts of a package.json, run with npm (it only runs the script: no install, no network). */
function scriptChecks(pkg: PackageJson, dir: string): Check[] {
  return CHECK_SCRIPTS.filter((name) => pkg.scripts?.[name]).map((name) => ({
    name: dir ? `${name} (${dir})` : name,
    run: `${cd(dir)}npm run --silent ${name}`,
  }))
}

interface Unit {
  name: string
  lockfile: string
  setup: string
  deps: string[]
  test: string | null
  parser: RepoProfile['parser']
  cache?: { volume: string; path: string }
}

const dirOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '')
const depth = (path: string) => path.split('/').length - 1
const at = (dir: string, file: string) => (dir ? `${dir}/${file}` : file)
const cd = (dir: string) => (dir ? `cd ${dir} && ` : '')
const unitName = (dir: string, fallback: string) => (dir ? dir.replaceAll('/', '-') : fallback)

interface PackageJson {
  workspaces?: unknown
  scripts?: Record<string, string>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

const parseJson = <T>(text: string | null): T | null => {
  try {
    return text === null ? null : (JSON.parse(text) as T)
  } catch {
    return null
  }
}

/** How a JS package's tests are run with a report the factory can read; null = runner not recognised. */
function jsTest(pkg: PackageJson, dir: string): Pick<Unit, 'test' | 'parser'> | null {
  const has = (name: string) => Boolean(pkg.dependencies?.[name] ?? pkg.devDependencies?.[name])
  // binaries of the package itself first, then the root's (hoisted installs)
  const bins = `PATH="$PWD/node_modules/.bin:/workspace/node_modules/.bin:$PATH"`
  if (has('vitest'))
    return {
      test: `${cd(dir)}${bins} vitest run --reporter=json --outputFile={{out}} {{files}}`,
      parser: 'vitest-json',
    }
  if (has('jest'))
    return {
      test: `${cd(dir)}${bins} jest --json --outputFile={{out}} {{files}}`,
      parser: 'jest-json',
    }
  if (/\bnode\s+(--\S+\s+)*--test\b/.test(pkg.scripts?.test ?? ''))
    return {
      test: `${cd(dir)}node --test --test-reporter=junit --test-reporter-destination={{out}} {{files}}`,
      parser: 'junit-xml',
    }
  return null
}

async function jsUnits(files: RepoFiles, notes: string[], checks: Check[]): Promise<Unit[]> {
  const has = (p: string) => files.paths.includes(p)
  const manager = has('pnpm-lock.yaml')
    ? 'pnpm'
    : has('yarn.lock')
      ? 'yarn'
      : has('bun.lock') || has('bun.lockb')
        ? 'bun'
        : has('package-lock.json')
          ? 'npm'
          : null
  if (!has('package.json')) return []
  if (!manager) {
    notes.push(
      'package.json without a lockfile: JS dependencies are not installed (commit a lockfile)',
    )
    return []
  }
  const lockfile = {
    pnpm: 'pnpm-lock.yaml',
    yarn: 'yarn.lock',
    bun: has('bun.lock') ? 'bun.lock' : 'bun.lockb',
    npm: 'package-lock.json',
  }[manager]
  const setup = {
    pnpm: 'pnpm install --frozen-lockfile',
    // berry repos carry .yarnrc.yml; classic ones do not
    yarn: has('.yarnrc.yml') ? 'yarn install --immutable' : 'yarn install --frozen-lockfile',
    bun: 'bun install --frozen-lockfile',
    npm: 'npm ci',
  }[manager]
  const cache = {
    pnpm: { volume: 'tiller-pnpm-store', path: '/home/node/.pnpm-store' },
    yarn: { volume: 'tiller-yarn-cache', path: '/home/node/.cache/yarn' },
    bun: { volume: 'tiller-bun-cache', path: '/home/node/.bun/install/cache' },
    npm: { volume: 'tiller-npm-cache', path: '/home/node/.npm' },
  }[manager]
  const root = parseJson<PackageJson>(await files.read('package.json')) ?? {}
  const workspace = Boolean(root.workspaces) || has('pnpm-workspace.yaml')
  const nested = files.paths
    .filter((p) => p.endsWith('/package.json') && depth(p) <= MAX_DEPTH && !IGNORED.test(p))
    .map(dirOf)
  // workspace packages get a node_modules of their own (links, or versions that differ)
  const dirs = workspace ? nested.slice(0, MAX_NESTED) : []
  if (workspace && nested.length > MAX_NESTED)
    notes.push(
      `${nested.length} workspace packages: only the first ${MAX_NESTED} get a dependency volume; list the rest under deps, or hoist`,
    )
  notes.push(
    `JS: ${manager} (${lockfile})${workspace ? `, workspace with ${nested.length} packages` : ''}`,
  )
  // the root's checking scripts usually cover the workspace; without any, each package's own
  const rootChecks = scriptChecks(root, '')
  checks.push(...rootChecks)
  if (!rootChecks.length)
    for (const dir of nested)
      checks.push(
        ...scriptChecks(parseJson<PackageJson>(await files.read(`${dir}/package.json`)) ?? {}, dir),
      )
  const units: Unit[] = []
  const rootTest = jsTest(root, '')
  const main: Unit = {
    name: 'js',
    lockfile,
    setup,
    deps: ['node_modules', ...dirs.map((d) => `${d}/node_modules`)],
    cache,
    test: rootTest?.test ?? null,
    parser: rootTest?.parser ?? 'vitest-json',
  }
  units.push(main)
  // a workspace whose root runs no tests: each package that has a runner is a suite
  if (!rootTest)
    for (const dir of nested) {
      const t = jsTest(parseJson<PackageJson>(await files.read(`${dir}/package.json`)) ?? {}, dir)
      if (!t) continue
      if (main.test === null) Object.assign(main, t, { name: unitName(dir, 'js') })
      else units.push({ name: unitName(dir, 'js'), lockfile: '', setup: '', deps: [], ...t })
    }
  if (main.test === null)
    notes.push(
      'JS: no test runner recognised (vitest, jest, node --test): write the test command by hand',
    )
  return units
}

function goUnits(files: RepoFiles, notes: string[], checks: Check[]): Unit[] {
  const mods = files.paths
    .filter(
      (p) => (p === 'go.mod' || p.endsWith('/go.mod')) && depth(p) <= MAX_DEPTH && !IGNORED.test(p),
    )
    .map(dirOf)
  if (!mods.length) return []
  notes.push(
    `Go: ${mods.length === 1 ? 'module' : `${mods.length} modules`} at ${mods.map((d) => d || '.').join(', ')}`,
  )
  for (const d of mods)
    checks.push({ name: d ? `go vet (${d})` : 'go vet', run: `${cd(d)}go vet ./...` })
  const first = mods[0] as string
  const sum = at(first, 'go.sum')
  // the module cache is one directory for every module: one install fills it for all of them
  const install = {
    lockfile: files.paths.includes(sum) ? sum : at(first, 'go.mod'),
    setup: mods.map((d) => `(${cd(d)}go mod download)`).join(' && '),
    deps: ['/home/node/go/pkg/mod'],
  }
  if (mods.length > 1)
    notes.push(
      `Go: the module cache is keyed by ${install.lockfile} only; a change in another module's go.sum needs that file touched too`,
    )
  return mods.map((d, i) => ({
    name: unitName(d, 'go'),
    ...(i === 0 ? install : { lockfile: '', setup: '', deps: [] }),
    test: `${cd(d)}go test -json ./... > {{out}}`,
    parser: 'go-test-json' as const,
  }))
}

async function pythonUnits(files: RepoFiles, notes: string[]): Promise<Unit[]> {
  const markers = ['pyproject.toml', 'setup.py', 'requirements.txt']
  const dirs = [
    ...new Set(
      files.paths
        .filter(
          (p) =>
            markers.some((m) => p === m || p.endsWith(`/${m}`)) &&
            depth(p) <= MAX_DEPTH &&
            !IGNORED.test(p),
        )
        .map(dirOf),
    ),
  ]
  const units: Unit[] = []
  for (const dir of dirs) {
    const here = (f: string) => files.paths.includes(at(dir, f))
    // a Python project without tests is not something to verify
    const tested = files.paths.some(
      (p) =>
        (dir === '' || p.startsWith(`${dir}/`)) &&
        /(^|\/)(test_[^/]+|[^/]+_test)\.py$/.test(p) &&
        !IGNORED.test(p),
    )
    if (!tested) continue
    const py = '.venv/bin/python'
    const pyproject = here('pyproject.toml')
      ? ((await files.read(at(dir, 'pyproject.toml'))) ?? '')
      : ''
    // extras that usually carry the test dependencies
    const extras = ['test', 'tests', 'testing', 'dev'].filter((e) =>
      new RegExp(`^${e}\\s*=\\s*\\[`, 'm').test(
        pyproject.split(/^\[project\.optional-dependencies\]\s*$/m)[1]?.split(/^\[/m)[0] ?? '',
      ),
    )
    const project = here('pyproject.toml') || here('setup.py')
    let lockfile: string
    let setup: string
    if (here('uv.lock')) {
      lockfile = at(dir, 'uv.lock')
      // the lockfile names files by URL at hosts an install cannot reach: resolve its pins through the index
      setup = `${cd(dir)}uv venv .venv && uv export --frozen --no-hashes --no-emit-project --all-groups --all-extras -o /tmp/requirements.txt && uv pip install --python ${py} -r /tmp/requirements.txt pytest && uv pip install --python ${py} --no-deps -e .`
    } else if (here('requirements.txt')) {
      lockfile = at(dir, 'requirements.txt')
      const more = ['requirements-dev.txt', 'requirements-test.txt', 'dev-requirements.txt'].filter(
        here,
      )
      setup = `${cd(dir)}uv venv .venv && uv pip install --python ${py} -r requirements.txt ${more.map((f) => `-r ${f} `).join('')}pytest${project ? ` && uv pip install --python ${py} --no-deps -e .` : ''}`
      notes.push(
        `Python${dir ? ` (${dir})` : ''}: requirements.txt is not a lockfile: versions it leaves open are resolved at install time`,
      )
    } else {
      lockfile = at(dir, here('pyproject.toml') ? 'pyproject.toml' : 'setup.py')
      setup = `${cd(dir)}uv venv .venv && uv pip install --python ${py} -e ".${extras.length ? `[${extras.join(',')}]` : ''}" pytest`
      notes.push(
        `Python${dir ? ` (${dir})` : ''}: no lockfile: dependencies are resolved at install time${extras.length ? ` (extras: ${extras.join(', ')})` : ''}`,
      )
    }
    notes.push(`Python: pytest in ${dir || '.'} (${lockfile})`)
    units.push({
      name: unitName(dir, 'python'),
      lockfile,
      setup,
      deps: [at(dir, '.venv')],
      cache: { volume: 'tiller-uv-cache', path: '/home/node/.cache/uv' },
      test: `${cd(dir)}${py} -m pytest -p no:cacheprovider --junitxml={{out}} {{files}}`,
      parser: 'junit-xml',
    })
  }
  return units
}

/**
 * The profile a repository can start with: the first unit that installs and tests is the main
 * toolchain, every other unit a suite (with its own install when it has one).
 */
export async function detectProfile(files: RepoFiles): Promise<Detection> {
  const notes: string[] = []
  const checks: Check[] = []
  const units = [
    ...(await jsUnits(files, notes, checks)),
    ...(await pythonUnits(files, notes)),
    ...goUnits(files, notes, checks),
  ]
  if (checks.length) notes.push(`checks: ${checks.map((c) => c.name).join(', ')}`)
  // the main toolchain is the first unit with an install (a lockfile): JS, then Python, then Go
  const main = units.find((u) => u.lockfile)
  if (!main) {
    notes.push(
      'nothing recognised (no package.json with a lockfile, go.mod or Python project with tests): write .factory/factory.yaml by hand',
    )
    return { profile: null, notes }
  }
  const profile = RepoProfileSchema.parse({
    image: DEFAULT_IMAGE,
    toolchains: [
      {
        lockfile: main.lockfile,
        setup: main.setup,
        // no tests in the main unit: an empty report, so the suites decide
        test: main.test ?? `echo '{"testResults":[]}' > {{out}}`,
        deps: main.deps,
        ...(main.cache ? { cache: main.cache } : {}),
      },
    ],
    parser: main.parser,
    checks,
    // every other unit with tests is a suite, with its own install when it has one
    suites: units
      .filter((u) => u !== main && u.test)
      .map((u) => ({
        name: u.name,
        test: (u.test as string).replace(' {{files}}', ''),
        parser: u.parser,
        ...(u.lockfile
          ? {
              lockfile: u.lockfile,
              setup: u.setup,
              deps: u.deps,
              ...(u.cache ? { cache: u.cache } : {}),
            }
          : {}),
      })),
  })
  return { profile, notes }
}
