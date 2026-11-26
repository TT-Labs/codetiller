import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Config } from '../../config/config.js'
import type { RunRecord, Store } from '../../store/store.js'
import { processMetrics } from '../../transcript/metrics.js'
import { missingCommands } from '../../transcript/missing.js'
import { parseTranscript } from '../../transcript/transcript.js'
import type { RunRow } from './compare.js'

/**
 * Comparison rows with process metrics: stored run numbers plus what the transcript shows. Derived
 * on read (not stored) so a changed metric definition applies to old runs too.
 */
export async function loadRunRows(store: Store, runs: RunRecord[]): Promise<RunRow[]> {
  const harness = new Map<string, Config['harness'] | undefined>()
  return Promise.all(
    runs.map(async (r) => {
      if (!harness.has(r.config_id))
        harness.set(r.config_id, store.getConfig(r.config_id)?.harness as Config['harness'])
      const metrics: Record<string, number | null> = {
        cost_usd: r.cost_usd,
        duration_s: r.duration_s,
        turns: r.turns,
        output_tokens: r.output_tokens,
        diff_lines: r.diff_lines,
      }
      // hidden-test progress is graded, unlike the all-or-nothing outcome: an unverified run
      // (no patch, timeout) fixed nothing
      const checks = store.runChecks(r.id)
      const f2p = checks.find((c) => c.name === 'fail_to_pass')
      const p2p = checks.find((c) => c.name === 'pass_to_pass')
      metrics.f2p_share = f2p?.total ? 1 - (f2p.failed ?? 0) / f2p.total : 0
      metrics.regressions = p2p ? (p2p.failed ?? 0) : null
      const raw = await readFile(join(store.artifactsDir, r.id, 'transcript.jsonl'), 'utf8').catch(
        () => null,
      )
      const h = harness.get(r.config_id)
      if (raw !== null && h) {
        try {
          Object.assign(metrics, processMetrics(parseTranscript(h, raw)))
        } catch {
          // harness without a transcript parser: stored numbers only
        }
        metrics.missing_commands = missingCommands(raw).reduce((s, m) => s + m.count, 0)
      }
      return {
        task_id: r.task_id,
        outcome: r.outcome,
        cost_usd: r.cost_usd,
        duration_s: r.duration_s,
        metrics,
      }
    }),
  )
}
