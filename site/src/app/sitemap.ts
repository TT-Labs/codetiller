import type { MetadataRoute } from 'next'
import { getPathname } from '@/i18n/navigation'
import { routing } from '@/i18n/routing'
import { hrefOf, SLUGS } from '@/lib/docs'
import { site } from '@/site.config'

export default function sitemap(): MetadataRoute.Sitemap {
  const pages = ['/', ...SLUGS.map(hrefOf)]
  return routing.locales.flatMap((locale) =>
    pages.map((href) => ({
      url: site.url + getPathname({ locale, href }).replace(/\/$/, ''),
      changeFrequency: 'weekly' as const,
      priority: href === '/' ? 1 : href === '/docs' ? 0.8 : 0.6,
    })),
  )
}
