import { randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AgentResult } from '../agents/agent.js'
import { adapterFor } from '../agents/index.js'
import { configHash } from '../config/config.js'
import { type GatewayUsage, modelAccess, runAccounted } from '../sandbox/gateway.js'
import { git } from '../workspace/git.js'
import { costOf, type FactoryBase, PREFLIGHT_RUN } from './base.js'
import type { FactoryDeps } from './deps.js'
import type { WorkItems } from './items.js'
import { writeManifest } from './manifest.js'
import { issueText, prBody } from './messages.js'
import type { WorkItem, WorkRun } from './model.js'
import {
  diffForPrompt,
  parseReview,
  type ReviewReport,
  type ReviewVerdict,
  renderReview,
  reviewVerdict,
} from './review.js'
import { type Verification, verificationSummary, verifyCommit } from './verify.js'

/** After the agent says done: verification on a clean export, the second reader, push and draft PR. */
export class Delivery {
  private readonly deps: FactoryDeps
  private readonly items: WorkItems

  constructor(private readonly base: FactoryBase) {
    this.deps = base.deps
    this.items = base.items
  }

  /**
   * After the agent says done: verify the branch head on a clean export, then push + draft PR.
   * Nothing is pushed unless verification passed; either way a human reviews next. `pushed` = the
   * PR now shows the verified head; `note` = the verification verdict (or why there is none).
   */
  async deliver(
    item: WorkItem,
    /** what is being delivered: an agent run, or a factory update of the branch */
    of: { run?: WorkRun; label: string; dir: string },
    summary: string,
    log: (m: string) => void,
  ): Promise<{ pushed: boolean; note: string; reading?: string }> {
    const { items, sandbox, forge } = this.deps
    const run = { id: of.run?.id }
    const dir = of.dir
    const repo = this.base.repo(item.id)
    const head = await repo.head()
    if (head === item.base_commit) {
      const note = 'skipped: no changes on the branch'
      items.event(item.id, 'factory', 'verification', note, run.id)
      return { pushed: false, note }
    }
    // a merge committed with its conflict markers is not something to run tests on, let alone push
    const unresolved = await repo.markers(head)
    if (unresolved.length) {
      const note = `verification failed: conflict markers remain in ${unresolved.slice(0, 10).join(', ')}`
      items.event(item.id, 'factory', 'verification', note, run.id)
      return { pushed: false, note }
    }
    let v: Verification
    try {
      const profile = await this.base.profile(item)
      v = await verifyCommit(
        { sandbox, profile, repo, repoName: item.repo, log },
        item.base_commit,
        head,
      )
    } catch (e) {
      const message = `verification error: ${(e as Error).message.slice(0, 500)}`
      items.event(item.id, 'factory', 'verification', message, run.id)
      return { pushed: false, note: message }
    }
    await writeFile(join(dir, 'verify.log'), v.log)
    const note = verificationSummary(v)
    items.event(item.id, 'factory', 'verification', note, run.id)
    log(`verification ${v.status}`)
    if (v.status !== 'pass') return { pushed: false, note }
    // the tests pass: a second reader says what they cannot. Its word goes to the human with
    // the change; it holds nothing back, and a reader that fails is a note, not a stop.
    const reading = await this.secondRead(item, head, log).catch((e: Error) => {
      const text = `second reader failed: ${e.message.slice(0, 300)}`
      items.event(item.id, 'factory', 'review', text, run.id)
      return text
    })
    if (!forge) return { pushed: false, note, reading }
    try {
      await repo.push(forge.remoteUrl(item.repo), item.branch, forge.gitAuth())
      const existing = items.pr(item.id)
      if (existing) {
        items.event(item.id, 'factory', 'pr', `pushed ${of.label} to ${existing.url}`, run.id)
        // a push does not bring the default branch in: the PR is current only if the task's base
        // is where that branch was last seen (no network here; the next sync looks properly)
        const seen = await git(
          this.deps.workspaces.repoCache(item.repo),
          'rev-parse',
          '--verify',
          'origin/HEAD^{commit}',
        ).then(
          (out) => out.trim(),
          () => undefined,
        )
        if (seen === item.base_commit) items.setPrState(item.id, 'current')
        return { pushed: true, note, reading }
      }
      const pr = await forge.openDraft({
        repo: item.repo,
        head: item.branch,
        title: item.title,
        body: prBody(item, summary, v, reading),
      })
      items.setPr(item.id, pr)
      items.event(item.id, 'factory', 'pr', `draft PR #${pr.number}: ${pr.url}`, run.id)
      log(`draft PR ${pr.url}`)
      return { pushed: true, note, reading }
    } catch (e) {
      const message = `push / PR failed: ${(e as Error).message.slice(0, 500)}`
      items.event(item.id, 'factory', 'pr', message, run.id)
      return { pushed: false, note: `${note}\n\n${message}`, reading }
    }
  }

  /**
   * Second reader: a read-only agent reads the verified change against the task and
   * says what tests cannot: code that works on the checks instead of the behaviour, and what a
   * maintainer would not merge although the tests pass. Returns its word for the timeline and
   * the PR; undefined when it is off. A head already read is not read again.
   */
  private async secondRead(
    item: WorkItem,
    head: string,
    log: (m: string) => void,
  ): Promise<string | undefined> {
    const env = this.deps.env
    if (!this.deps.review?.enabled || !env) return undefined
    const { items } = this.deps
    const last = items.review(item.id)
    if (last?.head === head && last.report) return renderReview(last.report)
    const result = await this.readChange(item, item.base_commit, head)
    items.addReview({ item_id: item.id, head, ...result.stored })
    items.event(item.id, 'factory', 'review', result.text, result.stored.run_id)
    log(`second reader: ${result.stored.verdict}`)
    return result.text
  }

  /**
   * One reading of `base..head` of a task's repo, on a clean read-only export of `head`. Used
   * after verification, and on its own to try the reader on a change of the past.
   */
  async readChange(
    item: WorkItem,
    base: string,
    head: string,
    /** `messages: false`: the task text alone, without what the human said later (for trying the reader on a past state) */
    opts: { messages?: boolean } = {},
  ) {
    const env = this.deps.env
    if (!env) throw new Error('no model credentials (ANTHROPIC_API_KEY)')
    const { sandbox, items } = this.deps
    const profile = await this.base.profile(item)
    const config = await this.base.configFor(item)
    const read = { ...config, limits: { ...config.limits, ...PREFLIGHT_RUN } }
    const repo = this.base.repo(item.id)
    const said =
      opts.messages === false
        ? []
        : items
            .events(item.id)
            .filter((e) => e.kind === 'message' && e.actor === 'human')
            .map((e) => e.text ?? '')
    const issue = issueText(item, said)
    const diff = await repo.diff(base, head)
    const text = (await this.base.prompt('review.md'))
      .replace('{{issue}}', () => issue)
      .replace('{{diff}}', () => diffForPrompt(diff))
    const runId = `${item.id}-review-${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}-${randomUUID().slice(0, 6)}`
    const dir = await items.store.runDir(runId)
    const promptFile = join(dir, 'prompt.md')
    await writeFile(promptFile, text)
    await writeFile(join(dir, 'diff.patch'), diff)
    const access = await modelAccess(env, this.deps.gateway, {
      label: `${item.id} review`,
      config: read,
      prices: this.deps.prices,
    })
    const tree = await repo.exportTree(head)
    const manifest = await this.base.manifest(item, read, [], {
      id: runId,
      kind: 'review',
      seq: null,
      head,
      configId: configHash(read, text, ''),
      image: profile.image,
      access,
      template: 'review.md',
      prompt: text,
      context: '',
      resumed: null,
      messages: [],
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
          workspace: tree,
          promptFile,
          readOnly: true,
          config: read,
          env: access.env,
          network: access.network,
          offline: access.offline,
          onStdout: (c) => transcript.write(c),
        }),
      ))
    } finally {
      await new Promise((r) => transcript.end(r))
      await rm(tree, { recursive: true, force: true })
    }
    if (agent.stderr) await writeFile(join(dir, 'agent.stderr.log'), agent.stderr)
    let report: ReviewReport | null = null
    let verdict: ReviewVerdict
    let word: string
    try {
      if (agent.exit !== 'ok') throw new Error(`agent ${agent.exit}`)
      report = parseReview(agent.finalText)
      verdict = reviewVerdict(report)
      word = renderReview(report)
    } catch (e) {
      verdict = 'error'
      word = `second reader failed: ${(e as Error).message.replace(/\s+/g, ' ').slice(0, 300)}`
    }
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
    return {
      text: word,
      report,
      stored: {
        run_id: runId,
        verdict,
        report,
        cost_usd: agent.cost_usd,
        turns: agent.turns ?? null,
        duration_s: agent.duration_s,
      },
    }
  }

  /** Tell the PR what a run did. A failed comment is a timeline note, never a failed run. */
  async reply(item: WorkItem, number: number, body: string, runId: string | undefined) {
    try {
      await this.deps.forge?.comment(item.repo, number, body)
    } catch (e) {
      const message = `PR comment failed: ${(e as Error).message.slice(0, 300)}`
      this.items.event(item.id, 'factory', 'pr', message, runId)
    }
  }
}
