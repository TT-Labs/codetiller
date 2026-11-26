import type { ModelGateway } from '../sandbox/gateway.js'
import type { Prices } from '../sandbox/prices.js'
import type { Sandbox } from '../sandbox/sandbox.js'
import type { GitWorkspaces } from '../workspace/git.js'
import type { Forge } from './forge.js'
import type { WorkItems } from './items.js'
import type { WorkItem } from './model.js'
import type { PreflightLimits } from './preflight.js'
import type { Project, Tracker } from './tracker.js'

export interface FactoryDeps {
  items: WorkItems
  sandbox: Sandbox
  workspaces: GitWorkspaces
  /** working dir holding datasets/, configs/, skills/, prompts/ */
  root: string
  /**
   * What ships with the factory: `configs/`, `prompts/factory/` and `skills/` are read from here when the
   * working dir has no file of that name, so an installation starts with an empty one and keeps
   * only what it changed.
   */
  defaults?: string
  /** model credentials; undefined = factory can't run agents. With a gateway they never enter an agent container */
  env?: Record<string, string>
  /** Agents reach the model through this and nothing else; without it they get `env` and the open network */
  gateway?: ModelGateway
  /** models a human may choose in place of a config's own (tiller.yaml `factory.models`) */
  models?: string[]
  /** model prices the gateway budgets with; default: the built-in list */
  prices?: Prices
  /** forge credentials stay here, on the host; undefined = no push / PR, human reviews locally */
  forge?: Forge
  /** intake: issues labelled for the factory in `projects` become IMPORTED work items */
  tracker?: Tracker
  projects?: Project[]
  /** read-only assessment before a task's first run; undefined / disabled = runs start directly */
  preflight?: PreflightLimits
  /** factory skills (`name@N`) every task gets, before the repository's and the config's */
  skills?: string[]
  /** second reader: a read-only agent reads every change that passed verification (advisory) */
  review?: { enabled: boolean }
  /**
   * When the repository's CI fails on a task's PR: `ask` (default) = shown, a human sends it to
   * the agent; `auto` = the factory does, at most `max_attempts` times per task; `off` = not read.
   */
  ci?: { fix: 'ask' | 'auto' | 'off'; max_attempts: number }
  maxConcurrent?: number
  log?: (m: string) => void
}

/** Result of one intake pass: new items, plus per-project errors (a bad token, a missing repo). */
export interface Intake {
  created: WorkItem[]
  errors: string[]
}

/** Result of one PR sync pass: item ids queued by a PR comment, closed with their PR, and errors. */
export interface PrSync {
  queued: string[]
  closed: string[]
  errors: string[]
}

export interface CreateWorkItem {
  title: string
  body: string
  repo: string
  dataset: string
  config: string
  /** git ref to branch from; default: remote default branch */
  ref?: string
  /** tracker the item came from (default: manual) */
  source?: string
  external_url?: string
  /** run this task on this model instead of the default */
  model?: string
}

/** Which model a task's next run uses and where that comes from. */
export interface ModelChoice {
  model: string
  /** `task` = chosen for this task; `default` = the factory's default model; `config` = the task's config file */
  source: 'task' | 'default' | 'config'
}

/** settings key: the model tasks run on unless one is chosen for the task */
