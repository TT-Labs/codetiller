import { type CSSProperties, Fragment } from 'react'
import { ButtonLink } from '../ui/Button'
import { ArrowRight } from '../ui/icons'
import { PipelineScene } from './PipelineScene'

interface HeroCopy {
  eyebrow: string[]
  title: string
  lead: string
  primary: string
  secondary: string
  sceneTitle: string
  stations: { name: string; who: string }[]
}

const delay = (ms: number) => ({ '--d': ms }) as CSSProperties

export function Hero({ copy }: { copy: HeroCopy }) {
  const words = copy.title.split(' ')
  return (
    <section>
      <div className="frame">
        <div className="pad pt-14 pb-12 sm:pt-20 lg:pt-24 lg:pb-16">
          <ul className="fade-up label flex flex-wrap items-center gap-x-3 gap-y-1.5 text-ink-3">
            {copy.eyebrow.map((item, i) => (
              <li key={item} className="flex items-center gap-3">
                {i > 0 && <span aria-hidden="true" className="size-[3px] bg-signal" />}
                {item}
              </li>
            ))}
          </ul>

          {/* the words rise out of their own line; a screen reader gets the sentence in one piece */}
          <h1 className="display mt-6 max-w-[13ch] text-[clamp(2.625rem,7.6vw,6.25rem)]">
            <span className="sr-only">{copy.title}</span>
            <span aria-hidden="true">
              {words.map((word, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: the words of one fixed sentence
                <Fragment key={i}>
                  <span className="-mb-[0.14em] inline-block overflow-hidden pb-[0.14em] align-bottom">
                    <span className="rise-in" style={{ '--i': i } as CSSProperties}>
                      {word}
                    </span>
                  </span>{' '}
                </Fragment>
              ))}
            </span>
          </h1>

          <p
            className="fade-up mt-7 max-w-[54ch] text-[1.0625rem] leading-relaxed text-ink-2 sm:text-[1.1875rem]"
            style={delay(420)}
          >
            {copy.lead}
          </p>

          <div className="fade-up mt-9 flex flex-wrap gap-3" style={delay(520)}>
            <ButtonLink href="/docs/install-docker">
              {copy.primary}
              <ArrowRight className="transition-transform group-hover:translate-x-0.5" />
            </ButtonLink>
            <ButtonLink href="/docs" variant="secondary">
              {copy.secondary}
            </ButtonLink>
          </div>

          <div className="fade-up mt-14 lg:mt-20" style={delay(640)}>
            <PipelineScene title={copy.sceneTitle} stations={copy.stations} />
          </div>
        </div>
      </div>
    </section>
  )
}
