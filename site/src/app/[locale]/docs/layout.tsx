import type { ReactNode } from 'react'
import { MobileSidebar, SidebarNav } from '@/components/docs/Sidebar'
import { localeOf } from '@/i18n/locale'
import { loadNav } from '@/lib/docs'

export default async function DocsLayout({
  children,
  params,
}: {
  children: ReactNode
  params: Promise<{ locale: string }>
}) {
  const locale = await localeOf(params)
  const nav = await loadNav(locale)
  return (
    <div className="frame">
      <MobileSidebar nav={nav} />
      <div className="lg:grid lg:grid-cols-[16rem_minmax(0,1fr)]">
        <aside className="hidden border-r border-rule lg:block">
          <div className="sticky top-14 max-h-[calc(100dvh-3.5rem)] overflow-y-auto py-10 pr-6 pl-8 [scrollbar-width:thin]">
            <SidebarNav nav={nav} />
          </div>
        </aside>
        {children}
      </div>
    </div>
  )
}
