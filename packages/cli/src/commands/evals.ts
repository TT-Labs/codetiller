import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import {
  type AuditRun,
  auditTask,
  collectEvidence,
  compareRuns,
  configHash,
  type Draft,
  detectableDelta,
  estimateTokens,
  GitWorkspaces,
  gateVerdict,
  generateSkill,
  git,
  IMPROVE_MODEL,
  Improver,
  inferFailToPass,
  leakWarnings,
  loadConfig,
  loadLabels,
  loadRunRows,
  loadSkill,
  loadTask,
  mineCandidates,
  noiseSummary,
  patchFiles,
  RepoProfileSchema,
  renderEvidence,
  repeatsFor,
  runBenchmark,
  runTask,
  Store,
  sanitizeSkill,
  sourceFiles,
  splitTasks,
  taskNoise,
  validateTask,
} from '@codetiller/core'
import type { Command } from 'commander'
import { parse, stringify } from 'yaml'

import { dockerSandbox, loadPrices, loadProfile, modelGateway, own, SKILL_DIRS } from '../env.js'

async function loadComparison(store: Store, a: string, b: string, split: string) {
  const find = (name: string) => {
    const bm = store.findBenchmark(name)
    const rec = bm && store.getBenchmark(bm.id)
    if (!rec) throw new Error(`benchmark not found: ${name}`)
    return rec
  }
  const A = find(a)
  const B = find(b)
  if (A.dataset !== B.dataset) throw new Error('benchmarks use different datasets')
  const dir = resolve('datasets', A.dataset)
  let ids: Set<string> | undefined
  if (split !== 'all') {
    const parts = parse(await readFile(resolve(dir, 'split.yaml'), 'utf8')) as Record<
      string,
      string[]
    >
    ids = new Set(parts[split] ?? [])
  }
  const rows = async (id: string) =>
    (await loadRunRows(store, store.runsOf(id))).filter((r) => !ids || ids.has(r.task_id))
  const ra = await rows(A.id)
  const rb = await rows(B.id)
  const { underspecified } = await loadLabels(dir)
  const all = compareRuns(ra, rb)
  const solvable = (r: { task_id: string }) => !(r.task_id in underspecified)
  const rest = compareRuns(ra.filter(solvable), rb.filter(solvable))
  return { A, B, all, sub: rest.tasks < all.tasks ? rest : null }
}

/** `tiller dataset | skill | config | run | benchmark | compare | gate | noise | improve`: benchmarks and the eval gate. */
export function register(program: Command) {
  const dataset = program.command('dataset').description('benchmark datasets')
  dataset
    .command('mine <dir>')
    .description('propose task drafts from merged PRs that close an issue and change tests')
    .requiredOption('--repo <repo>')
    .option('--since <date>', 'merged on/after', '2026-07-01')
    .option('--limit <n>', 'max PRs to scan', '300')
    .action(async (dir: string, opts: { repo: string; since: string; limit: string }) => {
      const profile = await loadProfile(dir)
      const inc = profile.test_include ? new RegExp(profile.test_include) : undefined
      const exc = profile.test_exclude ? new RegExp(profile.test_exclude) : undefined
      const existing = new Set(
        (await readdir(resolve(dir, 'tasks')).catch(() => [])).map((f) => f.replace(/\.yaml$/, '')),
      )
      const drafts = await mineCandidates({
        repo: opts.repo,
        since: opts.since,
        limit: Number(opts.limit),
        testFilter: (p) => (!inc || inc.test(p)) && !exc?.test(p),
        log: console.log,
      })
      await mkdir(resolve(dir, 'drafts'), { recursive: true })
      let n = 0
      for (const d of drafts) {
        if (existing.has(d.id)) continue
        await writeFile(resolve(dir, 'drafts', `${d.id}.yaml`), stringify(d, { lineWidth: 0 }))
        n++
      }
      console.log(`${n} new drafts in ${resolve(dir, 'drafts')}`)
    })
  dataset
    .command('infer <dir>')
    .description(
      'drafts → tasks: run hidden tests at base/fix, derive fail_to_pass, keep valid ones',
    )
    .option('--repeats <n>', 'determinism repeats', '2')
    .option('--only <id>')
    .action(async (dir: string, opts: { repeats: string; only?: string }) => {
      const profile = await loadProfile(dir)
      const deps = { sandbox: dockerSandbox(), workspaces: new GitWorkspaces(resolve('.cache')) }
      const files = (await readdir(resolve(dir, 'drafts'))).filter((f) => f.endsWith('.yaml'))
      const rejected: Record<string, string> = {}
      const done = new Set(
        (await readdir(resolve(dir, 'tasks'))).map((f) => f.replace(/\.yaml$/, '')),
      )
      for (const f of files) {
        const draft = parse(await readFile(resolve(dir, 'drafts', f), 'utf8')) as Draft
        if (opts.only && draft.id !== opts.only) continue
        if (!opts.only && done.has(draft.id)) continue
        console.log(`infer ${draft.id}`)
        const r = await inferFailToPass(
          draft,
          profile,
          deps,
          Number(opts.repeats),
          console.log,
        ).catch((e: Error) => ({
          ok: false,
          reason: `error: ${e.message.split('\n')[0]}`,
          fail_to_pass: [],
        }))
        if (!r.ok) {
          console.log(`  REJECT ${r.reason}`)
          rejected[draft.id] = r.reason ?? ''
          continue
        }
        const { flags, source_files: _s, pr, ...rest } = draft
        const task = {
          ...rest,
          fail_to_pass: r.fail_to_pass,
          pass_to_pass: 'suite',
          tags: ['bugfix'],
        }
        const header = [`# mined from PR #${pr}`, ...flags.map((x) => `# REVIEW: ${x}`)].join('\n')
        await writeFile(
          resolve(dir, 'tasks', `${draft.id}.yaml`),
          `${header}\n${stringify(task, { lineWidth: 0 })}`,
        )
        console.log(
          `  TASK ${r.fail_to_pass.length} fail_to_pass${flags.length ? ' (needs review)' : ''}`,
        )
      }
      await writeFile(
        resolve(dir, 'drafts', 'rejected.json'),
        `${JSON.stringify(rejected, null, 2)}\n`,
      )
    })
  dataset
    .command('validate <dir>')
    .description('oracle check per task: hidden tests fail at base, pass at fix')
    .option('--task <id>', 'only this task')
    .option('--repeats <n>', 'determinism repeats', '2')
    .action(async (dir: string, opts: { task?: string; repeats: string }) => {
      const profile = RepoProfileSchema.parse(
        parse(await readFile(resolve(dir, 'profile.yaml'), 'utf8')),
      )
      const files = (await readdir(resolve(dir, 'tasks'))).filter((f) => f.endsWith('.yaml'))
      const deps = {
        sandbox: dockerSandbox(),
        workspaces: new GitWorkspaces(resolve('.cache')),
      }
      const results = []
      for (const f of files) {
        const task = await loadTask(resolve(dir, 'tasks', f))
        if (opts.task && task.id !== opts.task) continue
        console.log(`validating ${task.id}`)
        const r = await validateTask(task, profile, deps, Number(opts.repeats), console.log)
        console.log(`${r.valid ? 'VALID  ' : 'INVALID'} ${task.id}`)
        for (const reason of r.reasons) console.log(`  - ${reason}`)
        results.push(r)
      }
      await writeFile(resolve(dir, 'validation.json'), `${JSON.stringify(results, null, 2)}\n`)
      if (results.some((r) => !r.valid)) process.exitCode = 1
    })
  dataset
    .command('split <dir>')
    .description('seeded train/holdout split → <dir>/split.yaml')
    .option('--holdout <ratio>', '', '0.4')
    .option('--seed <n>', '', '1')
    .action(async (dir: string, opts: { holdout: string; seed: string }) => {
      const ids = (await readdir(resolve(dir, 'tasks')))
        .filter((f) => f.endsWith('.yaml'))
        .map((f) => f.replace(/\.yaml$/, ''))
      const s = splitTasks(ids, Number(opts.holdout), Number(opts.seed))
      const header = `# tiller dataset split --holdout ${opts.holdout} --seed ${opts.seed}\n`
      await writeFile(resolve(dir, 'split.yaml'), header + stringify(s))
      console.log(
        `train ${s.train.length} · holdout ${s.holdout.length} → ${resolve(dir, 'split.yaml')}`,
      )
    })
  dataset
    .command('audit <dir>')
    .description(
      'curation evidence per task from stored runs (no agent runs): what each task can tell',
    )
    .action(async (dir: string) => {
      const name = basename(resolve(dir))
      const files = (await readdir(resolve(dir, 'tasks'))).filter((f) => f.endsWith('.yaml')).sort()
      const tasks = await Promise.all(files.map((f) => loadTask(resolve(dir, 'tasks', f))))
      const labels = await loadLabels(resolve(dir))
      const cache = new GitWorkspaces(resolve('.cache'))
      const store = new Store(resolve('tiller.db'), resolve('artifacts'))
      try {
        const stored = store.datasetRuns(name)
        const pct = (x: number | null) => (x === null ? '—' : `${Math.round(x * 100)}%`)
        console.log(
          `${'task'.padEnd(12)}${'resolution'.padEnd(16)}${'solved'.padEnd(8)}${'by model'.padEnd(34)}${'f2p'.padEnd(6)}${'located'.padEnd(9)}fix files (untouched by any run)`,
        )
        const counts: Record<string, number> = {}
        for (const task of tasks) {
          const mine = stored.filter((r) => r.task_id === task.id)
          const runs: AuditRun[] = await Promise.all(
            mine.map(async (r) => ({
              outcome: r.outcome,
              f2p:
                r.f2p_total === null
                  ? undefined
                  : { total: r.f2p_total, failed: r.f2p_failed ?? 0 },
              files: patchFiles(
                await readFile(resolve('artifacts', r.id, 'diff.patch'), 'utf8').catch(() => ''),
              ),
            })),
          )
          const changed = await git(
            cache.repoCache(task.repo),
            'diff',
            '--name-only',
            task.base_commit,
            task.fix_commit,
          ).catch(() => '')
          const fix = sourceFiles(changed.split('\n').filter(Boolean)).filter(
            (f) => !task.hidden_tests.includes(f),
          )
          const a = auditTask(task.id, runs, fix)
          counts[a.resolution] = (counts[a.resolution] ?? 0) + 1
          const models = [...new Set(mine.map((r) => r.model))]
            .map((m) => {
              const rs = mine.filter((r) => r.model === m)
              return `${m.replace(/^claude-/, '')} ${rs.filter((r) => r.outcome === 'success').length}/${rs.length}`
            })
            .join(' · ')
          console.log(
            `${a.id.padEnd(12)}${a.resolution.padEnd(16)}${`${a.successes}/${a.runs}`.padEnd(8)}${models.padEnd(34)}${pct(a.partial).padEnd(6)}${pct(a.located).padEnd(9)}${a.fixFiles.length} (${a.untouched.length})${labels.underspecified[a.id] ? '  [underspecified]' : ''}`,
          )
        }
        console.log(
          `\n${tasks.length} tasks · ${Object.entries(counts)
            .map(([k, v]) => `${k} ${v}`)
            .join(' · ')} · labelled underspecified ${Object.keys(labels.underspecified).length}`,
        )
        console.log(
          'f2p = median share of fail_to_pass cases passing in unsuccessful runs · located = runs touching every fix file',
        )
      } finally {
        store.close()
      }
    })

  program
    .command('skill')
    .command('generate')
    .description('agent writes a one-off onboarding skill from the repo at <commit>')
    .requiredOption('--dataset <name>')
    .requiredOption('--at <commit>', 'older than every base_commit in the dataset')
    .requiredOption('--name <name>', 'skill name, e.g. hono-onboarding')
    .option('--config <name>', 'harness/model used to generate', 'default')
    .option('--prompt <file>', '', 'prompts/onboarding.md')
    .action(
      async (opts: {
        dataset: string
        at: string
        name: string
        config: string
        prompt: string
      }) => {
        const key = process.env.ANTHROPIC_API_KEY
        if (!key) throw new Error('ANTHROPIC_API_KEY not set (.env)')
        const dir = resolve('datasets', opts.dataset)
        const profile = await loadProfile(dir)
        const files = (await readdir(resolve(dir, 'tasks'))).filter((f) => f.endsWith('.yaml'))
        const tasks = await Promise.all(files.map((f) => loadTask(resolve(dir, 'tasks', f))))
        const repo = tasks[0]?.repo
        if (!repo) throw new Error('dataset has no tasks')
        const ws = new GitWorkspaces(resolve('.cache'))
        const cache = await ws.ensureRepo(repo, [opts.at])
        // leakage guard: generation commit must be an ancestor of every task's base
        for (const t of tasks) {
          const ok = await git(cache, 'merge-base', '--is-ancestor', opts.at, t.base_commit).then(
            () => true,
            () => false,
          )
          if (!ok) throw new Error(`${opts.at} is not older than base of ${t.id}`)
        }
        const r = await generateSkill(
          {
            repo,
            commit: (await git(cache, 'rev-parse', opts.at)).trim(),
            name: opts.name,
            description: `${repo} conventions, structure, testing (generated, no hand edits)`,
            prompt: await readFile(own(opts.prompt), 'utf8'),
            profile,
            config: await loadConfig(own('configs', `${opts.config}.yaml`)),
            skillsDir: resolve('skills'),
            artifactsDir: resolve('artifacts'),
          },
          {
            sandbox: dockerSandbox(),
            workspaces: ws,
            env: { ANTHROPIC_API_KEY: key },
            gateway: modelGateway(key),
            prices: loadPrices(),
            log: console.log,
          },
        )
        console.log(
          `${r.path}  v${r.version} · ~${r.tokens} tokens · $${r.cost?.toFixed(2) ?? '?'}`,
        )
      },
    )

  program
    .command('config')
    .command('add <file>')
    .description('resolve config, print content hash')
    .action(async (file: string) => {
      const path = resolve(file)
      const config = await loadConfig(path)
      const prompt = await readFile(own(config.prompt_template), 'utf8')
      console.log(`${configHash(config, prompt)}  ${config.name}`)
    })

  program
    .command('run')
    .description('one task, one config: agent in sandbox → verify → store')
    .requiredOption('--task <id>')
    .requiredOption('--config <name>')
    .requiredOption('--dataset <name>', 'dataset dir under datasets/')
    .option('--keep-workspace')
    .action(
      async (opts: { task: string; config: string; dataset: string; keepWorkspace?: boolean }) => {
        const key = process.env.ANTHROPIC_API_KEY
        if (!key) throw new Error('ANTHROPIC_API_KEY not set (.env)')
        const dir = resolve('datasets', opts.dataset)
        const profile = RepoProfileSchema.parse(
          parse(await readFile(resolve(dir, 'profile.yaml'), 'utf8')),
        )
        const task = await loadTask(resolve(dir, 'tasks', `${opts.task}.yaml`))
        const config = await loadConfig(own('configs', `${opts.config}.yaml`))
        const skills = await Promise.all(config.skills.map((s) => loadSkill(SKILL_DIRS, s)))
        const promptTemplate = await readFile(own(config.prompt_template), 'utf8')
        const store = new Store(resolve('tiller.db'), resolve('artifacts'))
        try {
          const {
            run,
            checks,
            dir: artifacts,
          } = await runTask(
            {
              task,
              dataset: opts.dataset,
              profile,
              config,
              promptTemplate,
              skills,
              keepWorkspace: opts.keepWorkspace,
            },
            {
              sandbox: dockerSandbox(),
              workspaces: new GitWorkspaces(resolve('.cache')),
              store,
              env: { ANTHROPIC_API_KEY: key },
              gateway: modelGateway(key),
              prices: loadPrices(),
              log: console.log,
            },
          )
          console.log(`\n${run.outcome.toUpperCase()}  ${run.id}`)
          for (const c of checks) {
            console.log(
              `  ${c.passed ? '✓' : '✗'} ${c.name} ${(c.total ?? 0) - (c.failed ?? 0)}/${c.total}`,
            )
          }
          console.log(
            `  cost $${run.cost_usd?.toFixed(2) ?? '?'} · ${run.turns ?? '?'} turns · ${run.duration_s.toFixed(0)}s · diff ${run.diff_files} files/${run.diff_lines} lines`,
          )
          console.log(`  artifacts ${artifacts}`)
        } finally {
          store.close()
        }
      },
    )

  program
    .command('benchmark')
    .description('dataset × config × repeats, parallel, hard budget cap')
    .requiredOption('--dataset <name>')
    .requiredOption('--config <name>')
    .option('--split <split>', 'train | holdout | all (needs datasets/<ds>/split.yaml)', 'all')
    .option('--repeats <n>', '', '1')
    .option('--concurrency <n>', 'parallel runs (each 2 CPU / 4 GB)', '3')
    .option('--budget <usd>', 'stop starting runs once spent', '10')
    .option('--name <name>')
    .option('--only <ids>', 'comma-separated task ids')
    .action(
      async (opts: {
        dataset: string
        config: string
        split: string
        repeats: string
        concurrency: string
        budget: string
        name?: string
        only?: string
      }) => {
        const key = process.env.ANTHROPIC_API_KEY
        if (!key) throw new Error('ANTHROPIC_API_KEY not set (.env)')
        const dir = resolve('datasets', opts.dataset)
        const profile = await loadProfile(dir)
        const files = (await readdir(resolve(dir, 'tasks')))
          .filter((f) => f.endsWith('.yaml'))
          .sort()
        let tasks = await Promise.all(files.map((f) => loadTask(resolve(dir, 'tasks', f))))
        if (opts.split !== 'all') {
          const split = parse(await readFile(resolve(dir, 'split.yaml'), 'utf8')) as Record<
            string,
            string[]
          >
          const ids = new Set(split[opts.split] ?? [])
          tasks = tasks.filter((t) => ids.has(t.id))
        }
        if (opts.only) {
          const ids = new Set(opts.only.split(','))
          tasks = tasks.filter((t) => ids.has(t.id))
        }
        const config = await loadConfig(own('configs', `${opts.config}.yaml`))
        const promptTemplate = await readFile(own(config.prompt_template), 'utf8')
        const skills = await Promise.all(config.skills.map((s) => loadSkill(SKILL_DIRS, s)))
        const name = opts.name ?? config.name
        const repeats = Number(opts.repeats)
        console.log(`TILLER BENCHMARK  ${name}`)
        console.log(
          `config     ${config.name} (${config.harness}, ${config.model}, skills: ${config.skills.join(', ') || '—'})`,
        )
        console.log(
          `dataset    ${opts.dataset} / ${opts.split} · ${tasks.length} tasks × ${repeats} repeats = ${tasks.length * repeats} runs · budget $${opts.budget}\n`,
        )
        const store = new Store(resolve('tiller.db'), resolve('artifacts'))
        try {
          const s = await runBenchmark(
            {
              name,
              dataset: opts.dataset,
              split: opts.split,
              tasks,
              profile,
              config,
              promptTemplate,
              repeats,
              concurrency: Number(opts.concurrency),
              budgetUsd: Number(opts.budget),
              skills,
            },
            {
              sandbox: dockerSandbox(),
              workspaces: new GitWorkspaces(resolve('.cache')),
              store,
              env: { ANTHROPIC_API_KEY: key },
              gateway: modelGateway(key),
              prices: loadPrices(),
              log: console.log,
            },
          )
          const pct = (x: number) => `${(x * 100).toFixed(1)}%`
          const dur = (x: number) => `${Math.floor(x / 60)}m ${Math.round(x % 60)}s`
          console.log(`\nbenchmark        ${s.id}`)
          console.log(`success          ${s.successes}/${s.runs}   ${pct(s.successRate)}`)
          console.log(`cost total       $${s.totalCost.toFixed(2)}`)
          console.log(`cost/run         $${s.costPerRun.toFixed(2)}`)
          console.log(
            `cost/success     ${s.costPerSuccess === null ? '—' : `$${s.costPerSuccess.toFixed(2)}`}`,
          )
          console.log(`median duration  ${dur(s.medianDuration)}`)
          console.log(`timeouts/errors  ${s.timeouts} / ${s.errors}`)
          if (s.skippedForBudget) console.log(`skipped (budget) ${s.skippedForBudget}`)
        } finally {
          store.close()
        }
      },
    )

  program
    .command('compare <a> <b>')
    .description(
      'paired per-task comparison of two benchmarks (name = latest with that name, or id)',
    )
    .option('--split <split>', 'train | holdout | all', 'all')
    .action(async (a: string, b: string, opts: { split: string }) => {
      const store = new Store(resolve('tiller.db'), resolve('artifacts'))
      try {
        const { A, B, all, sub } = await loadComparison(store, a, b, opts.split)

        const pct = (x: number) => `${(x * 100).toFixed(1)}%`
        const pp = (x: number) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}`
        const usd = (x: number | null) => (x === null ? '—' : `$${x.toFixed(3)}`)
        const num = (x: number) =>
          Math.abs(x) >= 100 ? x.toFixed(0) : Math.abs(x) >= 10 ? x.toFixed(1) : x.toFixed(3)
        const signed = (x: number) => `${x >= 0 ? '+' : ''}${num(x)}`
        const width = Math.max(14, a.length + 2, b.length + 2)
        const col = (s: string, w = width) => s.padEnd(w)
        // a delta counts when it holds across tasks (CI excludes 0) and exceeds what a rerun moves
        const real = (d: { mean: number; lo: number; hi: number }, noise: number | null) =>
          (d.lo > 0 || d.hi < 0) && noise !== null && Math.abs(d.mean) > noise

        const print = (c: ReturnType<typeof compareRuns>, withMetrics: boolean) => {
          console.log(
            `${col('', 18)}${col(a)}${col(b)}${col('Δ (95% CI over tasks)', 30)}rerun noise`,
          )
          console.log(
            `${col('success', 18)}${col(pct(c.a.successRate))}${col(pct(c.b.successRate))}${col(`${pp(c.delta.mean)} pp (${pp(c.delta.lo)}, ${pp(c.delta.hi)})`, 30)}${c.noise === null ? 'n/a' : `±${(c.noise * 100).toFixed(1)} pp`}${real(c.delta, c.noise) ? '  *' : ''}`,
          )
          console.log(
            `${col('cost/success', 18)}${col(usd(c.a.costPerSuccess))}${col(usd(c.b.costPerSuccess))}${c.costPerSuccessDelta === null ? '—' : `${c.costPerSuccessDelta >= 0 ? '+' : ''}${(c.costPerSuccessDelta * 100).toFixed(0)}%`}`,
          )
          console.log(
            `${col('median dur.', 18)}${col(`${c.a.medianDuration.toFixed(0)}s`)}${col(`${c.b.medianDuration.toFixed(0)}s`)}`,
          )
          console.log(`${col('runs', 18)}${col(String(c.a.runs))}${col(String(c.b.runs))}`)
          if (!withMetrics) return
          console.log(
            `\n${col('per run', 18)}${col(a)}${col(b)}${col('Δ (95% CI over tasks)', 30)}rerun noise`,
          )
          for (const m of c.metrics) {
            console.log(
              `${col(m.name, 18)}${col(num(m.a))}${col(num(m.b))}${col(`${signed(m.delta.mean)} (${signed(m.delta.lo)}, ${signed(m.delta.hi)})`, 30)}${m.noise === null ? 'n/a' : `±${num(m.noise)}`}${real(m.delta, m.noise) ? '  *' : ''}`,
            )
          }
        }

        console.log(`split ${opts.split} · ${all.tasks} paired tasks · ${A.id} vs ${B.id}\n`)
        print(all, true)
        if (sub) {
          console.log(
            `\nsolvable from the issue · ${sub.tasks} tasks (${all.tasks - sub.tasks} labelled underspecified left out)\n`,
          )
          print(sub, false)
        }
        console.log('\n* = holds across tasks (CI excludes 0) and exceeds rerun noise')
        console.log(
          `tasks improved   ${all.flips.failToSuccess} · worse ${all.flips.successToFail}`,
        )
        console.log(
          `recommendation   ${all.recommendation === 'PROMOTE' ? `PROMOTE ${b}` : `KEEP ${a} (don't promote ${b})`}`,
        )
        console.log(`                 ${all.reason}`)
      } finally {
        store.close()
      }
    })

  program
    .command('gate <baseline> <candidate>')
    .description(
      'eval gate for a skill / config change: evidence for the PR as markdown; exit 2 when the rule says KEEP',
    )
    .option('--split <split>', 'train | holdout | all', 'all')
    .option('--out <file>', 'write the evidence here instead of stdout')
    .option(
      '--reference <benchmark>',
      'the config from before any promotion: the candidate must not be below it by more than rerun noise either',
    )
    .action(
      async (a: string, b: string, opts: { split: string; out?: string; reference?: string }) => {
        const store = new Store(resolve('tiller.db'), resolve('artifacts'))
        try {
          const { A, B, all, sub } = await loadComparison(store, a, b, opts.split)
          const side = (bm: typeof A) => ({
            id: bm.id,
            config: bm.config_name,
            model: bm.model,
            skills: bm.skills,
          })
          // promotions add up: against a fixed reference a chain of them cannot lose what none saw
          const ref = opts.reference
            ? await loadComparison(store, opts.reference, b, opts.split)
            : undefined
          const input = {
            dataset: A.dataset,
            split: opts.split,
            a: side(A),
            b: side(B),
            comparison: all,
            solvable: sub,
            reference: ref ? { side: side(ref.A), comparison: ref.all } : undefined,
          }
          const evidence = renderEvidence(input)
          const verdict = gateVerdict(input)
          if (opts.out) {
            await writeFile(resolve(opts.out), `${evidence}\n`)
            console.log(`${verdict.verdict}: ${verdict.reason}\nevidence → ${resolve(opts.out)}`)
          } else console.log(evidence)
          if (verdict.verdict !== 'PROMOTE') process.exitCode = 2
        } finally {
          store.close()
        }
      },
    )

  program
    .command('noise')
    .description(
      'rerun noise of a dataset from stored benchmarks: what delta a comparison can detect',
    )
    .requiredOption('--dataset <name>')
    .option('--metric <name>', 'success, or a per-run metric of `tiller compare`', 'success')
    .option('--delta <x>', 'effect to plan for, in metric units (0.05 = 5 pp)', '0.05')
    .action(async (opts: { dataset: string; metric: string; delta: string }) => {
      const store = new Store(resolve('tiller.db'), resolve('artifacts'))
      try {
        const benchmarks = store.datasetBenchmarks(opts.dataset)
        const unit = (x: number) =>
          opts.metric === 'success' || opts.metric === 'f2p_share'
            ? `${(x * 100).toFixed(1)} pp`
            : x.toPrecision(3)
        const perTask = new Map<string, number[]>()
        const costs: number[] = []
        console.log(
          `${'benchmark'.padEnd(32)}${'tasks'.padEnd(7)}${'runs'.padEnd(6)}${'mean'.padEnd(11)}${'unstable'.padEnd(10)}${'±95% noise'.padEnd(12)}repeat-to-repeat deltas (same config)`,
        )
        for (const bm of benchmarks) {
          const records = store.runsOf(bm.id)
          const rows = await loadRunRows(store, records)
          const values = rows.flatMap((r, i) => {
            const value =
              opts.metric === 'success'
                ? r.outcome === 'success'
                  ? 1
                  : 0
                : r.metrics?.[opts.metric]
            return value == null
              ? []
              : [{ task_id: r.task_id, value, repeat: records[i]?.repeat ?? 0 }]
          })
          costs.push(...records.flatMap((r) => (r.cost_usd === null ? [] : [r.cost_usd])))
          const n = noiseSummary(values)
          if (n.tasks === 0) continue
          for (const [task, t] of taskNoise(values))
            if (t.variance !== null) perTask.set(task, [...(perTask.get(task) ?? []), t.variance])
          // A/A: the same config against itself, one repeat per side
          const repeats = [...new Set(values.map((v) => v.repeat))].sort()
          const mean = (rep: number) => {
            const xs = values.filter((v) => v.repeat === rep)
            return xs.reduce((s, v) => s + v.value, 0) / (xs.length || 1)
          }
          const aa = repeats
            .flatMap((x, i) => repeats.slice(i + 1).map((y) => mean(y) - mean(x)))
            .map((d) => `${d >= 0 ? '+' : ''}${unit(d)}`)
          console.log(
            `${bm.id.padEnd(32)}${String(n.tasks).padEnd(7)}${String(n.runs).padEnd(6)}${unit(n.mean).replace(' pp', '%').padEnd(11)}${String(n.unstable).padEnd(10)}${`±${unit(1.96 * n.se)}`.padEnd(12)}${aa.join(', ')}`,
          )
        }
        const tasks = perTask.size
        if (tasks === 0) {
          console.log('\nno benchmark with repeats: run one with --repeats 2 or more')
          return
        }
        const variance =
          [...perTask.values()].reduce((s, v) => s + v.reduce((x, y) => x + y, 0) / v.length, 0) /
          tasks
        // median: one benchmark on a pricier model must not set the planning price
        const perRun = costs.sort((x, y) => x - y)[Math.floor(costs.length / 2)] ?? 0
        console.log(
          `\n${opts.dataset}: ${tasks} tasks with repeats · mean per-task variance of one run ${variance.toPrecision(3)} · median $${perRun.toFixed(3)}/run`,
        )
        console.log(
          `\nsmallest delta a paired comparison of two configs detects (5 % two-sided, 80 % power)`,
        )
        console.log(`${'repeats'.padEnd(9)}${'detectable'.padEnd(13)}${'runs'.padEnd(7)}cost`)
        for (const r of [1, 2, 3, 5, 10, 20]) {
          console.log(
            `${String(r).padEnd(9)}${unit(detectableDelta(variance, tasks, r)).padEnd(13)}${String(2 * r * tasks).padEnd(7)}$${(2 * r * tasks * perRun).toFixed(0)}`,
          )
        }
        const need = repeatsFor(variance, tasks, Number(opts.delta))
        console.log(
          `\nto detect ${unit(Number(opts.delta))}: ${need} repeats per config = ${2 * need * tasks} runs ≈ $${(2 * need * tasks * perRun).toFixed(0)}`,
        )
        console.log(
          '(rerun noise only, task set held fixed; generalising to other tasks is the CI over tasks)',
        )
      } finally {
        store.close()
      }
    })
  program
    .command('improve')
    .description(
      'failed train runs → labelled clusters → proposed learned skill (human/agent review before use)',
    )
    .requiredOption('--benchmark <name>')
    .requiredOption('--dataset <name>')
    .requiredOption('--skill <name>', 'learned skill to write, e.g. hono-learned')
    .option('--split <split>', 'learn only from this split', 'train')
    .option('--max-words <n>', '', '500')
    .action(
      async (opts: {
        benchmark: string
        dataset: string
        skill: string
        split: string
        maxWords: string
      }) => {
        if (opts.split === 'holdout') throw new Error('never learn from holdout')
        const dir = resolve('datasets', opts.dataset)
        const profile = await loadProfile(dir)
        const split = parse(await readFile(resolve(dir, 'split.yaml'), 'utf8')) as Record<
          string,
          string[]
        >
        const trainIds = new Set(split[opts.split] ?? [])
        const store = new Store(resolve('tiller.db'), resolve('artifacts'))
        try {
          const bm = store.findBenchmark(opts.benchmark)
          if (!bm) throw new Error(`benchmark not found: ${opts.benchmark}`)
          const skillRefs = store.benchmarkSkills(bm.id)
          const skills = await Promise.all(skillRefs.map((s) => loadSkill(SKILL_DIRS, s)))
          const current = skills.map((s) => `## Skill: ${s.name}\n${s.body}`).join('\n\n')
          const failed = store.failedRuns(bm.id).filter((r) => trainIds.has(r.task_id))
          console.log(
            `${failed.length} failed ${opts.split} runs in ${bm.id} (skills: ${skillRefs.join(', ') || '—'})`,
          )
          if (failed.length === 0) return
          const deps = {
            sandbox: dockerSandbox(),
            workspaces: new GitWorkspaces(resolve('.cache')),
            profile,
            artifactsDir: resolve('artifacts'),
          }
          const tasks = new Map<string, Awaited<ReturnType<typeof loadTask>>>()
          for (const r of failed) {
            if (!tasks.has(r.task_id))
              tasks.set(r.task_id, await loadTask(resolve(dir, 'tasks', `${r.task_id}.yaml`)))
          }
          const improver = new Improver()
          const evidence = []
          const labels = []
          for (const r of failed) {
            const task = tasks.get(r.task_id)
            if (!task) continue
            const e = await collectEvidence({ id: r.id, task }, deps)
            evidence.push(e)
            const l = await improver.label(e, current)
            labels.push(l)
            console.log(
              `  ${r.task_id}  ${l.cluster}  (context helps: ${l.would_context_have_helped})`,
            )
          }
          const proposal = await improver.propose(labels, current, {
            repo: tasks.values().next().value?.repo ?? opts.dataset,
            maxWords: Number(opts.maxWords),
          })
          // semantic leak guard over every train task that failed (one entry per task)
          const byTask = new Map(evidence.map((e) => [e.task_id, e]))
          const sanitized = await sanitizeSkill(improver, proposal.skill_markdown, [
            ...byTask.values(),
          ])
          console.log(`  sanitize: removed ${sanitized.removed.length} task-specific passages`)
          const warnings = leakWarnings(sanitized.skill_markdown, evidence)
          const skillDir = resolve('skills', opts.skill)
          await mkdir(skillDir, { recursive: true })
          const versions = (await readdir(skillDir)).map((f) =>
            Number(/^v(\d+)\.md$/.exec(f)?.[1] ?? 0),
          )
          const version = Math.max(0, ...versions) + 1
          const outDir = resolve('artifacts', `improve-${opts.skill}-v${version}`)
          await mkdir(outDir, { recursive: true })
          const meta = {
            name: opts.skill,
            version,
            description: `learned from failures of ${bm.id} (${opts.split} split)`,
            learned_from: {
              benchmark: bm.id,
              split: opts.split,
              runs: failed.length,
              model: IMPROVE_MODEL,
              base_skills: skillRefs,
            },
          }
          await writeFile(
            resolve(skillDir, `v${version}.md`),
            `---\n${stringify(meta)}---\n\n${sanitized.skill_markdown.trim()}\n`,
          )
          await writeFile(resolve(outDir, 'unsanitized.md'), `${proposal.skill_markdown.trim()}\n`)
          await writeFile(resolve(outDir, 'labels.json'), `${JSON.stringify(labels, null, 2)}\n`)
          const report = [
            `# improve ${opts.skill} v${version}`,
            '',
            `benchmark ${bm.id} · ${opts.split} · ${failed.length} failed runs · model ${IMPROVE_MODEL}`,
            '',
            '## Clusters',
            ...proposal.clusters.map(
              (c) =>
                `- **${c.slug}** ×${c.count}${c.addressed ? '' : ' (not addressed)'} — ${c.summary}`,
            ),
            '',
            '## Removed by semantic leak guard',
            ...(sanitized.removed.length
              ? sanitized.removed.map(
                  (r) => `- ${r.task_id}: "${r.passage.slice(0, 200)}" — ${r.why}`,
                )
              : ['- none']),
            '',
            '## Lexical leak warnings',
            ...(warnings.length ? warnings.map((w) => `- ${w}`) : ['- none']),
            '',
            '## Evidence',
            ...labels.map((l) => `- ${l.task_id} \`${l.run_id}\`: ${l.cluster} — ${l.root_cause}`),
          ].join('\n')
          await writeFile(resolve(outDir, 'improve-report.md'), `${report}\n`)
          console.log(
            `\nskills/${opts.skill}/v${version}.md · ~${estimateTokens(sanitized.skill_markdown)} tokens · ${warnings.length} leak warnings`,
          )
          console.log(`report ${resolve(outDir, 'improve-report.md')}`)
        } finally {
          store.close()
        }
      },
    )
}
