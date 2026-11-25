import type { Metadata } from 'next'
import { getMessages } from 'next-intl/server'
import { AuditTerminal } from '@/components/landing/AuditTerminal'
import { DeltaChart } from '@/components/landing/DeltaChart'
import { Hero } from '@/components/landing/Hero'
import { Routes } from '@/components/landing/Routes'
import { Section, SectionHead } from '@/components/landing/Section'
import { Stations } from '@/components/landing/Stations'
import { VerifyDemo } from '@/components/landing/VerifyDemo'
import { ButtonLink } from '@/components/ui/Button'
import { Code } from '@/components/ui/Code'
import { ArrowRight } from '@/components/ui/icons'
import { Reveal } from '@/components/ui/Reveal'
import { Tabs } from '@/components/ui/Tabs'
import { localeOf } from '@/i18n/locale'
import { getPathname, Link } from '@/i18n/navigation'
import { rich } from '@/lib/rich'
import { site } from '@/site.config'

interface Props {
  params: Promise<{ locale: string }>
}

/* Commands and output of the product: the same in every language, so they live here and not
   in messages/. Keep them in step with the docs (content/docs/en/quickstart, install-*). */

const INSTALL_DOCKER = `git clone https://github.com/TT-Labs/codetiller && cd codetiller
deploy/install.sh    # builds the images, starts the factory, runs tiller doctor

# put ANTHROPIC_API_KEY and TILLER_GITHUB_TOKEN into /var/lib/tiller/.env, then:
docker compose -f deploy/compose.yaml restart
docker compose -f deploy/compose.yaml exec tiller tiller doctor
docker compose -f deploy/compose.yaml exec tiller tiller repo add <owner/name>
`

const INSTALL_KUBERNETES = `# after building and pushing the two images (see the guide):
kubectl apply -f deploy/kubernetes/namespace.yaml
kubectl -n tiller create secret generic tiller-secrets \\
  --from-literal=ANTHROPIC_API_KEY=... --from-literal=TILLER_GITHUB_TOKEN=... \\
  --from-literal=TILLER_GATEWAY_ADMIN_TOKEN="$(openssl rand -hex 32)"
kubectl apply -k deploy/kubernetes

kubectl -n tiller exec deploy/tiller -- tiller doctor
kubectl -n tiller exec deploy/tiller -- tiller audit
`

const INSTALL_LOCAL = `git clone https://github.com/TT-Labs/codetiller && cd codetiller
pnpm install && pnpm build       # keys go into .env in the clone

pnpm tiller setup                # builds the sandbox image, runs tiller doctor
pnpm tiller repo add <owner/name>
pnpm tiller ui                   # the dashboard and the worker
`

/** `tiller doctor` on a ready installation: status, check, what was measured */
const DOCTOR = [
  ['docker', '29.1.3'],
  ['git', 'git version 2.47.1'],
  ['sandbox image', 'codetiller/base:dev (3f9a1c2b7d04)'],
  ['workspaces', '/var/lib/tiller: the same files for tiller and a container, written by both'],
  ['database', 'schema version 1'],
  ['disk', '212.4 GB free in /var/lib/tiller'],
  ['model key', 'ANTHROPIC_API_KEY is set'],
  ['forge token', 'TILLER_GITHUB_TOKEN is set'],
  ['repo acme/shop', 'readable, role allows a push, CI readable'],
] as const

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const locale = await localeOf(params)
  return { alternates: { canonical: getPathname({ locale, href: '/' }) } }
}

function More({ href, children }: { href: string; children: string }) {
  return (
    <Link
      href={href}
      className="group inline-flex items-center gap-2 border-b border-rule-strong pb-1 text-[0.9375rem] font-[560] transition-colors hover:border-signal"
    >
      {children}
      <ArrowRight className="transition-transform group-hover:translate-x-0.5" />
    </Link>
  )
}

export default async function Home({ params }: Props) {
  await localeOf(params)
  const { landing: c } = await getMessages()

  return (
    <main>
      <Hero copy={c.hero} />

      {/* what it runs on: a line, not a logo wall */}
      <section className="border-t border-rule">
        <div className="frame">
          <div className="pad flex flex-col gap-x-8 gap-y-3 py-5 sm:flex-row sm:items-baseline">
            <h2 className="label shrink-0 text-ink-3">{c.works.label}</h2>
            <ul className="flex flex-wrap gap-x-6 gap-y-1.5 font-mono text-[0.8125rem] text-ink-2">
              {c.works.items.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      {/* 01 the problem: a ledger, agent alone against agent in the factory */}
      <Section id="problem">
        <div className="lg:grid lg:grid-cols-12 lg:gap-x-12">
          <SectionHead
            n="01"
            label={c.problem.label}
            title={c.problem.title}
            lead={c.problem.lead}
            className="lg:sticky lg:top-24 lg:col-span-5 lg:self-start"
          />
          <div className="mt-12 lg:col-span-7 lg:mt-0">
            <div className="hidden grid-cols-2 gap-x-8 border-b border-ink pb-3 sm:grid">
              <p className="label text-ink-3">{c.problem.without}</p>
              <p className="label text-ink">{c.problem.with}</p>
            </div>
            <ul className="border-t border-ink sm:border-t-0">
              {c.problem.rows.map((row, i) => (
                <li key={row.without} className="border-b border-rule">
                  <Reveal delay={i * 0.04} className="grid gap-x-8 gap-y-3 py-6 sm:grid-cols-2">
                    <p className="text-ink-3">
                      <span className="label mb-1.5 block sm:hidden">{c.problem.without}</span>
                      <span className="line-through decoration-rule-strong decoration-1">
                        {row.without}
                      </span>
                    </p>
                    <p className="text-ink">
                      <span className="label mb-1.5 block text-signal-ink sm:hidden">
                        {c.problem.with}
                      </span>
                      {row.with}
                    </p>
                  </Reveal>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </Section>

      {/* 02 how it works: the stations, told while scrolling */}
      <Section id="how">
        <SectionHead n="02" label={c.how.label} title={c.how.title} lead={c.how.lead} />
        <div className="mt-14 lg:mt-6">
          <Stations steps={c.how.steps} />
        </div>
      </Section>

      {/* 03 trust boundary: the one dark band of the page */}
      <Section id="trust" tone="dark">
        <SectionHead n="03" label={c.trust.label} title={c.trust.title} lead={c.trust.lead} />
        <div className="mt-14 grid gap-x-12 gap-y-14 lg:grid-cols-12">
          <div className="min-w-0 lg:col-span-5">
            <Routes title={c.trust.routesTitle} routes={c.trust.routes} />
          </div>
          <div className="min-w-0 lg:col-span-7">
            <AuditTerminal caption={c.trust.auditCaption} />
          </div>
        </div>
        <ul className="mt-16 grid gap-x-12 gap-y-8 border-t border-rule pt-10 md:grid-cols-3">
          {c.trust.points.map((point, i) => (
            <li key={point.title}>
              <Reveal delay={i * 0.08}>
                <h3 className="font-[620] tracking-[-0.01em]">{point.title}</h3>
                <p className="mt-2 text-[0.9375rem] leading-relaxed text-ink-2">{point.body}</p>
              </Reveal>
            </li>
          ))}
        </ul>
        <div className="mt-12">
          <More href="/docs/trust-boundary">{c.trust.more}</More>
        </div>
      </Section>

      {/* 04 verification */}
      <Section id="verification">
        <div className="grid gap-x-12 gap-y-12 lg:grid-cols-12">
          <div className="min-w-0 lg:order-2 lg:col-span-6">
            <SectionHead
              n="04"
              label={c.verify.label}
              title={c.verify.title}
              lead={c.verify.lead}
            />
            <dl className="mt-10 border-t border-rule">
              {c.verify.items.map((item, i) => (
                <Reveal key={item.title} delay={i * 0.05} className="border-b border-rule py-5">
                  <dt className="font-[620] tracking-[-0.01em]">{item.title}</dt>
                  <dd className="mt-1.5 text-[0.9375rem] leading-relaxed text-ink-2">
                    {item.body}
                  </dd>
                </Reveal>
              ))}
            </dl>
            <div className="mt-10">
              <More href="/docs/verification">{c.verify.more}</More>
            </div>
          </div>
          <div className="min-w-0 lg:order-1 lg:col-span-6 lg:pt-2">
            <div className="lg:sticky lg:top-24">
              <VerifyDemo
                diffCaption={c.verify.diffCaption}
                verdictCaption={c.verify.verdictCaption}
              />
            </div>
          </div>
        </div>
      </Section>

      {/* 05 evals */}
      <Section id="evals">
        <div className="grid gap-x-12 gap-y-12 lg:grid-cols-12">
          <div className="min-w-0 lg:col-span-6">
            <SectionHead n="05" label={c.evals.label} title={c.evals.title} lead={c.evals.lead} />
            <ul className="mt-10 border-t border-rule">
              {c.evals.points.map((point, i) => (
                <li key={point} className="border-b border-rule">
                  <Reveal delay={i * 0.05} className="flex gap-4 py-5">
                    <span className="label pt-1 text-signal-ink">
                      {String(i + 1).padStart(2, '0')}
                    </span>
                    <p className="text-[0.9375rem] leading-relaxed text-ink-2">{rich(point)}</p>
                  </Reveal>
                </li>
              ))}
            </ul>
            <div className="mt-10">
              <More href="/docs/evals">{c.evals.more}</More>
            </div>
          </div>
          <div className="min-w-0 lg:col-span-6 lg:pt-2">
            <DeltaChart copy={c.evals.chart} />
          </div>
        </div>
      </Section>

      {/* 06 install */}
      <Section id="install">
        <SectionHead n="06" label={c.install.label} title={c.install.title} lead={c.install.lead} />
        <div className="mt-12 grid gap-x-12 gap-y-12 lg:grid-cols-12">
          <div className="min-w-0 lg:col-span-7">
            <Tabs
              label={c.install.tabsLabel}
              tabs={[
                {
                  id: 'docker',
                  label: c.install.tabs.docker,
                  content: (
                    <>
                      <Code code={INSTALL_DOCKER} />
                      <p className="mt-4">
                        <More href="/docs/install-docker">{c.install.dockerGuide}</More>
                      </p>
                    </>
                  ),
                },
                {
                  id: 'kubernetes',
                  label: c.install.tabs.kubernetes,
                  content: (
                    <>
                      <Code code={INSTALL_KUBERNETES} />
                      <p className="mt-4">
                        <More href="/docs/install-kubernetes">{c.install.kubernetesGuide}</More>
                      </p>
                    </>
                  ),
                },
                {
                  id: 'local',
                  label: c.install.tabs.local,
                  content: (
                    <>
                      <Code code={INSTALL_LOCAL} />
                      <p className="mt-4">
                        <More href="/docs/quickstart">{c.install.localGuide}</More>
                      </p>
                    </>
                  ),
                },
              ]}
            />
            <p className="mt-6 text-[0.875rem] text-ink-3">{rich(c.install.note)}</p>
          </div>
          <div className="min-w-0 lg:col-span-5">
            <h3 className="font-[620] tracking-[-0.01em]">{c.install.doctorTitle}</h3>
            <p className="mt-2 text-[0.9375rem] leading-relaxed text-ink-2">
              {rich(c.install.doctorBody)}
            </p>
            <div className="scheme-dark mt-5 overflow-hidden rounded-md border border-rule bg-sunk text-ink">
              <div className="flex h-10 items-center gap-2 border-b border-rule px-4 font-mono text-[0.75rem]">
                <span className="text-signal">$</span>
                tiller doctor
              </div>
              <div className="px-4 py-4 font-mono text-[0.75rem] leading-[1.8]">
                {DOCTOR.map(([name, detail]) => (
                  <div key={name} className="grid grid-cols-[1.75rem_7.5rem_minmax(0,1fr)] gap-x-2">
                    <span className="text-ok">ok</span>
                    <span>{name}</span>
                    <span className="text-ink-2">{detail}</span>
                  </div>
                ))}
                <p className="mt-3 text-ok">ready</p>
              </div>
            </div>
          </div>
        </div>
      </Section>

      {/* 07 open source: what that means for the team that runs it */}
      <Section id="open">
        <SectionHead n="07" label={c.open.label} title={c.open.title} lead={c.open.lead} />
        <ul className="mt-12 grid gap-x-12 gap-y-8 border-t border-rule pt-10 md:grid-cols-3">
          {c.open.points.map((point, i) => (
            <li key={point.title}>
              <Reveal delay={i * 0.08}>
                <h3 className="font-[620] tracking-[-0.01em]">{point.title}</h3>
                <p className="mt-2 text-[0.9375rem] leading-relaxed text-ink-2">{point.body}</p>
              </Reveal>
            </li>
          ))}
        </ul>
        <div className="mt-12 flex flex-wrap gap-3">
          {site.github && <ButtonLink href={site.github}>{c.open.primary}</ButtonLink>}
          <ButtonLink href="/docs" variant="secondary">
            {c.open.secondary}
          </ButtonLink>
        </div>
      </Section>

      {/* 08 status: what works, what is not built */}
      <Section id="status">
        <SectionHead n="08" label={c.status.label} title={c.status.title} lead={c.status.lead} />
        <div className="mt-12 grid gap-x-12 gap-y-12 md:grid-cols-2">
          {(
            [
              { title: c.status.worksTitle, items: c.status.works, mark: '+', tone: 'text-ok' },
              {
                title: c.status.notYetTitle,
                items: c.status.notYet,
                mark: '–',
                tone: 'text-ink-3',
              },
            ] as const
          ).map((list) => (
            <div key={list.title}>
              <h3 className="label border-b border-ink pb-3 text-ink">{list.title}</h3>
              <ul>
                {list.items.map((item) => (
                  <li
                    key={item}
                    className="flex gap-4 border-b border-rule py-3.5 text-[0.9375rem] leading-relaxed"
                  >
                    <span aria-hidden="true" className={`font-mono ${list.tone}`}>
                      {list.mark}
                    </span>
                    <span className={list.mark === '+' ? 'text-ink' : 'text-ink-2'}>{item}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </Section>

      {/* 09 questions */}
      <Section id="faq">
        <div className="lg:grid lg:grid-cols-12 lg:gap-x-12">
          <SectionHead n="09" label={c.faq.label} title={c.faq.title} className="lg:col-span-5" />
          <div className="mt-10 border-t border-ink lg:col-span-7 lg:mt-0">
            {c.faq.items.map((item) => (
              <details key={item.q} className="reveal group border-b border-rule">
                <summary className="flex items-start gap-4 py-5 text-[1.0625rem] font-[600] tracking-[-0.01em] transition-colors hover:text-signal-ink">
                  <span className="flex-1">{item.q}</span>
                  <span
                    aria-hidden="true"
                    className="mt-0.5 font-mono text-ink-3 transition-transform duration-300 group-open:rotate-45"
                  >
                    +
                  </span>
                </summary>
                <p className="max-w-[60ch] pr-8 pb-6 leading-relaxed text-ink-2">{rich(item.a)}</p>
              </details>
            ))}
          </div>
        </div>
      </Section>

      {/* the closing call: the one block in the accent colour */}
      <Section tone="signal" className="lg:py-32">
        <h2 className="display max-w-[12ch] text-[clamp(2.5rem,7vw,5.5rem)]">{c.cta.title}</h2>
        <p className="mt-6 max-w-[46ch] text-[1.125rem] leading-relaxed">{rich(c.cta.body)}</p>
        <div className="mt-9 flex flex-wrap gap-3">
          <ButtonLink href="/docs/install-docker" variant="inverse">
            {c.cta.primary}
            <ArrowRight className="transition-transform group-hover:translate-x-0.5" />
          </ButtonLink>
          <ButtonLink href="/docs" variant="inverseSecondary">
            {c.cta.secondary}
          </ButtonLink>
        </div>
      </Section>
    </main>
  )
}
