import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { git } from '../workspace/git.js'
import { exists, type FactoryBase } from './base.js'
import type { Delivery } from './delivery.js'
import type { CreateWorkItem, FactoryDeps, Intake, PrSync } from './deps.js'
import { feedbackMessage } from './feedback.js'
import type { CiStatus, PrComment } from './forge.js'
import type { PrSyncState, WorkItems } from './items.js'
import { brokenMergeMessage, checks, ciMessage, conflictMessage } from './messages.js'
import { CLOSABLE, QUEUEABLE, type WorkItem } from './model.js'
import { acceptChecks, acceptRemoved, verificationVerdict } from './verify.js'

/** The tracker and the forge: issues in, pull request feedback and CI in, the default branch into a task's branch. */
export class Sync {
  private readonly deps: FactoryDeps
  private readonly items: WorkItems

  private importing: Promise<Intake> | undefined
  private syncing: Promise<PrSync> | undefined
  /** when the tracker / forge was last polled and what went wrong (for the status view) */
  lastIntake: { at: string; errors: string[] } | undefined
  lastSync: { at: string; errors: string[] } | undefined

  constructor(
    private readonly base: FactoryBase,
    private readonly delivery: Delivery,
    private readonly create: (input: CreateWorkItem) => Promise<WorkItem>,
  ) {
    this.deps = base.deps
    this.items = base.items
  }

  /**
   * Intake: labelled tracker issues become IMPORTED items, once each. Importing never
   * queues a run: a human does that. One failing project doesn't block the others.
   */
  importIssues(): Promise<Intake> {
    this.importing ??= this.doImport().finally(() => {
      this.importing = undefined
    })
    return this.importing
  }

  private async doImport(): Promise<Intake> {
    const { tracker } = this.deps
    const projects = this.base.projects()
    if (!tracker || !projects.length)
      throw new Error(
        'no tracker configured (a token, and a repository added with `tiller repo add`)',
      )
    const created: WorkItem[] = []
    const errors: string[] = []
    for (const p of projects) {
      try {
        for (const issue of await tracker.ready(p.repo, p.label)) {
          if (this.items.byExternalUrl(issue.url)) continue
          const item = await this.create({
            title: issue.title,
            body: issue.body,
            repo: p.repo,
            dataset: p.profile,
            config: p.config,
            source: 'github',
            external_url: issue.url,
          })
          this.base.log(`${item.id}: imported ${p.repo}#${issue.number}`)
          created.push(item)
        }
      } catch (e) {
        errors.push(`${p.repo}: ${(e as Error).message}`)
        this.base.log(`intake ${p.repo}: ${(e as Error).message}`)
      }
    }
    this.lastIntake = { at: new Date().toISOString(), errors }
    return { created, errors }
  }

  /**
   * PR feedback. A `/tiller …` comment from a maintainer on a task's PR is the human
   * queuing a run with that message, each comment once. A merged PR completes the task, a closed
   * one cancels it. One failing PR doesn't block the others.
   */
  syncPrs(): Promise<PrSync> {
    this.syncing ??= this.doSync().finally(() => {
      this.syncing = undefined
    })
    return this.syncing
  }

  private async doSync(): Promise<PrSync> {
    const { forge } = this.deps
    if (!forge) throw new Error('no forge configured (TILLER_GITHUB_TOKEN)')
    const out: PrSync = { queued: [], closed: [], errors: [] }
    const heads = new Map<string, string>()
    for (const { item, pr } of this.items.withPr()) {
      // a running item is picked up on the next pass: its comments stay unseen until then
      if (item.state === 'RUNNING') continue
      try {
        const status = await forge.status(item.repo, pr.number)
        if (status.state === 'closed') {
          const to = status.merged ? 'COMPLETED' : 'CANCELLED'
          if (this.items.transition(item.id, CLOSABLE, to)) {
            const what = status.merged ? 'merged' : 'closed without merge'
            this.items.event(item.id, 'factory', 'pr', `PR #${pr.number} ${what} → ${to}`)
            this.base.log(`${item.id}: PR #${pr.number} ${what}`)
            out.closed.push(item.id)
            // a part queued behind this one may start now
            this.base.kick()
          }
          continue
        }
        // behind = the default branch is no longer the commit this branch started from or last
        // merged; conflict = the forge can no longer merge it
        // a failed fetch must not keep the human's comments from being read
        const head = await this.defaultHead(item.repo, heads).catch(() => undefined)
        const before = this.items.prState(item.id)?.sync
        const sync: PrSyncState | undefined = status.conflict
          ? 'conflict'
          : head === undefined
            ? undefined
            : head !== item.base_commit
              ? 'behind'
              : 'current'
        if (sync) this.items.setPrState(item.id, sync)
        if (sync === 'conflict' && before !== 'conflict')
          this.items.event(
            item.id,
            'factory',
            'pr',
            `PR #${pr.number} conflicts with the default branch: update the task to resolve it`,
          )
        // what the repository's own CI says about the commit on the PR; a failure can go back
        // to the agent (on its own with `ci.fix: auto`, else when a human asks)
        const failed = await this.syncCi(item, pr.number, status.head)
        if (failed && (this.deps.ci?.fix ?? 'ask') === 'auto') {
          const sent = await this.fixCi(item.id, 'factory').catch((e: Error) => {
            this.base.log(`${item.id}: CI failure not sent to the agent: ${e.message}`)
            return false
          })
          if (sent) {
            if (!out.queued.includes(item.id)) out.queued.push(item.id)
            continue
          }
        }
        for (const comment of await forge.comments(item.repo, pr.number)) {
          const message = feedbackMessage(comment)
          if (!message || this.items.feedbackSeen(item.id, comment.source, comment.id)) continue
          // `/tiller ci`: hand the failing CI checks to the agent
          if (/^(fix\s+)?ci\b[.!]?\s*(—.*)?$/is.test(message)) {
            this.items.recordFeedback(item.id, comment.source, comment.id)
            await forge.acknowledge(item.repo, comment).catch(() => {})
            await this.fixCi(item.id, 'human')
            this.base.log(`${item.id}: /tiller ci from ${comment.author}`)
            if (!out.queued.includes(item.id)) out.queued.push(item.id)
            break
          }
          // `/tiller update`: bring the default branch in, resolve what collides
          if (/^update\b[.!]?\s*(—.*)?$/is.test(message)) {
            this.items.recordFeedback(item.id, comment.source, comment.id)
            await forge.acknowledge(item.repo, comment).catch(() => {})
            const { result } = await this.update(item.id)
            this.base.log(`${item.id}: /tiller update from ${comment.author} → ${result}`)
            if (result !== 'current' && !out.queued.includes(item.id)) out.queued.push(item.id)
            break
          }
          if (!this.takeFeedback(item.id, comment, message)) break
          this.base.log(`${item.id}: /tiller from ${comment.author} on PR #${pr.number}`)
          if (!out.queued.includes(item.id)) out.queued.push(item.id)
          // best effort: the run is queued whether or not the reaction lands
          await forge.acknowledge(item.repo, comment).catch(() => {})
        }
      } catch (e) {
        out.errors.push(`${item.id}: ${(e as Error).message}`)
        this.base.log(`pr sync ${item.id}: ${(e as Error).message}`)
      }
    }
    if (out.queued.length) this.base.kick()
    this.lastSync = { at: new Date().toISOString(), errors: out.errors }
    return out
  }

  /** set when the forge token turned out to lack permission to read CI: not asked again */
  private ciUnreadable: string | undefined

  /**
   * Read the repository's CI for the commit on the PR and remember it; a change goes on the
   * timeline. True when CI failed on a commit whose failure has not been handed to the agent.
   */
  private async syncCi(item: WorkItem, number: number, head: string | undefined): Promise<boolean> {
    const { forge } = this.deps
    if (!forge?.ci || !head || this.deps.ci?.fix === 'off' || this.ciUnreadable) return false
    let ci: CiStatus
    try {
      ci = await forge.ci(item.repo, head)
    } catch (e) {
      // A token without permission to read CI must not stop the rest of the sync (the PR's
      // comments are read right after this): said once, then CI is left alone in this process.
      if (/not readable with this token/.test((e as Error).message)) {
        this.ciUnreadable = (e as Error).message
        this.base.log(
          `CI is not followed: the GitHub token may not read check runs or commit statuses (it needs Checks: read and Commit statuses: read; Actions: read for job logs)`,
        )
      } else this.base.log(`${item.id}: CI not read: ${(e as Error).message}`)
      return false
    }
    const before = this.items.ci(item.id)
    this.items.setCi(item.id, { head, ...ci })
    if (before?.head !== head || before.state !== ci.state) {
      const at = head.slice(0, 7)
      if (ci.state === 'failed')
        this.items.event(
          item.id,
          'factory',
          'pr',
          `CI failed on PR #${number} at ${at}: ${ci.failing.map((c) => c.name).join(', ')}`,
        )
      else if (ci.state === 'passed')
        this.items.event(item.id, 'factory', 'pr', `CI passed on PR #${number} at ${at}`)
    }
    return ci.state === 'failed' && this.items.ci(item.id)?.sent_head !== head
  }

  /**
   * Hand the failing CI checks of the task's PR to the agent: their names and the end of their
   * logs become its next message, and a run is queued. The factory's own verification passed on
   * that commit, so CI checks something verification does not (lint, types, build). Asked for by
   * a human (button, CLI, `/tiller ci`), or by the factory itself with `ci.fix: auto`, which is
   * capped: a loop of agent and CI must end with a human. Returns false when there is nothing to send.
   */
  async fixCi(id: string, by: 'human' | 'factory'): Promise<boolean> {
    const item = this.base.mustGet(id)
    const { forge } = this.deps
    const ci = this.items.ci(id)
    if (ci?.state !== 'failed') {
      if (by === 'human') throw new Error('CI has not failed on this task (sync first?)')
      return false
    }
    const max = this.deps.ci?.max_attempts ?? 2
    if (by === 'factory' && ci.attempts >= max) {
      if (ci.sent_head !== ci.head) {
        // said once per commit: the cap was reached, a human decides from here
        this.items.ciSent(id, ci.head)
        this.items.event(
          id,
          'factory',
          'state',
          `CI still fails after ${ci.attempts} automatic attempt(s): not sent to the agent again`,
        )
      }
      return false
    }
    // only what the factory pushed: commits someone else added are not the agent's to guess at
    const repo = this.base.repo(id)
    if ((await repo.exists()) && (await repo.head()) !== ci.head)
      throw new Error('the pull request is at a commit the factory did not push')
    const logs = await Promise.all(
      ci.failing.slice(0, 5).map(async (check) => ({
        check,
        log: (await forge?.ciLog?.(item.repo, check).catch(() => null)) ?? null,
      })),
    )
    if (!this.items.transition(id, ['PR_OPEN', 'REVIEW'], 'QUEUED'))
      throw new Error(`can't queue a ${item.state} task`)
    this.items.ciSent(id, ci.head)
    this.items.event(id, 'factory', 'message', ciMessage(ci.head, logs))
    this.items.event(id, by, 'enqueued', 'CI failed on the pull request')
    this.base.kick()
    return true
  }

  /**
   * Head of the repo's default branch, fetched once per pass. Uses the repo cache a task's first
   * run created; without one there is nothing to compare, and this is not the place to clone.
   */
  private async defaultHead(repo: string, seen = new Map<string, string>()): Promise<string> {
    const known = seen.get(repo)
    if (known) return known
    const cache = this.deps.workspaces.repoCache(repo)
    if (!(await exists(cache))) throw new Error(`no local copy of ${repo} yet`)
    await this.deps.workspaces.fetch(repo)
    const head = (await git(cache, 'rev-parse', '--verify', 'origin/HEAD^{commit}')).trim()
    seen.set(repo, head)
    return head
  }

  /**
   * Bring the default branch into a task whose base moved (a human asks for it: button, CLI or
   * `/tiller update`). The factory merges with its own git. No collision: verify and push, no
   * agent involved. Collision: the files keep their conflict markers and the agent resolves them
   * in its next run, which then goes through verification like any other. `done` settles when
   * the factory's own part (verify and push of a clean merge) is over.
   */
  async update(
    id: string,
  ): Promise<{ result: 'current' | 'merged' | 'conflict'; done: Promise<void> }> {
    const item = this.base.mustGet(id)
    const repo = this.base.repo(id)
    if (!(await repo.exists()))
      throw new Error('the task has not run yet: there is nothing to update')
    const head = await this.defaultHead(item.repo)
    if (head === item.base_commit) {
      this.items.setPrState(id, 'current')
      return { result: 'current', done: Promise.resolve() }
    }
    if (!this.items.transition(id, UPDATABLE, 'RUNNING'))
      throw new Error(`can't update a ${item.state} task`)
    const from = `${item.base_commit.slice(0, 8)} → ${head.slice(0, 8)}`
    try {
      // anything left uncommitted in the workspace would make git refuse the merge
      await repo.commitAll(`tiller: ${id} before update`)
      await repo.fetch(this.deps.workspaces.repoCache(item.repo), head)
      const merged = await repo.merge(head, `tiller: ${id} update from the default branch`)
      // from here the branch is measured against the new base: diff, verification baseline, PR state
      this.items.setBase(id, head)
      await rm(join(repo.holder, 'baseline.json'), { force: true })
      if ('conflicts' in merged) {
        const files = merged.conflicts
        this.items.event(
          id,
          'factory',
          'state',
          `update ${from}: ${files.length} file(s) conflict; queued for the agent`,
        )
        this.items.event(id, 'factory', 'message', conflictMessage(head, files))
        this.items.transition(id, ['RUNNING'], 'QUEUED')
        this.items.event(id, 'human', 'enqueued', 'update from the default branch')
        this.base.kick()
        return { result: 'conflict', done: Promise.resolve() }
      }
      this.items.event(id, 'factory', 'state', `update ${from}: merged without conflicts`)
    } catch (e) {
      this.items.transition(id, ['RUNNING'], 'FAILED')
      this.items.event(
        id,
        'factory',
        'state',
        `update failed: ${(e as Error).message.slice(0, 500)}`,
      )
      throw e
    }
    // verify and push in the background of this process; the task shows as running meanwhile
    this.base.active.add(id)
    const done = this.publishUpdate(this.base.mustGet(id), head)
      .catch((e: Error) => {
        this.items.transition(id, ['RUNNING'], 'FAILED')
        this.items.event(id, 'factory', 'state', `update failed: ${e.message.slice(0, 500)}`)
        this.base.log(`${id}: update failed: ${e.message}`)
      })
      .finally(() => this.base.active.delete(id))
    return { result: 'merged', done }
  }

  /** A clean merge of the default branch: verify the result, push it, tell the PR. No agent run. */
  private async publishUpdate(item: WorkItem, base: string) {
    const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)
    const dir = await this.items.store.runDir(
      `${item.id}-update-${stamp}-${randomUUID().slice(0, 6)}`,
    )
    const what = `update to ${base.slice(0, 8)}`
    const d = await this.delivery.deliver(item, { label: what, dir }, '', (m) =>
      this.base.log(`${item.id}: ${m}`),
    )
    // merged cleanly as text but the tests say otherwise: that is a conflict too, and the human
    // asked for an updated task, so it goes to the agent like one
    const broken = !d.pushed && verificationVerdict(d.note) === 'fail'
    if (broken) {
      this.items.event(item.id, 'factory', 'message', brokenMergeMessage(base, d.note))
      this.items.transition(item.id, ['RUNNING'], 'QUEUED')
      this.items.event(item.id, 'human', 'enqueued', 'update from the default branch')
      this.base.kick()
    } else this.items.transition(item.id, ['RUNNING'], d.pushed ? 'PR_OPEN' : 'REVIEW')
    if (d.pushed) this.items.setPrState(item.id, 'current')
    const pr = this.items.pr(item.id)
    const next = broken
      ? 'The agent is queued to make the change work on the new default branch.'
      : 'Comment `/tiller <instructions>` to have the agent look at it.'
    if (pr && this.deps.forge) {
      const body = d.pushed
        ? `**Updated from the default branch** (${base.slice(0, 7)}): merged without conflicts.\n\n${checks(d)}`
        : `**Update from the default branch (${base.slice(0, 7)}) merged without conflicts but was not pushed.**\n\n${checks(d)}\n\n${next}`
      await this.deps.forge
        .comment(item.repo, pr.number, `${body}\n\n— codetiller · ${item.id}`)
        .catch((e: Error) =>
          this.items.event(
            item.id,
            'factory',
            'pr',
            `PR comment failed: ${e.message.slice(0, 300)}`,
          ),
        )
    }
    this.base.log(`${item.id}: ${what} → ${this.base.mustGet(item.id).state}`)
  }

  /**
   * A human asks for the branch to be verified again, without an agent run: after a flaky suite,
   * or to accept tests the change removed. With `acceptRemoved` the tests the last verification
   * found removed stop failing this task's verification; that is a human's call, never the
   * agent's. A verified branch is pushed as after a run. `done` settles when that is over.
   */
  async verifyAgain(
    id: string,
    opts: { acceptRemoved?: boolean; acceptChecks?: boolean } = {},
  ): Promise<{ accepted: string[]; done: Promise<void> }> {
    const item = this.base.mustGet(id)
    const repo = this.base.repo(id)
    if (!(await repo.exists())) throw new Error('the task has not run yet: nothing to verify')
    if (!this.items.transition(id, VERIFIABLE, 'RUNNING'))
      throw new Error(`can't verify a ${item.state} task`)
    let accepted: string[] = []
    try {
      if (opts.acceptRemoved) {
        accepted = await acceptRemoved(repo.holder)
        if (!accepted.length) throw new Error('the last verification found no removed tests')
        const names = accepted.slice(0, 10).map((t) => `- ${t}`)
        const more = accepted.length > 10 ? [`- … ${accepted.length - 10} more`] : []
        const head = `accepted: ${accepted.length} test(s) that no longer run may go`
        this.items.event(id, 'human', 'verification', [head, ...names, ...more].join('\n'))
      }
      if (opts.acceptChecks) {
        // the changed test configuration is fine by a human: no second run with the old one
        const files = await acceptChecks(repo.holder)
        if (!files.length) throw new Error('the last verification named no changed check files')
        accepted = [...accepted, ...files]
        const head = `accepted: ${files.length} changed file(s) that decide how the change is checked`
        this.items.event(
          id,
          'human',
          'verification',
          [head, ...files.slice(0, 20).map((f) => `- ${f}`)].join('\n'),
        )
      }
    } catch (e) {
      this.items.transition(id, ['RUNNING'], item.state)
      throw e
    }
    this.base.active.add(id)
    const done = (async () => {
      const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)
      const dir = await this.items.store.runDir(`${id}-verify-${stamp}-${randomUUID().slice(0, 6)}`)
      const d = await this.delivery.deliver(item, { label: 'verified branch', dir }, '', (m) =>
        this.base.log(`${id}: ${m}`),
      )
      this.items.transition(id, ['RUNNING'], d.pushed ? 'PR_OPEN' : 'REVIEW')
      const pr = this.items.pr(id)
      if (pr)
        await this.delivery.reply(
          item,
          pr.number,
          `**Verified again${accepted.length ? `, ${accepted.length} removed test(s) accepted by a human` : ''}.**${d.pushed ? '' : ' Nothing pushed.'}\n\n${checks(d)}\n\n— codetiller · ${id}`,
          undefined,
        )
      this.base.log(`${id}: verified again → ${this.base.mustGet(id).state}`)
    })()
      .catch((e: Error) => {
        this.items.transition(id, ['RUNNING'], 'FAILED')
        this.items.event(
          id,
          'factory',
          'state',
          `verification failed to run: ${e.message.slice(0, 500)}`,
        )
      })
      .finally(() => this.base.active.delete(id))
    return { accepted, done }
  }

  /**
   * Record one PR comment as the human's message and queue the item, atomically. false when the
   * item can't take it now (a run started meanwhile): the comment stays unseen for the next pass.
   */
  private takeFeedback(id: string, comment: PrComment, message: string): boolean {
    return this.items.store.db.transaction(() => {
      const state = this.base.mustGet(id).state
      if (state !== 'QUEUED') {
        if (!this.items.transition(id, QUEUEABLE, 'QUEUED')) return false
      }
      this.items.recordFeedback(id, comment.source, comment.id)
      this.items.event(id, 'human', 'message', message)
      // an already queued run simply gets one more message
      if (state !== 'QUEUED')
        this.items.event(id, 'human', 'enqueued', `PR comment by ${comment.author}`)
      return true
    })()
  }
}

/** states in which a human may have the branch verified again: it exists and no run is in flight */
const VERIFIABLE: readonly WorkItem['state'][] = ['REVIEW', 'PR_OPEN', 'FAILED']

/** states from which a task's branch may be updated: it exists and no run is in flight */
const UPDATABLE: readonly WorkItem['state'][] = ['WAITING_FOR_HUMAN', 'REVIEW', 'PR_OPEN', 'FAILED']
