import type { Metadata, Viewport } from 'next'
import { Archivo, JetBrains_Mono } from 'next/font/google'
import { notFound } from 'next/navigation'
import { hasLocale, NextIntlClientProvider } from 'next-intl'
import { getMessages, getTranslations, setRequestLocale } from 'next-intl/server'
import type { ReactNode } from 'react'
import { Footer } from '@/components/site/Footer'
import { Header } from '@/components/site/Header'
import { Providers } from '@/components/site/Providers'
import { routing } from '@/i18n/routing'
import { site } from '@/site.config'
import '../globals.css'

// width axis: headings are set a little wider than the text
const archivo = Archivo({
  subsets: ['latin'],
  axes: ['wdth'],
  variable: '--font-archivo',
  display: 'swap',
})
const jetbrains = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-jetbrains',
  display: 'swap',
})

/** A stored theme is applied before the first paint; without one the system decides (CSS). */
const THEME_SCRIPT = `try{var t=localStorage.getItem('theme');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch(e){}`

interface Props {
  children: ReactNode
  params: Promise<{ locale: string }>
}

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }))
}

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f5f3ee' },
    { media: '(prefers-color-scheme: dark)', color: '#0f0e0c' },
  ],
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params
  if (!hasLocale(routing.locales, locale)) return {}
  const { meta } = await getMessages({ locale })
  return {
    metadataBase: new URL(site.url),
    title: { default: meta.title, template: meta.titleTemplate },
    description: meta.description,
    applicationName: site.name,
    openGraph: {
      type: 'website',
      siteName: site.name,
      title: meta.title,
      description: meta.description,
      locale,
    },
    twitter: { card: 'summary_large_image' },
  }
}

export default async function LocaleLayout({ children, params }: Props) {
  const { locale } = await params
  if (!hasLocale(routing.locales, locale)) notFound()
  setRequestLocale(locale)
  const messages = await getMessages()
  const t = await getTranslations('ui')

  return (
    <html
      lang={locale}
      className={`${archivo.variable} ${jetbrains.variable}`}
      // the theme script sets data-theme before React takes over
      suppressHydrationWarning
    >
      <head>
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: a constant of this file */}
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
        {/* content revealed on scroll starts hidden: without scripts it must simply be there */}
        <noscript>
          <style>{'[data-reveal]{opacity:1!important;transform:none!important}'}</style>
        </noscript>
      </head>
      <body className="flex min-h-dvh flex-col">
        {/* client components get the interface strings only; page copy is rendered on the server */}
        <NextIntlClientProvider messages={{ ui: messages.ui }}>
          <a
            href="#content"
            className="sr-only z-50 rounded-sm bg-ink px-4 py-2 text-bg focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
          >
            {t('skip')}
          </a>
          <Providers>
            <Header />
            <div id="content" className="flex-1">
              {children}
            </div>
            <Footer />
          </Providers>
        </NextIntlClientProvider>
      </body>
    </html>
  )
}
