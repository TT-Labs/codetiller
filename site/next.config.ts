import type { NextConfig } from 'next'
import createNextIntlPlugin from 'next-intl/plugin'

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts')

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // the site is its own root inside the codetiller repository (own lockfile)
  turbopack: { root: import.meta.dirname },
  outputFileTracingRoot: import.meta.dirname,
  // files read with fs: the docs, and the font of the link card
  outputFileTracingIncludes: {
    '/[locale]/docs/[[...slug]]': ['./content/**/*'],
    '/api/docs-index/[locale]': ['./content/**/*'],
    '/[locale]/opengraph-image': ['./src/assets/*.ttf'],
  },
}

export default withNextIntl(config)
