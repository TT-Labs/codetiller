import type { Config } from '../config/config.js'

type Harness = Config['harness']

/**
 * Harness-agnostic conversation model for viewers (dashboard, reports, improve evidence).
 * Each harness adapter maps its raw transcript to these events; consumers never parse raw formats.
 */
export type TranscriptEvent =
  | { kind: 'init'; model?: string; tools: string[]; cwd?: string; session_id?: string }
  | { kind: 'text'; role: 'assistant' | 'user'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool_call'; id: string; name: string; input: unknown }
  | { kind: 'tool_result'; id: string; output: string; is_error: boolean }
  | {
      kind: 'result'
      ok: boolean
      text?: string
      cost_usd?: number
      turns?: number
      duration_ms?: number
      usage?: Record<string, unknown>
    }

export type TranscriptParser = (raw: string) => TranscriptEvent[]

const jsonLines = (raw: string) =>
  raw.split('\n').flatMap((line) => {
    try {
      return line.trim() ? [JSON.parse(line) as Record<string, unknown>] : []
    } catch {
      return [] // non-JSON noise from the container
    }
  })

type Block = { type: string; [k: string]: unknown }

const resultText = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map((c: Block) => (c.type === 'text' ? String(c.text) : `[${c.type}]`)).join('\n')
      : ''

/** Claude Code `--output-format stream-json --verbose`. Progress/heartbeat events are dropped. */
export const parseClaudeCodeTranscript: TranscriptParser = (raw) => {
  const out: TranscriptEvent[] = []
  for (const ev of jsonLines(raw)) {
    if (ev.type === 'system' && ev.subtype === 'init') {
      out.push({
        kind: 'init',
        model: ev.model as string | undefined,
        tools: (ev.tools as string[] | undefined) ?? [],
        cwd: ev.cwd as string | undefined,
        session_id: ev.session_id as string | undefined,
      })
    } else if (ev.type === 'assistant' || ev.type === 'user') {
      const msg = ev.message as { content?: unknown } | undefined
      const blocks: Block[] =
        typeof msg?.content === 'string'
          ? [{ type: 'text', text: msg.content }]
          : ((msg?.content as Block[] | undefined) ?? [])
      for (const b of blocks) {
        if (b.type === 'text' && String(b.text).trim())
          out.push({ kind: 'text', role: ev.type, text: String(b.text) })
        else if (b.type === 'thinking' && String(b.thinking ?? '').trim())
          out.push({ kind: 'thinking', text: String(b.thinking) })
        else if (b.type === 'tool_use')
          out.push({ kind: 'tool_call', id: String(b.id), name: String(b.name), input: b.input })
        else if (b.type === 'tool_result')
          out.push({
            kind: 'tool_result',
            id: String(b.tool_use_id),
            output: resultText(b.content),
            is_error: b.is_error === true,
          })
      }
    } else if (ev.type === 'result') {
      out.push({
        kind: 'result',
        ok: ev.is_error !== true && ev.subtype === 'success',
        text: ev.result as string | undefined,
        cost_usd: ev.total_cost_usd as number | undefined,
        turns: ev.num_turns as number | undefined,
        duration_ms: ev.duration_ms as number | undefined,
        usage: ev.usage as Record<string, unknown> | undefined,
      })
    }
  }
  return out
}

const parsers: Partial<Record<Harness, TranscriptParser>> = {
  'claude-code': parseClaudeCodeTranscript,
}

export function parseTranscript(harness: Harness, raw: string): TranscriptEvent[] {
  const p = parsers[harness]
  if (!p) throw new Error(`no transcript parser for harness ${harness}`)
  return p(raw)
}
