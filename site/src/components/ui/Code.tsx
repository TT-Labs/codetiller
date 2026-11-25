import clsx from 'clsx'
import { highlight } from '@/lib/highlight'
import { CopyButton } from './CopyButton'

/** A highlighted code block rendered on the server, with a copy button. */
export async function Code({
  code,
  lang = 'bash',
  className,
}: {
  code: string
  lang?: string
  className?: string
}) {
  const html = await highlight(code, lang)
  return (
    <div data-copy-scope className={clsx('codeblock group relative', className)}>
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: shiki's output for our own code */}
      <div dangerouslySetInnerHTML={{ __html: html }} />
      <CopyButton className="absolute top-2.5 right-2.5 opacity-100 transition-opacity sm:opacity-0 sm:group-focus-within:opacity-100 sm:group-hover:opacity-100" />
    </div>
  )
}
