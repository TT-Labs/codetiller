import { readFile } from 'node:fs/promises'
import { parse } from 'yaml'
import { z } from 'zod'
import { sha256 } from '../util/hash.js'

export const TaskSchema = z.object({
  id: z.string(),
  repo: z.string(),
  base_commit: z.string(),
  fix_commit: z.string(),
  issue: z.object({ title: z.string(), body: z.string(), url: z.string().optional() }),
  hidden_tests: z.array(z.string()).min(1),
  fail_to_pass: z.array(z.string()).min(1),
  pass_to_pass: z.union([z.literal('suite'), z.array(z.string())]),
  tags: z.array(z.string()).default([]),
  difficulty: z.enum(['small', 'medium', 'large']).optional(),
  created_at: z.string().optional(),
})

export type Task = z.infer<typeof TaskSchema> & { spec_hash: string }

export async function loadTask(path: string): Promise<Task> {
  const raw = await readFile(path, 'utf8')
  return { ...TaskSchema.parse(parse(raw)), spec_hash: sha256(raw) }
}

/** package-manager cache volume (keeps reinstalls offline-ish) */
const CacheSchema = z.object({ volume: z.string(), path: z.string() })

/**
 * Where installed dependencies live: paths in the workspace (`node_modules`, `.venv`,
 * `apps/web/node_modules`) or absolute ones (Go's module cache). Each is a volume filled once by
 * `setup` and mounted read-only into agent and test containers.
 */
const DepsSchema = z.array(z.string().min(1)).min(1)

const ToolchainSchema = z.object({
  /** its content keys the dependency volumes: a changed lockfile is a new install */
  lockfile: z.string(),
  setup: z.string(),
  test: z.string(),
  deps: DepsSchema.default(['node_modules']),
  cache: CacheSchema.optional(),
})

export type Toolchain = z.infer<typeof ToolchainSchema>

/** `jest-json` is the format vitest's JSON reporter copies; `junit-xml` is what most other runners can write */
const ParserSchema = z.enum(['vitest-json', 'jest-json', 'go-test-json', 'junit-xml'])
export type Parser = z.infer<typeof ParserSchema>

/**
 * Extra test suite for factory verification (polyglot repos): own command + report format, and
 * its own dependency install when it has a `lockfile` and a `setup` (a Python service next to
 * a JS app).
 */
const SuiteSchema = z.object({
  name: z.string(),
  /** shell command writing its report to {{out}} */
  test: z.string(),
  parser: ParserSchema,
  lockfile: z.string().optional(),
  setup: z.string().optional(),
  deps: DepsSchema.optional(),
  cache: CacheSchema.optional(),
})

export type Suite = z.infer<typeof SuiteSchema>

export const RepoProfileSchema = z.object({
  image: z.string(),
  /** first toolchain whose lockfile exists at the checked-out commit wins */
  toolchains: z.array(ToolchainSchema).min(1),
  build: z.string().optional(),
  lint: z.string().optional(),
  parser: ParserSchema,
  /** run in addition to the toolchain's test command when the factory verifies a commit */
  suites: z.array(SuiteSchema).default([]),
  /**
   * Commands that must exit 0 for a change to pass verification, beyond the tests: a type check,
   * a linter, a build. What the repository's CI would otherwise be the first to say. One that
   * already fails at the base commit is not held against the change.
   */
  checks: z.array(z.object({ name: z.string().min(1), run: z.string().min(1) })).default([]),
  /** regexes: which test files the test command actually runs (mining filter) */
  test_include: z.string().optional(),
  test_exclude: z.string().optional(),
  /**
   * regexes over changed paths: files of this repo that decide how a change is checked, on top
   * of the built-in list (test config, CI, package scripts). A change to one is flagged for review.
   */
  sensitive_paths: z.array(z.string()).default([]),
})

export type RepoProfile = z.infer<typeof RepoProfileSchema>
