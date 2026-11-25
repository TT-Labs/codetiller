import { useTranslations } from 'next-intl'
import { ButtonLink } from '@/components/ui/Button'

export default function NotFound() {
  const t = useTranslations('ui.notFound')
  return (
    <main className="frame">
      <div className="pad flex min-h-[60vh] flex-col justify-center py-24">
        <p className="label text-signal-ink">{t('code')}</p>
        <h1 className="display mt-5 max-w-[14ch] text-[clamp(2.25rem,6vw,4.5rem)]">{t('title')}</h1>
        <p className="mt-5 text-lg text-ink-2">{t('body')}</p>
        <div className="mt-9 flex flex-wrap gap-3">
          <ButtonLink href="/">{t('home')}</ButtonLink>
          <ButtonLink href="/docs" variant="secondary">
            {t('docs')}
          </ButtonLink>
        </div>
      </div>
    </main>
  )
}
