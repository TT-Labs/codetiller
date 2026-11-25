-- Benchmark tables first, factory tables (work_*) at the end.
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  dataset TEXT NOT NULL,
  repo TEXT NOT NULL,
  base_commit TEXT NOT NULL,
  split TEXT NOT NULL DEFAULT 'train',
  tags TEXT,
  difficulty TEXT,
  spec_hash TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS configs (
  id TEXT PRIMARY KEY,
  name TEXT,
  harness TEXT NOT NULL,
  harness_version TEXT,
  model TEXT NOT NULL,
  skills TEXT NOT NULL,
  prompt_template_hash TEXT NOT NULL,
  limits TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS benchmarks (
  id TEXT PRIMARY KEY,
  name TEXT,
  dataset TEXT NOT NULL,
  config_id TEXT NOT NULL REFERENCES configs(id),
  split TEXT,
  repeats INTEGER NOT NULL,
  started_at TEXT,
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  config_id TEXT NOT NULL REFERENCES configs(id),
  benchmark_id TEXT REFERENCES benchmarks(id),
  repeat INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  duration_s REAL,
  cost_usd REAL,
  cost_source TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  turns INTEGER,
  agent_exit TEXT,
  diff_files INTEGER,
  diff_lines INTEGER,
  outcome TEXT,
  score REAL
);

CREATE TABLE IF NOT EXISTS checks (
  run_id TEXT NOT NULL REFERENCES runs(id),
  name TEXT NOT NULL,
  passed INTEGER NOT NULL,
  total INTEGER,
  failed INTEGER,
  duration_s REAL,
  PRIMARY KEY (run_id, name)
);

CREATE TABLE IF NOT EXISTS reviews (
  run_id TEXT PRIMARY KEY REFERENCES runs(id),
  verdict TEXT NOT NULL,
  reason TEXT,
  reviewed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS failure_labels (
  run_id TEXT NOT NULL REFERENCES runs(id),
  cluster TEXT NOT NULL,
  summary TEXT,
  analysis_id TEXT NOT NULL
);

-- A work item outlives its runs (task != run); its workspace + agent session persist.
CREATE TABLE IF NOT EXISTS work_items (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  repo TEXT NOT NULL,
  dataset TEXT NOT NULL,
  config TEXT NOT NULL,
  base_commit TEXT NOT NULL,
  branch TEXT NOT NULL,
  state TEXT NOT NULL,
  session_id TEXT,
  source TEXT NOT NULL DEFAULT 'manual',
  external_url TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS work_runs (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES work_items(id),
  seq INTEGER NOT NULL,
  config_id TEXT NOT NULL REFERENCES configs(id),
  session_id TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  duration_s REAL,
  cost_usd REAL,
  turns INTEGER,
  agent_exit TEXT,
  signal TEXT,
  commit_sha TEXT,
  diff_files INTEGER,
  diff_lines INTEGER
);

CREATE TABLE IF NOT EXISTS work_events (
  id INTEGER PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES work_items(id),
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  kind TEXT NOT NULL,
  text TEXT,
  run_id TEXT
);

-- One draft PR per work item; later runs push to the same branch.
CREATE TABLE IF NOT EXISTS work_prs (
  item_id TEXT PRIMARY KEY REFERENCES work_items(id),
  number INTEGER NOT NULL,
  url TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- PR comments already handed to the agent as a message (each one exactly once).
CREATE TABLE IF NOT EXISTS work_feedback (
  item_id TEXT NOT NULL REFERENCES work_items(id),
  source TEXT NOT NULL,
  external_id INTEGER NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (item_id, source, external_id)
);

-- Read-only preflight of a work item before its first write run (one per item).
-- `report` = the agent's estimates as JSON; `verdict` = the factory's gate over them.
CREATE TABLE IF NOT EXISTS work_preflights (
  item_id TEXT PRIMARY KEY REFERENCES work_items(id),
  run_id TEXT,
  verdict TEXT NOT NULL,
  report TEXT,
  cost_usd REAL,
  turns INTEGER,
  duration_s REAL,
  created_at TEXT NOT NULL
);

-- How a task's open PR stands against the default branch, as seen at the last sync:
-- `current`, `behind` (the default branch moved on) or `conflict` (it no longer merges).
CREATE TABLE IF NOT EXISTS work_pr_state (
  item_id TEXT PRIMARY KEY REFERENCES work_items(id),
  sync TEXT NOT NULL,
  checked_at TEXT NOT NULL
);

-- Factory settings a human changes from the UI (key → value), e.g. `default_model`.
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- The model a human chose for a task in place of the default; applies from its next run.
CREATE TABLE IF NOT EXISTS work_models (
  item_id TEXT PRIMARY KEY REFERENCES work_items(id),
  model TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- A task that waits for another: a part of a split starts only when the part before it is
-- merged (or cancelled). `parent_id` = the task that was split; `position` of `total` parts.
CREATE TABLE IF NOT EXISTS work_order (
  item_id TEXT PRIMARY KEY REFERENCES work_items(id),
  after_id TEXT REFERENCES work_items(id),
  parent_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  total INTEGER NOT NULL
);

-- Tasks run to try the factory itself, not to deliver work: left out of the metrics.
CREATE TABLE IF NOT EXISTS work_experiments (
  item_id TEXT PRIMARY KEY REFERENCES work_items(id),
  at TEXT NOT NULL
);

-- Second reader: a read-only agent reads a change that passed verification, before it is pushed.
-- One row per reading; `head` = the commit read. Advisory: `verdict` is ok, concerns or error.
CREATE TABLE IF NOT EXISTS work_reviews (
  run_id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES work_items(id),
  head TEXT NOT NULL,
  verdict TEXT NOT NULL,
  report TEXT,
  cost_usd REAL,
  turns INTEGER,
  duration_s REAL,
  created_at TEXT NOT NULL
);

-- Repositories the factory works on, added by onboarding (`tiller repo add`). `profile` = the
-- sandbox profile proposed then, used until the repository carries its own
-- (.factory/factory.yaml → sandbox); `config` = agent config of its tasks; `label` = issues with
-- it are imported; `checked` = result of the last baseline check.
CREATE TABLE IF NOT EXISTS repos (
  repo TEXT PRIMARY KEY,
  profile TEXT,
  config TEXT NOT NULL,
  label TEXT,
  checked TEXT,
  added_at TEXT NOT NULL
);

-- The repository's own CI on a task's pull request, as seen at the last sync. `head` = the
-- commit it speaks about; `failing` = JSON list of failed checks; `sent_head` = the commit whose
-- failure was last handed to the agent (never twice for the same commit); `attempts` = how often.
CREATE TABLE IF NOT EXISTS work_ci (
  item_id TEXT PRIMARY KEY REFERENCES work_items(id),
  head TEXT NOT NULL,
  state TEXT NOT NULL,
  failing TEXT NOT NULL,
  total INTEGER NOT NULL,
  sent_head TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  checked_at TEXT NOT NULL
);
