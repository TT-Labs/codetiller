import { clsx } from 'clsx'

type Tab<T> = { id: T; label: string; hidden?: boolean }

/** `underline` = page tabs, `segmented` = compact switch (e.g. data split) */
export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
  label,
  variant = 'underline',
}: {
  tabs: Tab<T>[]
  value: T
  onChange: (t: T) => void
  label?: string
  variant?: 'underline' | 'segmented'
}) {
  const segmented = variant === 'segmented'
  return (
    <div
      role="tablist"
      aria-label={label}
      className={clsx(
        segmented
          ? 'inline-flex h-8 items-center gap-0.5 rounded-md border border-line bg-subtle p-0.5'
          : 'flex gap-1 overflow-x-auto border-line border-b',
      )}
    >
      {tabs
        .filter((t) => !t.hidden)
        .map((t) => {
          const active = t.id === value
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => onChange(t.id)}
              className={clsx(
                'whitespace-nowrap font-medium text-13 transition-colors',
                segmented
                  ? [
                      'h-full rounded px-3',
                      active
                        ? 'bg-surface text-fg shadow-xs ring-1 ring-line'
                        : 'text-fg-muted hover:text-fg',
                    ]
                  : [
                      '-mb-px border-b-2 px-3 py-2',
                      active
                        ? 'border-accent text-fg'
                        : 'border-transparent text-fg-muted hover:border-line-strong hover:text-fg',
                    ],
              )}
            >
              {t.label}
            </button>
          )
        })}
    </div>
  )
}
