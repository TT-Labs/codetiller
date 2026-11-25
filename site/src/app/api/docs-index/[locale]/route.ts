import { hasLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { searchIndex } from '@/lib/docs'

// built once per locale with the site; the search palette fetches it on first use
export const dynamic = 'force-static'

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }))
}

export async function GET(_req: Request, { params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params
  if (!hasLocale(routing.locales, locale)) return new Response('not found', { status: 404 })
  return Response.json(await searchIndex(locale))
}
