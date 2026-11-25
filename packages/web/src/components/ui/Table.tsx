import { clsx } from 'clsx'
import type { ComponentProps, ReactNode } from 'react'

/** bordered, horizontally scrollable table; rows get a hover tint, the last row no rule */
export function Table({
  className,
  minWidth = 'min-w-[44rem]',
  children,
}: {
  className?: string
  minWidth?: string
  children: ReactNode
}) {
  return (
    <div className="overflow-x-auto rounded-lg border border-line bg-surface shadow-xs">
      <table
        className={clsx(
          'w-full border-collapse text-13 [&_tbody_tr:last-child>td]:border-b-0 [&_tbody_tr]:transition-colors [&_tbody_tr]:hover:bg-hover/60',
          minWidth,
          className,
        )}
      >
        {children}
      </table>
    </div>
  )
}

type Cell = { num?: boolean }

export function Th({ num, className, ...props }: ComponentProps<'th'> & Cell) {
  return (
    <th
      scope="col"
      className={clsx(
        'h-9 whitespace-nowrap border-line border-b bg-subtle px-3 text-left font-medium text-fg-subtle text-xs',
        num && 'text-right',
        className,
      )}
      {...props}
    />
  )
}

export function Td({ num, className, ...props }: ComponentProps<'td'> & Cell) {
  return (
    <td
      className={clsx(
        'border-line border-b px-3 py-2.5 align-top',
        num && 'whitespace-nowrap text-right tabular-nums',
        className,
      )}
      {...props}
    />
  )
}
