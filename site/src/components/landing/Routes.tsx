import clsx from 'clsx'

export interface Route {
  from: string
  via?: string
  to: string
  /** `open`: traffic passes (the dashes travel); `closed`: the line ends at a bar */
  state: string
  status: string
  note: string
}

function Node({ children, dim }: { children: string; dim?: boolean }) {
  return (
    <span
      className={clsx(
        'shrink-0 rounded-xs border px-2 py-1 font-mono text-[0.6875rem] leading-none whitespace-nowrap sm:text-[0.75rem]',
        dim ? 'border-dashed border-rule-strong text-ink-3' : 'border-rule-strong text-ink',
      )}
    >
      {children}
    </span>
  )
}

/** The wire between two nodes: travelling dashes when open, a line into a bar when closed. */
function Wire({ open }: { open: boolean }) {
  return open ? (
    <span aria-hidden="true" className="dashes w-5 flex-none text-ok sm:min-w-4 sm:flex-1" />
  ) : (
    <span aria-hidden="true" className="flex w-9 flex-none items-center sm:min-w-6 sm:flex-1">
      <span className="h-px flex-1 bg-rule-strong" />
      <span className="h-3.5 w-0.5 bg-bad" />
      <span className="h-px w-2 sm:w-4" />
    </span>
  )
}

/** Who can reach what from a sandbox: one row per route, the allowed ones alive. */
export function Routes({ title, routes }: { title: string; routes: Route[] }) {
  return (
    <div>
      <h3 className="label text-ink-3">{title}</h3>
      <ul className="mt-4 border-t border-rule">
        {routes.map((route) => {
          const open = route.state === 'open'
          return (
            <li key={`${route.from}-${route.to}`} className="border-b border-rule py-5">
              <div className="flex flex-wrap items-center gap-2">
                <Node>{route.from}</Node>
                <Wire open={open} />
                {route.via && (
                  <>
                    <Node>{route.via}</Node>
                    <Wire open={open} />
                  </>
                )}
                <Node dim={!open}>{route.to}</Node>
              </div>
              <p className="mt-3 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[0.875rem] leading-relaxed">
                <span
                  className={clsx(
                    'label rounded-xs border px-1.5 py-0.5',
                    open ? 'border-ok text-ok' : 'border-bad text-bad',
                  )}
                >
                  {route.status}
                </span>
                <span className="text-ink-2">{route.note}</span>
              </p>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
