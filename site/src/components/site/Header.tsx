import { getTranslations } from 'next-intl/server'
import { Link } from '@/i18n/navigation'
import { site } from '@/site.config'
import { Github } from '../ui/icons'
import { Logo } from './Logo'
import { MobileMenu } from './MobileMenu'
import { Search } from './Search'
import { ThemeToggle } from './ThemeToggle'

export async function Header() {
  const t = await getTranslations('ui.nav')
  const items = [
    { href: '/#how', label: t('how') },
    { href: '/#trust', label: t('trust') },
    { href: '/#install', label: t('install') },
    { href: '/docs', label: t('docs') },
  ]
  return (
    <header className="sticky top-0 z-40 border-b border-rule bg-bg">
      <div className="frame">
        <div className="pad flex h-14 items-center gap-8">
          <Link href="/" aria-label={site.name} className="shrink-0">
            <Logo />
          </Link>
          <nav aria-label={t('label')} className="hidden md:block">
            <ul className="flex items-center gap-7 text-[0.9375rem] text-ink-2">
              {items.map((item) => (
                <li key={item.href}>
                  <Link href={item.href} className="transition-colors hover:text-ink">
                    {item.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
          <div className="ml-auto flex items-center gap-1">
            <Search />
            {site.github && (
              <a
                href={site.github}
                target="_blank"
                rel="noreferrer"
                aria-label={t('github')}
                title={t('github')}
                className="hidden size-9 items-center justify-center rounded-sm text-ink-2 transition-colors hover:bg-sunk hover:text-ink sm:inline-flex"
              >
                <Github />
              </a>
            )}
            <ThemeToggle />
            <MobileMenu items={items} github={site.github} />
          </div>
        </div>
      </div>
    </header>
  )
}
