import { defineRouting } from 'next-intl/routing'

/**
 * A further language: add it here, add `messages/<locale>.json`, and (optionally)
 * `content/docs/<locale>/`; a docs page without a translation falls back to the default locale.
 */
export const routing = defineRouting({
  locales: ['en'],
  defaultLocale: 'en',
  // the default locale has no prefix: codetiller.ai/docs, not codetiller.ai/en/docs
  localePrefix: 'as-needed',
})

export type Locale = (typeof routing.locales)[number]
