// shells phrase it differently: "sh: 1: python3: not found", "bash: jq: command not found",
// "zsh: command not found: rg"
const PATTERNS = [
  /(?:^|[\s"\\n])(?:\/bin\/)?(?:sh|bash|dash)(?:: line \d+|: \d+)?: ([A-Za-z0-9_.+-]+): (?:command )?not found/g,
  /command not found: ([A-Za-z0-9_.+-]+)/g,
]

/**
 * Commands the agent tried that the sandbox image doesn't have, with counts, most frequent first.
 * Works on the raw transcript (any harness): a missing tool costs turns, so it is a sandbox defect
 * worth surfacing, not agent noise.
 */
export function missingCommands(transcript: string): { command: string; count: number }[] {
  const counts = new Map<string, number>()
  for (const re of PATTERNS) {
    for (const m of transcript.matchAll(re)) {
      const command = m[1] as string
      counts.set(command, (counts.get(command) ?? 0) + 1)
    }
  }
  return [...counts]
    .map(([command, count]) => ({ command, count }))
    .sort((a, b) => b.count - a.count || a.command.localeCompare(b.command))
}
