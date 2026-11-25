import type { PrComment } from './forge.js'

// the command must open the comment: quoting it later in a sentence starts nothing
const COMMAND = /^\s*\/tiller(?:\s+|$)/i

/** GitHub author_association values that mean "may push to this repo". */
const MAINTAINERS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR'])

/**
 * A PR comment that starts with `/tiller` and comes from a maintainer is the human
 * queuing a run; returns its message for the agent. Anything else (other comments, the factory's
 * own replies, commands from outsiders: their text must never reach the agent) is undefined.
 */
export function feedbackMessage(c: PrComment): string | undefined {
  if (!MAINTAINERS.has(c.association) || !COMMAND.test(c.body)) return undefined
  const text = c.body.replace(COMMAND, '').trim() || 'Continue where you left off.'
  if (!c.path) return text
  return `On \`${c.path}\`${c.line ? ` line ${c.line}` : ''}:\n\n${text}`
}
