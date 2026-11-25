import { notFound } from 'next/navigation'
import { hasLocale } from 'next-intl'
import { setRequestLocale } from 'next-intl/server'
import { type Locale, routing } from './routing'

/**
 * The locale of a page or layout from its `[locale]` segment: checked, and announced to
 * next-intl so the page can be rendered statically. Call it first in every page and layout.
 */
export async function localeOf(params: Promise<{ locale: string }>): Promise<Locale> {
  const { locale } = await params
  if (!hasLocale(routing.locales, locale)) notFound()
  setRequestLocale(locale)
  return locale
}
