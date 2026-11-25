import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { hasLocale } from 'next-intl'
import { getTranslations } from 'next-intl/server'
import { Mdx } from '@/components/docs/Mdx'
import { Toc } from '@/components/docs/Toc'
import { ArrowRight, ArrowUpRight } from '@/components/ui/icons'
import { localeOf } from '@/i18n/locale'
import { getPathname, Link } from '@/i18n/navigation'
import { routing } from '@/i18n/routing'
import { loadDoc, loadNav, neighbours, SLUGS } from '@/lib/docs'
import { site } from '@/site.config'

interface Props {
  params: Promise<{ locale: string; slug?: string[] }>
}

// every page is known at build time; anything else is a 404
export const dynamicParams = false

export function generateStaticParams() {
  return SLUGS.map((slug) => ({ slug: slug === 'index' ? [] : [slug] }))
}

const slugOf = (slug?: string[]) => (slug?.length ? slug.join('/') : 'index')

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale, slug } = await params
  if (!hasLocale(routing.locales, locale)) return {}
  const doc = await loadDoc(locale, slugOf(slug))
  if (!doc) return {}
  const t = await getTranslations({ locale, namespace: 'meta' })
  const title = doc.slug === 'index' ? t('docsTitle') : doc.title
  return {
    title,
    description: doc.description,
    alternates: { canonical: getPathname({ locale, href: doc.href }) },
    // a page's own openGraph replaces the site's, the link card included: name it again
    openGraph: {
      type: 'article',
      siteName: site.name,
      title,
      description: doc.description,
      images: [{ url: '/opengraph-image', width: 1200, height: 630, alt: site.name }],
    },
  }
}

export default async function DocPage({ params }: Props) {
  const locale = await localeOf(params)
  const { slug } = await params
  const doc = await loadDoc(locale, slugOf(slug))
  if (!doc) notFound()

  const t = await getTranslations('ui.docs')
  const nav = await loadNav(locale)
  const group = nav.find((g) => g.pages.some((p) => p.slug === doc.slug))
  const { previous, next } = await neighbours(locale, doc.slug)

  return (
    <div className="min-w-0 xl:grid xl:grid-cols-[minmax(0,1fr)_15rem]">
      <main className="min-w-0 px-5 py-10 sm:px-8 lg:px-14 lg:py-14">
        <article className="mx-auto max-w-[46rem]">
          <header>
            {group && <p className="label text-signal-ink">{t(`groups.${group.group}`)}</p>}
            <h1 className="heading mt-3 text-[clamp(2rem,4.2vw,2.875rem)]">{doc.title}</h1>
            {doc.description && (
              <p className="mt-4 text-[1.125rem] leading-relaxed text-ink-2">{doc.description}</p>
            )}
          </header>

          {doc.toc.length > 1 && (
            <details className="reveal group mt-8 rounded-md border border-rule xl:hidden">
              <summary className="flex h-11 items-center px-4 text-[0.9375rem]">
                <span className="label text-ink-3">{t('onThisPage')}</span>
                <span
                  aria-hidden="true"
                  className="ml-auto font-mono text-ink-3 transition-transform group-open:rotate-45"
                >
                  +
                </span>
              </summary>
              <ul className="border-t border-rule px-4 py-3 text-[0.9375rem]">
                {doc.toc.map((item) => (
                  <li key={item.id} className={item.depth === 3 ? 'pl-4' : undefined}>
                    <a href={`#${item.id}`} className="block py-1.5 text-ink-2 hover:text-ink">
                      {item.text}
                    </a>
                  </li>
                ))}
              </ul>
            </details>
          )}

          <div className="prose mt-10">
            <Mdx source={doc.body} />
          </div>

          <footer className="mt-16">
            {site.docsSource && (
              <a
                href={`${site.docsSource}/${doc.file}`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 text-sm text-ink-3 transition-colors hover:text-ink"
              >
                {t('edit')}
                <ArrowUpRight size={14} />
              </a>
            )}
            <nav
              aria-label={`${t('previous')} / ${t('next')}`}
              className="mt-6 grid gap-3 sm:grid-cols-2"
            >
              {previous ? (
                <Link
                  href={previous.href}
                  className="group rounded-md border border-rule p-4 transition-colors hover:border-ink"
                >
                  <span className="label flex items-center gap-2 text-ink-3">
                    <ArrowRight
                      size={12}
                      className="rotate-180 transition-transform group-hover:-translate-x-0.5"
                    />
                    {t('previous')}
                  </span>
                  <span className="mt-1.5 block font-[600]">{previous.title}</span>
                </Link>
              ) : (
                <span className="hidden sm:block" />
              )}
              {next && (
                <Link
                  href={next.href}
                  className="group rounded-md border border-rule p-4 text-right transition-colors hover:border-ink"
                >
                  <span className="label flex items-center justify-end gap-2 text-ink-3">
                    {t('next')}
                    <ArrowRight
                      size={12}
                      className="transition-transform group-hover:translate-x-0.5"
                    />
                  </span>
                  <span className="mt-1.5 block font-[600]">{next.title}</span>
                </Link>
              )}
            </nav>
          </footer>
        </article>
      </main>

      <aside className="hidden border-l border-rule xl:block">
        <div className="sticky top-14 max-h-[calc(100dvh-3.5rem)] overflow-y-auto py-14 pr-6 pl-6 [scrollbar-width:thin]">
          <Toc items={doc.toc} title={t('onThisPage')} />
        </div>
      </aside>
    </div>
  )
}
