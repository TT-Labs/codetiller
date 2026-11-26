import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { type Factory, type Onboarding, onboardingOk, sandboxYaml } from '@codetiller/core'
import type { Command } from 'commander'

import { openFactory } from '../env.js'

/** `tiller repo | task`: repositories and the tasks agents work on. */
export function register(program: Command) {
  const repoCmd = program
    .command('repo')
    .description(
      'repositories the factory works on: onboarding, their sandbox profile, the baseline check',
    )

  /** What onboarding found, for a terminal. */
  function printOnboarding(o: Onboarding) {
    console.log(`${o.repo} at ${o.head.slice(0, 8)}`)
    for (const n of o.notes) console.log(`  · ${n}`)
    if (!o.profile)
      return console.log('\nno profile: write `sandbox:` in .factory/factory.yaml by hand')
    if (o.check) {
      console.log(`\nbaseline check${o.check.installed ? '' : ': dependency install FAILED'}`)
      if (o.check.error) console.log(o.check.error.replace(/^/gm, '    '))
      for (const c of o.check.suites) {
        const result =
          c.tests === null ? 'NO REPORT' : `${c.tests} tests, ${c.failing} failing at the base`
        console.log(`  ${c.name.padEnd(16)} ${result}  (${c.seconds} s)`)
        if (c.log) console.log(c.log.replace(/^/gm, '    '))
      }
      for (const c of o.check.checks ?? [])
        console.log(
          `  ${`check ${c.name}`.padEnd(28)} ${c.ok ? 'passes' : 'FAILS at the base (not held against a change)'}  (${c.seconds} s)`,
        )
    }
    if (o.source === 'repository') return
    console.log(
      `\nproposed .factory/factory.yaml (commit it to the repository; until then the factory uses this copy):\n`,
    )
    console.log(sandboxYaml(o.profile))
  }

  repoCmd
    .command('add <owner/name>')
    .description(
      'onboard a repository: take its .factory/factory.yaml or propose a sandbox profile from what is in it, install its dependencies and run its tests once; exit 2 when the profile does not run',
    )
    .option('--config <name>', 'agent config of its tasks (configs/<name>.yaml)', 'default')
    .option('--label <label>', 'issues with this label are imported (`none`: no intake)', 'tiller')
    .option('--no-check', 'do not install and run the tests')
    .action(async (repo: string, opts: { config: string; label: string; check: boolean }) => {
      const { store, factory } = openFactory()
      try {
        const o = await factory.onboard(repo, {
          config: opts.config,
          label: opts.label === 'none' ? null : opts.label,
          check: opts.check,
          log: (m) => console.error(`  ${m}`),
        })
        printOnboarding(o)
        if (o.check && !onboardingOk(o)) process.exitCode = 2
      } finally {
        store.close()
      }
    })
  repoCmd
    .command('list')
    .description('onboarded repositories and how their last baseline check went')
    .action(() => {
      const { store, factory } = openFactory()
      for (const r of factory.items.repos()) {
        const check = r.checked
          ? `${r.checked.ok ? 'ok' : 'FAILS'} at ${r.checked.head.slice(0, 8)}: ${r.checked.summary}`
          : 'not checked'
        const source = r.profile ? 'onboarding profile' : 'own .factory/factory.yaml'
        console.log(`${r.repo.padEnd(32)} ${source.padEnd(26)} label ${r.label ?? '—'}  ${check}`)
      }
      store.close()
    })
  repoCmd
    .command('remove <owner/name>')
    .description('forget an onboarded repository (its tasks stay)')
    .action((repo: string) => {
      const { store, factory } = openFactory()
      factory.items.removeRepo(repo)
      store.close()
    })

  const task = program.command('task').description('factory tasks: human-queued agent runs')
  task
    .command('create')
    .description('new task (IMPORTED); nothing runs until you enqueue it')
    .requiredOption('--repo <owner/name>')
    .requiredOption('--title <title>')
    .option('--body <text>', '', '')
    .option('--body-file <file>')
    .option(
      '--dataset <name>',
      "a sandbox profile of this checkout (datasets/<name>/profile.yaml); default: the repository's own .factory/factory.yaml, or what `tiller repo add` proposed",
      '',
    )
    .option('--config <name>', 'configs/<name>.yaml', 'default')
    .option('--ref <ref>', 'branch to start from (default: remote default branch)')
    .option('--model <id>', 'run on this model instead of the default (one of factory.models)')
    .option('--enqueue', 'queue the first run right away')
    .action(
      async (opts: {
        repo: string
        title: string
        body: string
        bodyFile?: string
        dataset: string
        config: string
        ref?: string
        model?: string
        enqueue?: boolean
      }) => {
        const { store, factory } = openFactory()
        try {
          const body = opts.bodyFile ? await readFile(resolve(opts.bodyFile), 'utf8') : opts.body
          let item = await factory.create({ ...opts, body })
          if (opts.enqueue) item = factory.enqueue(item.id)
          console.log(
            `${item.id}  ${item.state}  ${item.repo}@${item.base_commit.slice(0, 8)}  ${item.branch}`,
          )
        } finally {
          store.close()
        }
      },
    )
  task.command('list').action(() => {
    const { store, factory } = openFactory()
    const totals = factory.items.totals()
    const experiments = factory.items.experiments()
    for (const i of factory.items.list()) {
      const t = totals.get(i.id)
      const mark = experiments.has(i.id) ? '[experiment] ' : ''
      console.log(
        `${i.id.padEnd(6)} ${i.state.padEnd(18)} ${String(t?.runs ?? 0).padStart(2)} runs  $${(t?.cost_usd ?? 0).toFixed(2).padStart(6)}  ${mark}${i.title}`,
      )
    }
    store.close()
  })
  task
    .command('show <id>')
    .description('timeline: human messages, agent questions/summaries, runs')
    .action((id: string) => {
      const { store, factory } = openFactory()
      const item = factory.items.get(id)
      if (!item) throw new Error(`no task ${id}`)
      console.log(
        `${item.id} ${item.state} · ${item.repo} · ${item.branch} · ${item.config}\n${item.title}\n`,
      )
      for (const r of factory.items.runs(id)) {
        const cost = r.cost_usd === null ? '?' : `$${r.cost_usd.toFixed(2)}`
        const model = store.getConfig(r.config_id)?.model ?? '?'
        console.log(
          `run ${r.seq}  ${model}  ${r.agent_exit ?? 'running'}  ${cost}  ${r.turns ?? '?'} turns`,
        )
      }
      if (factory.items.runs(id).length) console.log('')
      for (const e of factory.items.events(id)) {
        const head = `${e.at.slice(11, 19)} ${e.actor.padEnd(7)} ${e.kind}`
        console.log(e.text ? `${head}\n${e.text.replace(/^/gm, '    ')}` : head)
      }
      store.close()
    })
  task
    .command('enqueue <id> [message...]')
    .description('queue a run; the message (answer / feedback) goes to the agent')
    .option('--no-preflight', 'start the first run without the read-only assessment')
    .option('--model <id>', 'run on this model from now on (`default` = back to the default)')
    .option('--out-of-order', 'a part of a split: start without waiting for the part before it')
    .action(
      (
        id: string,
        message: string[],
        opts: { preflight: boolean; model?: string; outOfOrder?: boolean },
      ) => {
        const { store, factory } = openFactory()
        try {
          const model = opts.model === 'default' ? null : opts.model
          const item = factory.enqueue(id, message.join(' '), {
            skipPreflight: !opts.preflight,
            model,
            outOfOrder: opts.outOfOrder,
          })
          const waits = factory.waitsFor(id)
          console.log(waits ? `${item.state}: starts when ${waits.id} is merged` : item.state)
        } finally {
          store.close()
        }
      },
    )
  task
    .command('experiment <ids...>')
    .description(
      'mark tasks as experiments (run to try the factory itself): left out of the metrics; --off unmarks',
    )
    .option('--off', 'count them in the metrics again')
    .action((ids: string[], opts: { off?: boolean }) => {
      const { store, factory } = openFactory()
      try {
        for (const id of ids) factory.setExperiment(id, !opts.off)
        console.log(
          `${ids.length} task(s) ${opts.off ? 'count in the metrics again' : 'marked as experiments'}`,
        )
      } finally {
        store.close()
      }
    })
  task
    .command('model [id] [model]')
    .description(
      'the model tasks run on. No arguments: the default and the models on offer. `<model>`: set the default (`none` = each config decides). `<task> <model>`: for one task (`default` = no own choice)',
    )
    .action(async (first?: string, second?: string) => {
      const { store, factory } = openFactory()
      try {
        if (first && second) {
          factory.setModel(first, second === 'default' ? null : second)
          const m = await factory.modelOf(first)
          console.log(`${first}: next run on ${m.model} (${m.source})`)
          return
        }
        if (first) factory.setDefaultModel(first === 'none' ? null : first)
        const s = factory.modelSettings()
        console.log(`default model: ${s.default_model ?? "none (each task's config decides)"}`)
        console.log(`on offer (tiller.yaml factory.models): ${s.models.join(', ') || 'none'}`)
      } finally {
        store.close()
      }
    })
  task
    .command('review <id>')
    .description(
      "second reader on its own: a read-only agent reads the task's change (or --base..--head of its repo) and reports what tests cannot say; nothing is recorded on the task",
    )
    .option('--base <commit>', "read the change from this commit (default: the task's base)")
    .option('--head <commit>', 'up to this commit (default: the head of the task branch)')
    .option('--json', 'print the report as JSON')
    .option(
      '--task-only',
      'give the reader the task text without the human messages that came later',
    )
    .action(
      async (
        id: string,
        opts: { base?: string; head?: string; json?: boolean; taskOnly?: boolean },
      ) => {
        const { store, factory } = openFactory()
        try {
          const item = factory.items.get(id)
          if (!item) throw new Error(`no task ${id}`)
          const head = opts.head ?? (await factory.head(id))
          const r = await factory.readChange(item, opts.base ?? item.base_commit, head, {
            messages: !opts.taskOnly,
          })
          const cost = r.stored.cost_usd === null ? '?' : `$${r.stored.cost_usd.toFixed(3)}`
          if (opts.json) console.log(JSON.stringify({ ...r.stored, text: r.text }, null, 2))
          else
            console.log(
              `${r.text}\n\n(${cost} · ${r.stored.turns ?? '?'} turns · ${Math.round(r.stored.duration_s ?? 0)} s · ${r.stored.run_id})`,
            )
        } finally {
          store.close()
        }
      },
    )
  task
    .command('ci <id>')
    .description(
      "what the repository's CI says about the task's pull request; --fix sends the failing checks and the end of their logs to the agent",
    )
    .option('--fix', 'queue a run with the failing checks as its message')
    .action(async (id: string, opts: { fix?: boolean }) => {
      const { store, factory } = openFactory()
      try {
        await factory.syncPrs()
        const ci = factory.items.ci(id)
        if (!ci) return console.log('no CI seen for this task (no pull request, or no token)')
        const failing = ci.failing.map((c) => c.name).join(', ')
        console.log(
          `CI ${ci.state} at ${ci.head.slice(0, 7)} (${ci.total} checks${failing ? `; failing: ${failing}` : ''}; sent to the agent ${ci.attempts}×)`,
        )
        if (opts.fix) {
          await factory.fixCi(id, 'human')
          console.log('queued for the agent; run the worker')
        }
      } finally {
        store.close()
      }
    })
  task
    .command('verify <id>')
    .description(
      'verify the task branch again without an agent run (push when it passes); --accept-removed: tests the change removed stop failing it',
    )
    .option('--accept-removed', 'the tests the last verification found removed may go')
    .option(
      '--accept-checks',
      'the changed files that decide the checks (test config, scripts) are fine: no second run with the old ones',
    )
    .action(async (id: string, opts: { acceptRemoved?: boolean; acceptChecks?: boolean }) => {
      const { store, factory } = openFactory()
      try {
        const { accepted, done } = await factory.verifyAgain(id, opts)
        if (accepted.length) console.log(`accepted: ${accepted.join(', ').slice(0, 400)}`)
        await done
        console.log(factory.items.get(id)?.state)
      } finally {
        store.close()
      }
    })
  task
    .command('update <id>')
    .description(
      'bring the default branch into the task: clean merge → verify and push; conflicts → queued for the agent',
    )
    .action(async (id: string) => {
      const { store, factory } = openFactory()
      try {
        const { result, done } = await factory.update(id)
        await done
        const state = factory.items.get(id)?.state
        console.log(
          result === 'current'
            ? 'already on the current default branch'
            : result === 'merged'
              ? `merged without conflicts → ${state}`
              : `conflicts: queued for the agent (${state}); run the worker`,
        )
      } finally {
        store.close()
      }
    })
  task
    .command('split <id>')
    .description(
      'approve the split the preflight proposed: its parts become tasks, the original is cancelled',
    )
    .action((id: string) => {
      const { store, factory } = openFactory()
      try {
        for (const t of factory.split(id)) console.log(`${t.id}  ${t.state}  ${t.title}`)
      } finally {
        store.close()
      }
    })
  task
    .command('import')
    .description('import labelled issues of the tiller.yaml projects now (IMPORTED, not queued)')
    .action(async () => {
      const { store, factory } = openFactory()
      try {
        const { created, errors } = await factory.importIssues()
        if (errors.length) process.exitCode = 1
        for (const i of created) console.log(`${i.id}  ${i.repo}  ${i.title}  ${i.external_url}`)
        console.log(`${created.length} imported`)
      } finally {
        store.close()
      }
    })
  task
    .command('manifest <runId>')
    .description(
      'what a run was made of (repo commit, skills, model, image, prompt); --check: can it still be rebuilt',
    )
    .option('--check', 'verify every input is still there and unchanged; exit 1 on drift')
    .action(async (runId: string, opts: { check?: boolean }) => {
      const { store, factory } = openFactory()
      try {
        const { manifest, checks } = await factory.checkRun(runId)
        if (!opts.check) return console.log(JSON.stringify(manifest, null, 2))
        for (const c of checks)
          console.log(`${c.ok ? 'ok   ' : 'DRIFT'}  ${c.what.padEnd(28)}${c.detail}`)
        const drift = checks.filter((c) => !c.ok).length
        console.log(
          drift
            ? `\n${drift} input(s) differ: a rerun would not be the same run`
            : '\nall inputs can be rebuilt unchanged',
        )
        if (drift) process.exitCode = 1
      } finally {
        store.close()
      }
    })
  task
    .command('metrics')
    .description('delivery, first pass, human interventions and cost over all tasks')
    .action(() => {
      const { store, factory } = openFactory()
      const m = factory.metrics()
      const pct = (x: number | null) => (x === null ? '—' : `${(x * 100).toFixed(0)}%`)
      const usd = (x: number | null) => (x === null ? '—' : `$${x.toFixed(2)}`)
      const num = (x: number | null) => (x === null ? '—' : x.toFixed(2))
      if (m.experiments)
        console.log(`(${m.experiments} tasks marked as experiments are left out)\n`)
      for (const f of m.funnel) console.log(`${f.stage.padEnd(28)}${f.tasks}`)
      const row = (key: string, g: (typeof m)['total']) =>
        `${key.padEnd(28)}${String(g.tasks).padEnd(7)}${String(g.delivered).padEnd(11)}${pct(g.firstPassRate).padEnd(12)}${num(g.interventionsPerTask).padEnd(15)}${usd(g.costPerDelivered).padEnd(16)}${usd(g.cost_usd)}`
      console.log(
        `\n${''.padEnd(28)}${'tasks'.padEnd(7)}${'delivered'.padEnd(11)}${'first pass'.padEnd(12)}${'interv./task'.padEnd(15)}${'cost/delivered'.padEnd(16)}cost`,
      )
      console.log(row('all', m.total))
      for (const g of m.byRepo) console.log(row(g.key, g))
      for (const g of m.byConfig) console.log(row(`config ${g.key}`, g))
      for (const g of m.byModel) console.log(row(`model ${g.key}`, g))
      console.log(`\nreview        ${JSON.stringify(m.review)}`)
      console.log(`preflight     ${JSON.stringify(m.preflight)}`)
      console.log(`verification  ${JSON.stringify(m.verification)}`)
      store.close()
    })
  task
    .command('sync')
    .description(
      'PR feedback now: queue tasks with a new `/tiller …` PR comment, close merged / closed ones',
    )
    .action(async () => {
      const { store, factory } = openFactory()
      try {
        const { queued, closed, errors } = await factory.syncPrs()
        if (errors.length) process.exitCode = 1
        for (const e of errors) console.error(e)
        console.log(`${queued.length} queued${queued.length ? ` (${queued.join(', ')})` : ''}`)
        console.log(`${closed.length} closed${closed.length ? ` (${closed.join(', ')})` : ''}`)
      } finally {
        store.close()
      }
    })
  task
    .command('run')
    .description('execute queued runs in the foreground until the queue is empty')
    .action(async () => {
      const { store, factory } = openFactory()
      if (!factory.canRun) throw new Error('ANTHROPIC_API_KEY not set (.env)')
      try {
        await factory.drain()
      } finally {
        store.close()
      }
    })
  for (const [name, fn] of [
    ['complete', (f: Factory, id: string) => f.complete(id)],
    ['cancel', (f: Factory, id: string) => f.cancel(id)],
  ] as const) {
    task.command(`${name} <id>`).action((id: string) => {
      const { store, factory } = openFactory()
      console.log(fn(factory, id).state)
      store.close()
    })
  }
}
