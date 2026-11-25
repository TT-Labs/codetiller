import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { ImageResponse } from 'next/og'
import { hasLocale } from 'next-intl'
import { getMessages } from 'next-intl/server'
import { routing } from '@/i18n/routing'
import { site } from '@/site.config'

export const alt = site.name
export const size = { width: 1200, height: 630 }
export const contentType = 'image/png'

const INK = '#ece9df'
const SIGNAL = '#ff5a1f'

/** The card a link to the site unfolds into: the mark, the sentence of the hero, the address. */
export default async function OpengraphImage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params
  const { landing } = await getMessages({
    locale: hasLocale(routing.locales, locale) ? locale : routing.defaultLocale,
  })
  const font = await readFile(path.join(process.cwd(), 'src/assets/archivo-latin-700.ttf'))
  return new ImageResponse(
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        padding: 72,
        background: '#0f0e0c',
        color: INK,
        fontFamily: 'Archivo',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
        {/* biome-ignore lint/a11y/noSvgWithoutTitle: drawn into an image; a title would be painted as text */}
        <svg width="44" height="44" viewBox="0 0 20 20" fill="none" strokeWidth="2.6">
          <path d="M2.5 16.5 7 3.5" stroke={INK} />
          <path d="M8.5 16.5 13 3.5" stroke={INK} />
          <path d="M14.5 16.5 19 3.5" stroke={SIGNAL} />
        </svg>
        <div style={{ fontSize: 38, fontWeight: 700, letterSpacing: -1 }}>{site.name}</div>
      </div>
      <div
        style={{
          display: 'flex',
          maxWidth: 980,
          fontSize: 100,
          fontWeight: 700,
          lineHeight: 1,
          letterSpacing: -3.5,
        }}
      >
        {landing.hero.title}
      </div>
      <div
        style={{ display: 'flex', alignItems: 'center', gap: 16, fontSize: 28, color: '#b2aea1' }}
      >
        <div style={{ width: 14, height: 14, background: SIGNAL }} />
        {new URL(site.url).host}
      </div>
    </div>,
    { ...size, fonts: [{ name: 'Archivo', data: font, weight: 700, style: 'normal' }] },
  )
}
