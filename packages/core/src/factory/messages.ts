import type { CiCheck } from './forge.js'
import { forgeSafe } from './forge-text.js'
import type { WorkItem } from './model.js'
import { type Verification, verificationSummary } from './verify.js'

/** Normalized task context for the agent: text only, never tracker credentials. */
export function issueText(item: WorkItem, messages: string[], questions: string[] = []): string {
  // what the preflight asked, so the human's answers below make sense to the implementing agent
  const asked = questions.length
    ? `\n\n## Questions raised before the run\n\n${questions.map((q, i) => `${i + 1}. ${q}`).join('\n')}`
    : ''
  const extra = messages.length
    ? `\n\n## Additional instructions from the human\n\n${messages.join('\n\n')}`
    : ''
  return `# ${item.title}\n\n${item.body}${asked}${extra}`
}

/** What the agent is told when the repository's CI failed on the commit it delivered. */
export function ciMessage(head: string, logs: { check: CiCheck; log: string | null }[]): string {
  return [
    `CI failed on the pull request for the commit you delivered (${head.slice(0, 7)}). The factory's own verification passed on it, so the failing checks run something verification does not (for example lint, a type check, a build). Failing checks: ${logs.map((l) => l.check.name).join(', ')}.`,
    ...logs.map(({ check, log }) =>
      log
        ? `### ${check.name}: the end of its log\n\n\`\`\`\n${log.slice(-6000)}\n\`\`\``
        : `### ${check.name}\n\nIts log is not available here${check.url ? ` (${check.url})` : ''}. Work out from the repository's CI configuration what this check runs.`,
    ),
    'Fix what the checks complain about. Run the same commands yourself where the sandbox allows it (it has no network), then finish as usual.',
  ].join('\n\n')
}

/** What the agent is told when the factory's merge of the default branch left conflicts. */
export function conflictMessage(base: string, files: string[]): string {
  return [
    `The default branch moved while this task was open. The factory merged it (${base.slice(0, 8)}) into your branch and these files have conflicts:`,
    files.map((f) => `- ${f}`).join('\n'),
    'The files contain conflict markers (`<<<<<<<`, `=======`, `>>>>>>>`). Resolve every one so that both your change and what the default branch changed keep working, then run the checks.',
    'The git repository in /workspace is a scratch copy and does not show this merge: work on the files, do not use git to resolve it. Other files changed too, because the default branch moved; that is expected.',
  ].join('\n\n')
}

/** What the agent is told when the default branch merged without conflicts but the tests now fail. */
export function brokenMergeMessage(base: string, verdict: string): string {
  return [
    `The default branch moved while this task was open. The factory merged it (${base.slice(0, 8)}) into your branch. There were no textual conflicts, but verification of the merged result fails:`,
    verdict,
    'Make your change work on top of the new default branch (the code around it changed), then run the checks. The git repository in /workspace is a scratch copy and does not show this merge.',
  ].join('\n\n')
}

/** The factory's checks as a PR section: the verification verdict and, if there is one, the second reader's word. */
export function checks(d: { note: string; reading?: string }): string {
  // test names, paths and the reader's text all come from agents: neutralized like their other text
  return [
    `## Verification\n\n${forgeSafe(d.note)}`,
    ...(d.reading ? [`## Second reader\n\n${forgeSafe(d.reading)}`] : []),
  ].join('\n\n')
}

export function prBody(item: WorkItem, summary: string, v: Verification, reading?: string): string {
  return [
    forgeSafe(summary) || '(agent gave no summary)',
    checks({ note: verificationSummary(v), reading }),
    // what the verdict is worth: the suite ran the agent's own code and tests
    "Verification ran the repository's tests on this change in a sandbox, against the tests that passed before it. It says the tests still run and pass, not that the change is right: the diff is what you review.",
    `Opened by codetiller for ${item.id}; merge is a human decision.${issueRef(item)}`,
  ].join('\n\n')
}

/** `Closes #N` for an issue of the same repo (GitHub links and closes it on merge), else a link. */
export function issueRef(item: Pick<WorkItem, 'repo' | 'external_url'>): string {
  if (!item.external_url) return ''
  const own = item.external_url.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/issues\/(\d+)$/)
  return own && own[1] === item.repo ? `\n\nCloses #${own[2]}` : `\n\nTask: ${item.external_url}`
}
