import { clsx } from 'clsx'
import { EmptyState } from './ui/states'

type Kind = 'file' | 'hunk' | 'add' | 'del' | 'meta' | 'ctx'

function kind(line: string): Kind {
  if (line.startsWith('diff --git')) return 'file'
  if (line.startsWith('@@')) return 'hunk'
  if (line.startsWith('+++') || line.startsWith('---')) return 'meta'
  if (line.startsWith('+')) return 'add'
  if (line.startsWith('-')) return 'del'
  return 'ctx'
}

export const DIFF_LINE: Record<Kind, string> = {
  file: 'mt-3 border-line border-y bg-subtle py-1 font-semibold text-fg first:mt-0 first:border-t-0',
  hunk: 'bg-diff-hunk text-fg-subtle',
  add: 'bg-diff-add',
  del: 'bg-diff-del',
  meta: 'text-fg-subtle',
  ctx: '',
}

/** Unified diff with per-line colouring; one <pre> keeps copy/paste intact. */
export function Diff({ text }: { text: string }) {
  if (!text.trim()) return <EmptyState title="Empty diff">The agent changed nothing.</EmptyState>
  const lines = text.replace(/\n$/, '').split('\n')
  const kinds = lines.map(kind)
  const count = (k: Kind) => kinds.filter((x) => x === k).length
  const files = count('file')
  return (
    <div className="overflow-hidden rounded-lg border border-line bg-surface shadow-xs">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-line border-b px-3 py-2 text-xs">
        {files ? (
          <span className="text-fg-muted">
            {files} {files === 1 ? 'file' : 'files'} changed
          </span>
        ) : null}
        <span className="font-mono text-success">+{count('add')}</span>
        <span className="font-mono text-danger">−{count('del')}</span>
      </div>
      <pre className="max-h-[75vh] overflow-auto bg-code py-2 font-mono text-fg text-xs leading-5">
        <code className="block w-max min-w-full">
          {lines.map((line, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static lines
            <span key={i} className={clsx('block px-3', DIFF_LINE[kinds[i] ?? 'ctx'])}>
              {line}
              {'\n'}
            </span>
          ))}
        </code>
      </pre>
    </div>
  )
}
