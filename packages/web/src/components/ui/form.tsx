import { clsx } from 'clsx'
import type { ComponentProps, ReactNode } from 'react'
import { ChevronDown } from './icons'

const CONTROL =
  'w-full min-w-0 rounded-md border border-line-strong bg-surface text-fg text-sm shadow-xs transition-[border-color,box-shadow] placeholder:text-fg-subtle focus:border-accent focus:outline-none focus:ring-3 focus:ring-accent/25 disabled:opacity-50'

/** label + control; the label wraps the control so no id wiring is needed */
export function Field({
  label,
  hint,
  className,
  children,
}: {
  label: ReactNode
  hint?: ReactNode
  className?: string
  children: ReactNode
}) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the control arrives as children, inside the label
    <label className={clsx('flex min-w-0 flex-col gap-1.5', className)}>
      <span className="font-medium text-13 text-fg">{label}</span>
      {children}
      {hint ? <span className="text-fg-subtle text-xs">{hint}</span> : null}
    </label>
  )
}

export function Input({ className, ...props }: ComponentProps<'input'>) {
  return <input className={clsx(CONTROL, 'h-8 px-2.5', className)} {...props} />
}

export function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return (
    <textarea
      className={clsx(CONTROL, 'resize-y px-2.5 py-2 leading-relaxed', className)}
      {...props}
    />
  )
}

export function Select({ className, ...props }: ComponentProps<'select'>) {
  return (
    <div className="relative min-w-0">
      <select
        className={clsx(CONTROL, 'h-8 appearance-none truncate pr-8 pl-2.5', className)}
        {...props}
      />
      <ChevronDown className="pointer-events-none absolute top-1/2 right-2.5 size-4 -translate-y-1/2 text-fg-subtle" />
    </div>
  )
}
