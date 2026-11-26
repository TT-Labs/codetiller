import { randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AgentResult } from '../agents/agent.js'
import { adapterFor } from '../agents/index.js'
import { type Config, configHash } from '../config/config.js'
import { renderContext } from '../context/context.js'
import { overlayContext } from '../context/overlay.js'
import { REPO_SKILLS_DIR, resolveSkills } from '../context/resolve.js'
import { contextFileFor } from '../context/skills.js'
import { ensureDeps } from '../sandbox/deps.js'
import { type GatewayUsage, modelAccess, runAccounted } from '../sandbox/gateway.js'
import { missingCommands } from '../transcript/missing.js'
import { diffStats, git } from '../workspace/git.js'
import { costOf, type FactoryBase, NO_PREFLIGHT, PREFLIGHT_RUN } from './base.js'
import type { Delivery } from './delivery.js'
import type { FactoryDeps } from './deps.js'
import { forgeSafe } from './forge-text.js'
import type { Preflight, WorkItems } from './items.js'
import { writeManifest } from './manifest.js'
import { checks, issueText } from './messages.js'
import { parseSignal, type WorkItem } from './model.js'
import {
  gate,
  type PreflightLimits,
  parsePreflight,
  REPO_FACTORY_FILE,
  type ResolvedLimits,
  renderPreflight,
  resolveLimits,
  tolerated,
} from './preflight.js'
import type { TaskRepo } from './repo.js'
import { verificationVerdict } from './verify.js'

/** One run of a task: its workspace, the read-only assessment before the first write run, the agent run itself. */
export class Runs {
  private readonly deps: FactoryDeps
  private readonly items: WorkItems

  constructor(
    private readonly base: FactoryBase,
    private readonly delivery: Delivery,
  ) {
    this.deps = base.deps
    this.items = base.items
  }

  async execute(id: string) {
    const limits = this.deps.preflight
    const fail = (e: unknown) => {
      this.items.transition(id, ['PREFLIGHT', 'RUNNING'], 'FAILED')
      this.items.event(id, 'factory', 'state', `run error: ${(e as Error).message.slice(0, 500)}`)
    }
    if (limits && this.base.wantsPreflight(id)) {
      if (!this.items.transition(id, ['QUEUED'], 'PREFLIGHT')) return
      let go: boolean
      try {
        go = await this.preflight(this.base.mustGet(id), limits)
      } catch (e) {
        // not the assessment's answer but its plumbing (image, workspace): the run would hit it too
        fail(e)
        throw e
      }
      // the human gate: enqueue again (with answers / to run anyway), split, or cancel
      if (!this.items.transition(id, ['PREFLIGHT'], go ? 'RUNNING' : 'WAITING_FOR_HUMAN')) return
      if (!go) return this.base.log(`${id}: preflight → WAITING_FOR_HUMAN`)
    } else if (!this.items.transition(id, ['QUEUED'], 'RUNNING')) return
    try {
      await this.runAgent(this.base.mustGet(id))
    } catch (e) {
      fail(e)
      throw e
    }
  }

  /**
   * Persistent workspace: the first use clones + branches, later ones reuse it. A task that came
   * from the tracker or from a split starts from where the default branch is now, not where it
   * was at import: weeks may have passed, and the earlier parts of a split have been merged.
   */
  private async workspace(item: WorkItem) {
    const repo = this.base.repo(item.id)
    let current = item
    const made = await repo.exists()
    // A workspace only the read-only assessment has seen holds nothing of the agent's: when the
    // run starts later (a part of a split waited for the one before it), it starts from the
    // default branch as it is then.
    const untouched =
      made && this.items.runs(item.id).length === 0 && (await repo.head()) === item.base_commit
    if (!made || untouched) {
      const cache = await this.deps.workspaces.ensureRepo(item.repo, [item.base_commit])
      if (item.source === 'github' || item.source === 'split') {
        await this.deps.workspaces.fetch(item.repo)
        const head = (await git(cache, 'rev-parse', '--verify', 'origin/HEAD^{commit}')).trim()
        if (head !== item.base_commit) {
          this.items.setBase(item.id, head)
          const moved = `base moved to the current default branch: ${item.base_commit.slice(0, 8)} → ${head.slice(0, 8)}`
          this.items.event(item.id, 'factory', 'state', moved)
          current = this.base.mustGet(item.id)
        }
      }
      if (made && current.base_commit !== item.base_commit) await repo.dispose()
      if (!made || current.base_commit !== item.base_commit)
        await repo.init(cache, current.base_commit, current.branch)
    }
    return { ws: this.base.workspaceDir(item.id), repo, item: current }
  }

  /**
   * Skills of a run: factory built-ins, the repository's own, the config's. The
   * repository's are read from the git dir at the base commit: what the agent writes into
   * `.factory/skills` in its workspace never instructs its own next run.
   */
  private async skillsFor(item: WorkItem, config: Config, repo: TaskRepo) {
    return resolveSkills({
      skillsDir: this.base.skillDirs(),
      builtin: this.deps.skills ?? [],
      repo: (await repo.files(item.base_commit, REPO_SKILLS_DIR)).filter((f) =>
        f.path.endsWith('.md'),
      ),
      config: config.skills,
    })
  }

  /**
   * The preflight limits for one task: the repository's `.factory/factory.yaml` at the base
   * commit (from git, like its skills), over the project entry in tiller.yaml, over the default.
   */
  private async limitsFor(
    item: WorkItem,
    repo: TaskRepo,
    defaults: PreflightLimits,
  ): Promise<ResolvedLimits> {
    const file = (await repo.files(item.base_commit, '.factory')).find(
      (f) => f.path === REPO_FACTORY_FILE,
    )
    const project = this.base.projects().find((p) => p.repo === item.repo)?.preflight
    return resolveLimits(defaults, project, file?.text)
  }

  /**
   * Read-only assessment before the first write run; true = go on to the run. The
   * agent reports estimates, the gate is the factory's limits over them. An assessment that
   * itself fails (agent error, unreadable answer) stops at the human gate like a failed one: let
   * through, the first such task was a 32-file change the limits exist to catch.
   */
  private async preflight(queued: WorkItem, defaults: PreflightLimits): Promise<boolean> {
    const env = this.deps.env
    if (!env) throw new Error('no model credentials (ANTHROPIC_API_KEY)')
    const { sandbox, items } = this.deps
    const profile = await this.base.profile(queued)
    const config = await this.base.configFor(queued)
    const { ws, repo, item } = await this.workspace(queued)
    const limits = await this.limitsFor(item, repo, defaults)
    if (!limits.enabled) {
      items.setPreflight(item.id, { ...NO_PREFLIGHT, verdict: 'skipped', limits })
      const where = limits.source === 'repository' ? REPO_FACTORY_FILE : 'tiller.yaml'
      items.event(
        item.id,
        'factory',
        'preflight',
        `skipped: turned off for this repository (${where})`,
      )
      return true
    }
    const skills = await this.skillsFor(item, config, repo)
    const messages = items.pendingMessageEvents(item.id)
    const issue = issueText(
      item,
      messages.map((m) => m.text),
    )
    const prompt = (await this.base.prompt('preflight.md'))
      // the sizes that actually stop a task: limit plus tolerance
      .replaceAll('{{max_files}}', String(tolerated(limits).files))
      .replaceAll('{{max_concepts}}', String(tolerated(limits).concepts))
      .replace('{{issue}}', () => issue)
    const runId = `${item.id}-preflight-${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}-${randomUUID().slice(0, 6)}`
    const dir = await items.store.runDir(runId)
    const promptFile = join(dir, 'prompt.md')
    await writeFile(promptFile, prompt)
    this.base.log(`${item.id}: preflight (${config.harness} ${config.model})`)

    const assess = { ...config, limits: { ...config.limits, ...PREFLIGHT_RUN } }
    const access = await modelAccess(env, this.deps.gateway, {
      label: `${item.id} preflight`,
      config: assess,
      prices: this.deps.prices,
    })
    const overlay = await overlayContext(ws, contextFileFor(config.harness), skills)
    const manifest = await this.base.manifest(item, assess, skills, {
      id: runId,
      kind: 'preflight',
      seq: null,
      head: await repo.head(),
      configId: configHash(assess, prompt, skills.length ? renderContext(undefined, skills) : ''),
      image: profile.image,
      access,
      template: 'preflight.md',
      prompt,
      context: overlay.rendered,
      resumed: null,
      messages: messages.map((m) => m.id),
    })
    await writeManifest(dir, manifest)
    const transcript = createWriteStream(join(dir, 'transcript.jsonl'))
    let agent: AgentResult
    let usage: GatewayUsage | undefined
    try {
      ;({ agent, usage } = await runAccounted(access, () =>
        adapterFor(config.harness).run({
          sandbox,
          image: profile.image,
          workspace: ws,
          promptFile,
          readOnly: true,
          config: assess,
          env: access.env,
          network: access.network,
          offline: access.offline,
          onStdout: (c) => transcript.write(c),
        }),
      ))
    } finally {
      await new Promise((r) => transcript.end(r))
      await overlay.restore()
    }
    if (agent.stderr) await writeFile(join(dir, 'agent.stderr.log'), agent.stderr)
    this.noteGateway(item.id, runId, usage)
    const spent = {
      run_id: runId,
      cost_usd: agent.cost_usd,
      turns: agent.turns ?? null,
      duration_s: agent.duration_s,
    }
    let verdict: Preflight['verdict']
    let text: string
    let report: Preflight['report'] = null
    try {
      if (agent.exit !== 'ok') throw new Error(`agent ${agent.exit}`)
      report = parsePreflight(agent.finalText)
      verdict = gate(report, limits)
      text = renderPreflight(report, verdict, limits)
    } catch (e) {
      verdict = 'error'
      const why = (e as Error).message.replace(/\s+/g, ' ').slice(0, 300)
      text = `Preflight failed: ${why}\n\nNext: enqueue again to run without it, or cancel.`
    }
    items.setPreflight(item.id, { verdict, report, limits, ...spent })
    items.event(item.id, 'factory', 'preflight', text, runId)
    await writeManifest(dir, {
      ...manifest,
      result: {
        exit: agent.exit,
        signal: null,
        ...costOf(agent, usage),
        turns: agent.turns ?? null,
        duration_s: agent.duration_s,
        commit: null,
        verification: null,
      },
    })
    this.base.log(`${item.id}: preflight ${verdict}`)
    return verdict === 'pass'
  }

  private async runAgent(queued: WorkItem) {
    const env = this.deps.env
    if (!env) throw new Error('no model credentials (ANTHROPIC_API_KEY)')
    const { sandbox, items } = this.deps
    const store = items.store
    const profile = await this.base.profile(queued)
    const config = await this.base.configFor(queued)

    const { ws, repo, item } = await this.workspace(queued)
    const skills = await this.skillsFor(item, config, repo)
    const stateDir = this.base.stateDir(item.id)
    await mkdir(stateDir, { recursive: true })
    const nm = await ensureDeps(sandbox, profile, ws, item.repo, (m) =>
      this.base.log(`${item.id}: ${m}`),
    )

    // context pack (skills) as untracked overlay, restored before committing
    const contextFile = contextFileFor(config.harness)
    const context = skills.length ? renderContext(undefined, skills) : ''
    // symlink-safe: a `CLAUDE.md -> AGENTS.md` link is kept, an agent-planted one is never followed
    const overlay = await overlayContext(ws, contextFile, skills)
    const rendered = overlay.rendered

    const implement = await this.base.prompt('implement.md')
    const pending = items.pendingMessageEvents(item.id)
    const messages = pending.map((m) => m.text)
    const resume = item.session_id ?? undefined
    // The agent's last commit did not pass verification and a human sends it back: it has to
    // know what failed, whatever the human wrote. (An update or a CI failure says so itself.)
    const lastRun = items.runs(item.id).at(-1)
    const verdict = items
      .events(item.id)
      .findLast((e) => e.kind === 'verification' && e.actor === 'factory')
    const failedLast =
      verdict?.text &&
      verdict.run_id === lastRun?.id &&
      ['fail', 'error'].includes(verificationVerdict(verdict.text))
    if (resume && failedLast && !messages.some((m) => m.includes('verification')))
      messages.unshift(
        `The factory's verification of your last commit did not pass, and nothing was pushed:\n\n${verdict.text}`,
      )
    // replacer functions: `$&`, `$'` or `$$` in an issue or a message must stay literal
    const prompt = resume
      ? (await this.base.prompt('continue.md')).replace('{{message}}', () =>
          messages.join('\n\n---\n\n'),
        )
      : implement.replace('{{issue}}', () =>
          issueText(item, messages, items.preflight(item.id)?.report?.questions),
        )
    const configId = configHash(config, implement, context)
    store.upsertConfig(configId, config, implement)

    const runId = `${item.id}-${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}-${randomUUID().slice(0, 6)}`
    const dir = await store.runDir(runId)
    const promptFile = join(dir, 'prompt.md')
    await writeFile(promptFile, prompt)
    if (rendered) await writeFile(join(dir, 'context.md'), rendered)
    const run = items.startRun({
      id: runId,
      item_id: item.id,
      config_id: configId,
      session_id: resume ?? null,
    })
    items.event(item.id, 'factory', 'run_started', `run ${run.seq}`, runId)
    this.base.log(
      `${item.id}: run ${run.seq} (${config.harness} ${config.model}${resume ? ', resumed' : ''})`,
    )

    const before = await repo.head()
    const access = await modelAccess(env, this.deps.gateway, {
      label: `${item.id} run ${run.seq}`,
      config,
      prices: this.deps.prices,
    })
    const manifest = await this.base.manifest(item, config, skills, {
      id: runId,
      kind: 'run',
      seq: run.seq,
      head: before,
      configId,
      image: profile.image,
      access,
      template: resume ? 'continue.md' : 'implement.md',
      prompt,
      context: rendered,
      resumed: resume ?? null,
      messages: pending.map((m) => m.id),
    })
    await writeManifest(dir, manifest)
    // a PR that exists before the run hears about its outcome; the run that opens it does not
    const openPr = items.pr(item.id)
    const transcript = createWriteStream(join(dir, 'transcript.jsonl'))
    let agent: AgentResult
    let usage: GatewayUsage | undefined
    try {
      ;({ agent, usage } = await runAccounted(access, () =>
        adapterFor(config.harness).run({
          sandbox,
          image: profile.image,
          workspace: ws,
          promptFile,
          volumes: nm.volumes,
          tmpfs: nm.scratch,
          config,
          env: access.env,
          network: access.network,
          offline: access.offline,
          stateDir,
          resumeSession: resume,
          onStdout: (c) => transcript.write(c),
        }),
      ))
    } finally {
      await new Promise((r) => transcript.end(r))
      await overlay.restore()
    }
    if (agent.stderr) await writeFile(join(dir, 'agent.stderr.log'), agent.stderr)
    this.noteGateway(item.id, runId, usage)
    // a tool the image lacks costs the agent turns: surface it as a sandbox defect
    const missing = missingCommands(agent.transcript)
    if (missing.length) {
      const list = missing.map((m) => `${m.command} ×${m.count}`).join(', ')
      items.event(item.id, 'factory', 'state', `sandbox image lacks: ${list}`, runId)
    }

    // factory commits from the trusted git dir; push happens from here too
    const after = await repo.commitAll(`tiller: ${item.id} run ${run.seq}`)
    const patch = after ? await repo.diff(before, after) : ''
    await writeFile(join(dir, 'diff.patch'), patch)
    const stats = diffStats(patch)

    const session = agent.session_id ?? resume ?? null
    if (session) items.setSession(item.id, session)
    const { signal, text } = parseSignal(agent.finalText)
    items.finishRun(runId, {
      session_id: session,
      duration_s: agent.duration_s,
      cost_usd: agent.cost_usd,
      turns: agent.turns ?? null,
      agent_exit: agent.exit,
      signal,
      commit_sha: after ?? null,
      diff_files: stats.files,
      diff_lines: stats.lines,
    })
    const cost = agent.cost_usd === null ? '?' : `$${agent.cost_usd.toFixed(2)}`
    items.event(
      item.id,
      'factory',
      'run_finished',
      `run ${run.seq}: ${agent.exit} · ${cost} · ${agent.turns ?? '?'} turns · ${stats.files} files`,
      runId,
    )

    let reply: string
    if (agent.exit !== 'ok') {
      items.transition(item.id, ['RUNNING'], 'FAILED')
      const why =
        agent.exit === 'budget'
          ? `the run spent its budget of $${config.limits.budget_usd.toFixed(2)}`
          : `agent ${agent.exit}`
      items.event(item.id, 'factory', 'state', `${why}; enqueue again to retry`, runId)
      reply = `**Run ${run.seq} failed** (${why}). Comment \`/tiller\` to retry.`
    } else if (signal === 'needs_human') {
      const question = text || '(no question text)'
      items.event(item.id, 'agent', 'question', question, runId)
      items.transition(item.id, ['RUNNING'], 'WAITING_FOR_HUMAN')
      reply = `**Run ${run.seq}: the agent needs an answer.**\n\n${forgeSafe(question)}\n\nAnswer with a comment starting with \`/tiller\`.`
    } else {
      const note = signal === 'none' ? '\n\n(agent ended without a TILLER: status line)' : ''
      items.event(item.id, 'agent', 'summary', `${text || '(no summary)'}${note}`, runId)
      const d = await this.delivery.deliver(
        item,
        { run, label: `run ${run.seq}`, dir },
        text,
        (m) => this.base.log(`${item.id}: ${m}`),
      )
      items.transition(item.id, ['RUNNING'], d.pushed ? 'PR_OPEN' : 'REVIEW')
      reply = [
        d.pushed
          ? `**Run ${run.seq} pushed** ${(after ?? before).slice(0, 7)}.`
          : `**Run ${run.seq} finished, nothing pushed.**`,
        forgeSafe(text) || '(agent gave no summary)',
        checks(d),
        ...(d.pushed ? [] : ['Comment `/tiller <instructions>` to continue.']),
      ].join('\n\n')
    }
    await writeManifest(dir, {
      ...manifest,
      result: {
        exit: agent.exit,
        signal,
        ...costOf(agent, usage),
        turns: agent.turns ?? null,
        duration_s: agent.duration_s,
        commit: after ?? null,
        verification:
          items.events(item.id).findLast((e) => e.kind === 'verification' && e.run_id === runId)
            ?.text ?? null,
      },
    })
    if (openPr)
      await this.delivery.reply(item, openPr.number, `${reply}\n\n— codetiller · ${item.id}`, runId)
    this.base.log(`${item.id}: run ${run.seq} → ${this.base.mustGet(item.id).state}`)
  }

  /**
   * What the gateway refused of a run goes on the timeline: a refusal is either the budget doing
   * its work or the agent trying something a run has no business doing.
   */
  private noteGateway(itemId: string, runId: string, usage: GatewayUsage | undefined) {
    if (!usage?.refused) return
    const reasons = Object.entries(usage.reasons)
      .map(([why, n]) => `${why}${n > 1 ? ` ×${n}` : ''}`)
      .join('; ')
    this.items.event(
      itemId,
      'factory',
      'state',
      `model gateway refused ${usage.refused} call(s): ${reasons.slice(0, 600)}`,
      runId,
    )
  }
}
