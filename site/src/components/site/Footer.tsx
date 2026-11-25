import { getTranslations } from 'next-intl/server'
import { Link } from '@/i18n/navigation'
import { site } from '@/site.config'
import { Logo } from './Logo'

export async function Footer() {
  const t = await getTranslations('footer')
  const columns = [
    {
      title: t('product'),
      links: [
        { href: '/#how', label: t('links.how') },
        { href: '/#trust', label: t('links.trust') },
        { href: '/#install', label: t('links.install') },
        { href: '/#status', label: t('links.status') },
      ],
    },
    {
      title: t('docs'),
      links: [
        { href: '/docs', label: t('links.intro') },
        { href: '/docs/quickstart', label: t('links.quickstart') },
        { href: '/docs/trust-boundary', label: t('links.boundary') },
        { href: '/docs/cli', label: t('links.cli') },
      ],
    },
    ...(site.github
      ? [
          {
            title: t('project'),
            links: [
              { href: site.github, label: t('links.github') },
              { href: `${site.github}/blob/main/LICENSE`, label: t('links.license') },
            ],
          },
        ]
      : []),
  ]
  return (
    <footer className="border-t border-rule">
      <div className="frame">
        <div className="pad grid gap-12 py-14 md:grid-cols-12">
          <div className="md:col-span-5">
            <Logo />
            <p className="mt-4 max-w-[30ch] text-[0.9375rem] text-ink-2">{t('tagline')}</p>
          </div>
          <div className="grid grid-cols-2 gap-8 sm:grid-cols-3 md:col-span-7">
            {columns.map((col) => (
              <nav key={col.title} aria-label={col.title}>
                <h2 className="label text-ink-3">{col.title}</h2>
                <ul className="mt-4 space-y-2.5 text-[0.9375rem]">
                  {col.links.map((link) => (
                    <li key={link.href}>
                      {link.href.startsWith('http') ? (
                        <a
                          href={link.href}
                          target="_blank"
                          rel="noreferrer"
                          className="text-ink-2 transition-colors hover:text-ink"
                        >
                          {link.label}
                        </a>
                      ) : (
                        <Link
                          href={link.href}
                          className="text-ink-2 transition-colors hover:text-ink"
                        >
                          {link.label}
                        </Link>
                      )}
                    </li>
                  ))}
                </ul>
              </nav>
            ))}
          </div>
        </div>
        <div className="pad border-t border-rule py-5">
          <p className="label text-ink-3">{t('legal', { year: new Date().getFullYear() })}</p>
        </div>
      </div>
    </footer>
  )
}
