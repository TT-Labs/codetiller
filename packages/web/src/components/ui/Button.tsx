import { clsx } from 'clsx'
import type { ComponentProps } from 'react'

const VARIANT = {
  primary: 'bg-accent text-accent-fg shadow-xs hover:bg-accent-hover',
  secondary: 'border border-line-strong bg-surface text-fg shadow-xs hover:bg-hover',
  danger:
    'border border-line-strong bg-surface text-danger shadow-xs hover:border-danger-line hover:bg-danger-soft',
  ghost: 'text-fg-muted hover:bg-hover hover:text-fg',
}

/** for links that are actions (open the PR): same look as a button */
export const buttonClass = (variant: keyof typeof VARIANT = 'secondary', className?: string) =>
  clsx(
    'inline-flex h-8 shrink-0 select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-3 font-medium text-13 transition-colors disabled:cursor-not-allowed disabled:opacity-50',
    VARIANT[variant],
    className,
  )

export function Button({
  variant = 'secondary',
  className,
  type = 'button',
  ...props
}: ComponentProps<'button'> & { variant?: keyof typeof VARIANT }) {
  return <button type={type} className={buttonClass(variant, className)} {...props} />
}
