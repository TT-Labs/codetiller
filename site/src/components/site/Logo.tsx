import clsx from 'clsx'

/** Three furrows; the last one is the accent. */
export function Mark({ size = 18, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      strokeWidth="2.6"
      strokeLinecap="square"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      <path d="M2.5 16.5 7 3.5" stroke="currentColor" />
      <path d="M8.5 16.5 13 3.5" stroke="currentColor" />
      <path d="M14.5 16.5 19 3.5" stroke="var(--signal)" />
    </svg>
  )
}

export function Logo({ className }: { className?: string }) {
  return (
    <span className={clsx('inline-flex items-center gap-2.5', className)}>
      <Mark />
      <span className="font-stretch-[112%] text-[1.0625rem] font-[660] tracking-[-0.03em]">
        codetiller
      </span>
    </span>
  )
}
