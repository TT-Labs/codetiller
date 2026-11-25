import { clsx } from 'clsx'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

// Agent and issue text is untrusted: react-markdown renders no raw HTML and drops unsafe URLs.
// Elements are styled here, with the app's tokens, so prose looks like the rest of the UI.
const COMPONENTS: Components = {
  h1: (p) => <h3 className="mt-4 mb-1.5 font-semibold text-base text-fg first:mt-0" {...p} />,
  h2: (p) => <h3 className="mt-4 mb-1.5 font-semibold text-fg text-sm first:mt-0" {...p} />,
  h3: (p) => <h4 className="mt-3 mb-1 font-semibold text-fg text-sm first:mt-0" {...p} />,
  h4: (p) => <h5 className="mt-3 mb-1 font-semibold text-13 text-fg-muted first:mt-0" {...p} />,
  p: (p) => <p className="my-2 first:mt-0 last:mb-0" {...p} />,
  ul: (p) => <ul className="my-2 list-disc space-y-1 pl-5 marker:text-fg-subtle" {...p} />,
  ol: (p) => <ol className="my-2 list-decimal space-y-1 pl-5 marker:text-fg-subtle" {...p} />,
  li: (p) => <li className="[&>p]:my-1" {...p} />,
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer" className="text-accent-text hover:underline">
      {children}
    </a>
  ),
  code: ({ className, children }) => (
    // a fenced block arrives as <pre><code class="language-…">; everything else is inline
    <code
      className={clsx(
        'font-mono',
        className?.startsWith('language-')
          ? 'text-xs'
          : 'rounded border border-line bg-subtle px-1 py-px text-[0.85em] [pre_&]:border-0 [pre_&]:bg-transparent [pre_&]:p-0 [pre_&]:text-xs',
      )}
    >
      {children}
    </code>
  ),
  pre: (p) => (
    <pre
      className="my-2 overflow-x-auto rounded-md border border-line bg-code px-3 py-2.5 leading-5"
      {...p}
    />
  ),
  blockquote: (p) => (
    <blockquote className="my-2 border-line-strong border-l-2 pl-3 text-fg-muted" {...p} />
  ),
  hr: () => <hr className="my-3 border-line" />,
  table: (p) => (
    <div className="my-2 overflow-x-auto">
      <table className="border-collapse text-13" {...p} />
    </div>
  ),
  th: (p) => (
    <th className="border border-line bg-subtle px-2 py-1 text-left font-semibold" {...p} />
  ),
  td: (p) => <td className="border border-line px-2 py-1 align-top" {...p} />,
  input: (p) => <input {...p} className="mr-1.5 align-middle" />,
  // never fetch an image named by agent or issue text: the URL itself can carry data out through
  // the reader's browser. Show where it points; opening it is the reader's decision.
  img: ({ src, alt }) => (
    <span className="text-fg-muted">
      [image{alt ? `: ${alt}` : ''}
      {typeof src === 'string' ? ` · ${src}` : ''}]
    </span>
  ),
}

/** Markdown as agents and issues write it (GFM: lists, code, tables, task lists). */
export function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <div className={clsx('min-w-0 break-words text-fg leading-relaxed', className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
        {children}
      </ReactMarkdown>
    </div>
  )
}
