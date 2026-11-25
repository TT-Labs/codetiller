import { clsx } from 'clsx'
import { type ReactNode, useMemo, useState } from 'react'
import type { TranscriptEvent } from '../api'
import { DIFF_LINE } from './Diff'
import { Markdown } from './Markdown'
import { Badge } from './ui/Badge'
import { ChevronRight } from './ui/icons'
import { CodeBlock } from './ui/states'

type ToolCall = Extract<TranscriptEvent, { kind: 'tool_call' }>
type ToolResult = Extract<TranscriptEvent, { kind: 'tool_result' }>

/** One-line summary of a tool call's input for the common Claude Code tools. */
function summarize(call: ToolCall): string {
  const i = (call.input ?? {}) as Record<string, unknown>
  const s = (k: string) => (typeof i[k] === 'string' ? (i[k] as string) : undefined)
  return (
    s('command') ??
    s('file_path') ??
    s('pattern') ??
    s('path') ??
    s('description') ??
    s('url') ??
    JSON.stringify(call.input)
  )
}

function Label({ children }: { children: ReactNode }) {
  return (
    <div className="mb-1 font-medium text-11 text-fg-subtle uppercase tracking-wider">
      {children}
    </div>
  )
}

function ToolCallCard({ call, result }: { call: ToolCall; result?: ToolResult }) {
  const [open, setOpen] = useState(false)
  const input = call.input as Record<string, unknown> | undefined
  const isEdit = call.name === 'Edit' && input && 'old_string' in input
  const failed = result?.is_error
  return (
    <div
      className={clsx(
        'overflow-hidden rounded-md border bg-surface',
        failed ? 'border-danger-line' : 'border-line',
      )}
    >
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex w-full items-center gap-3 px-3 py-1.5 text-left transition-colors hover:bg-hover"
      >
        <ChevronRight
          className={clsx(
            'size-3.5 shrink-0 text-fg-subtle transition-transform',
            open && 'rotate-90',
          )}
        />
        <span className="shrink-0 font-medium font-mono text-fg text-xs">{call.name}</span>
        <code className="min-w-0 flex-1 truncate font-mono text-fg-muted text-xs">
          {summarize(call)}
        </code>
        {result ? (
          failed ? (
            <Badge tone="danger">error</Badge>
          ) : null
        ) : (
          <span className="shrink-0 text-fg-subtle text-xs">no result</span>
        )}
      </button>
      {open ? (
        <div className="space-y-3 border-line border-t px-3 py-3">
          <div>
            <Label>Input</Label>
            {isEdit ? (
              <CodeBlock className="max-h-[420px] px-0">
                <code className="block w-max min-w-full">
                  <span className={clsx('block px-3', DIFF_LINE.del)}>
                    {String(input.old_string)}
                    {'\n'}
                  </span>
                  <span className={clsx('block px-3', DIFF_LINE.add)}>
                    {String(input.new_string)}
                  </span>
                </code>
              </CodeBlock>
            ) : (
              <CodeBlock className="max-h-[420px]">{JSON.stringify(call.input, null, 2)}</CodeBlock>
            )}
          </div>
          {result ? (
            <div>
              <Label>{failed ? 'Output · error' : 'Output'}</Label>
              <CodeBlock muted className="max-h-[420px]">
                {result.output || '(empty output)'}
              </CodeBlock>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

/** centered rule for session start / end */
function Divider({ danger, children }: { danger?: boolean; children: ReactNode }) {
  return (
    <div
      className={clsx(
        'flex items-center gap-3 py-1 text-xs',
        danger ? 'text-danger' : 'text-fg-subtle',
      )}
    >
      <span className="h-px flex-1 bg-line" />
      <span className="text-center">{children}</span>
      <span className="h-px flex-1 bg-line" />
    </div>
  )
}

/** Conversation timeline: messages in order, each tool call paired with its result. */
export function Transcript({ events }: { events: TranscriptEvent[] }) {
  const [showThinking, setShowThinking] = useState(false)
  const results = useMemo(() => {
    const m = new Map<string, ToolResult>()
    for (const e of events) if (e.kind === 'tool_result') m.set(e.id, e)
    return m
  }, [events])
  const calls = events.filter((e) => e.kind === 'tool_call').length
  const hasThinking = events.some((e) => e.kind === 'thinking')

  return (
    <div className="flex max-w-5xl flex-col gap-2">
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="text-fg-subtle tabular-nums">{calls} tool calls</span>
        {hasThinking ? (
          <label className="flex items-center gap-2 text-fg-muted">
            <input
              type="checkbox"
              className="size-3.5"
              checked={showThinking}
              onChange={(e) => setShowThinking(e.target.checked)}
            />
            show thinking
          </label>
        ) : null}
      </div>
      {events.map((e, i) => {
        const key = `${e.kind}-${i}`
        switch (e.kind) {
          case 'init':
            return (
              <Divider key={key}>
                session start · {e.model ?? 'unknown model'} · {e.tools.length} tools
              </Divider>
            )
          case 'text':
            return (
              <div
                key={key}
                className={clsx(
                  'rounded-md border border-line px-4 py-3',
                  e.role === 'assistant' ? 'bg-surface' : 'bg-subtle',
                )}
              >
                <Label>{e.role === 'assistant' ? 'agent' : 'user'}</Label>
                {e.role === 'assistant' ? (
                  <Markdown>{e.text}</Markdown>
                ) : (
                  <div className="whitespace-pre-wrap break-words text-fg leading-relaxed">
                    {e.text}
                  </div>
                )}
              </div>
            )
          case 'thinking':
            return showThinking ? (
              <div
                key={key}
                className="whitespace-pre-wrap break-words border-line-strong border-l-2 py-1 pl-4 text-13 text-fg-muted italic"
              >
                {e.text}
              </div>
            ) : null
          case 'tool_call':
            return <ToolCallCard key={key} call={e} result={results.get(e.id)} />
          case 'tool_result':
            return null // rendered with its call
          case 'result':
            return (
              <Divider key={key} danger={!e.ok}>
                session end · {e.ok ? 'ok' : 'error'}
                {e.turns !== undefined ? ` · ${e.turns} turns` : ''}
                {e.cost_usd !== undefined ? ` · $${e.cost_usd.toFixed(3)}` : ''}
              </Divider>
            )
          default:
            return null
        }
      })}
    </div>
  )
}
