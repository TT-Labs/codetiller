import { Fragment, type ReactNode } from 'react'

/** Copy in messages/ marks code with backticks (`tiller doctor`): the only markup it has. */
export function rich(text: string): ReactNode {
  return text.split('`').map((part, i) =>
    i % 2 ? (
      <code
        // biome-ignore lint/suspicious/noArrayIndexKey: parts of one fixed string
        key={i}
        className="rounded-xs border whitespace-nowrap border-rule bg-raised px-1 py-px text-[0.86em] text-ink [.on-signal_&]:border-black/25 [.on-signal_&]:bg-transparent [.on-signal_&]:text-current"
      >
        {part}
      </code>
    ) : (
      // biome-ignore lint/suspicious/noArrayIndexKey: parts of one fixed string
      <Fragment key={i}>{part}</Fragment>
    ),
  )
}
