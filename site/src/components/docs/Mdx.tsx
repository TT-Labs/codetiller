import { evaluate } from '@mdx-js/mdx'
import rehypeShiki from '@shikijs/rehype'
import { getTranslations } from 'next-intl/server'
import type { ComponentProps, ReactNode } from 'react'
import * as runtime from 'react/jsx-runtime'
import rehypeSlug from 'rehype-slug'
import remarkGfm from 'remark-gfm'
import { Link } from '@/i18n/navigation'
import { SHIKI_THEMES } from '@/lib/highlight'
import { CopyButton } from '../ui/CopyButton'

function Anchor({ href = '', children, ...props }: ComponentProps<'a'>) {
  if (href.startsWith('/'))
    return (
      <Link href={href} {...props}>
        {children}
      </Link>
    )
  if (href.startsWith('#'))
    return (
      <a href={href} {...props}>
        {children}
      </a>
    )
  return (
    <a href={href} target="_blank" rel="noreferrer" {...props}>
      {children}
    </a>
  )
}

function Pre(props: ComponentProps<'pre'>) {
  return (
    <div data-copy-scope className="codeblock group relative">
      <pre {...props} />
      <CopyButton className="absolute top-2.5 right-2.5 opacity-100 transition-opacity sm:opacity-0 sm:group-focus-within:opacity-100 sm:group-hover:opacity-100" />
    </div>
  )
}

function Table(props: ComponentProps<'table'>) {
  return (
    // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region has to be reachable by keyboard
    <div className="tablewrap" tabIndex={0}>
      <table {...props} />
    </div>
  )
}

/** `<Callout type="note" title="…">`: a limit, something not built yet, a warning. */
function Callout({
  type = 'note',
  title,
  children,
}: {
  type?: 'note' | 'warn'
  title?: string
  children: ReactNode
}) {
  return (
    <aside className="callout" data-type={type}>
      {title && (
        <p className={`label mb-1.5 ${type === 'warn' ? 'text-warn' : 'text-signal-ink'}`}>
          {title}
        </p>
      )}
      {children}
    </aside>
  )
}

/** A docs page: MDX compiled on the server, at build time. */
export async function Mdx({ source }: { source: string }) {
  const t = await getTranslations('ui.docs')

  const heading = (Tag: 'h2' | 'h3') =>
    function Heading({ id, children, ...props }: ComponentProps<'h2'>) {
      return (
        <Tag id={id} {...props}>
          {children}
          {id && (
            <a href={`#${id}`} className="anchor" aria-label={t('anchor')}>
              #
            </a>
          )}
        </Tag>
      )
    }

  const { default: Content } = await evaluate(source, {
    ...runtime,
    remarkPlugins: [remarkGfm],
    rehypePlugins: [
      rehypeSlug,
      [rehypeShiki, { themes: SHIKI_THEMES, defaultColor: false, fallbackLanguage: 'text' }],
    ],
  })

  return (
    <Content
      components={{
        a: Anchor,
        pre: Pre,
        table: Table,
        h2: heading('h2'),
        h3: heading('h3'),
        Callout,
      }}
    />
  )
}
