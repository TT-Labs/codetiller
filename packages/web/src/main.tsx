import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { clsx } from 'clsx'
import { type ReactNode, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import {
  createBrowserRouter,
  Link,
  Outlet,
  RouterProvider,
  useLocation,
  useRouteError,
} from 'react-router'
import { NEEDS_YOU, useAuthorized, useTasks } from './api'
import { FactoryStatus } from './components/FactoryStatus'
import { Button } from './components/ui/Button'
import { Input } from './components/ui/form'
import { Logo } from './components/ui/icons'
import { Code, ErrorBox } from './components/ui/states'
import { useNeedsYouNotifications } from './notifications'
import { BenchmarkPage } from './routes/BenchmarkPage'
import { BenchmarksPage } from './routes/BenchmarksPage'
import { ComparePage } from './routes/ComparePage'
import { MetricsPage } from './routes/MetricsPage'
import { RunPage } from './routes/RunPage'
import { SettingsPage } from './routes/SettingsPage'
import { TasksPage } from './routes/TasksPage'
import { TaskPage } from './routes/task/TaskPage'
import { useNeedsYouCount } from './title'
import { setToken } from './token'
import './index.css'

/** nav areas own their detail pages too: a task page keeps "Tasks" active */
const AREAS = [
  { to: '/', label: 'Tasks', match: (p: string) => p === '/' || p.startsWith('/tasks/') },
  {
    to: '/evals',
    label: 'Evals',
    match: (p: string) => p === '/evals' || p.startsWith('/benchmarks/') || p.startsWith('/runs/'),
  },
  { to: '/compare', label: 'Compare', match: (p: string) => p === '/compare' },
  { to: '/metrics', label: 'Metrics', match: (p: string) => p === '/metrics' },
  { to: '/settings', label: 'Settings', match: (p: string) => p === '/settings' },
]

function NavItem({ to, active, children }: { to: string; active: boolean; children: ReactNode }) {
  return (
    <Link
      to={to}
      aria-current={active ? 'page' : undefined}
      className={clsx(
        'inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 font-medium text-13 transition-colors',
        active ? 'bg-subtle text-fg' : 'text-fg-muted hover:bg-hover hover:text-fg',
      )}
    >
      {children}
    </Link>
  )
}

/** Shown in place of the app when the server wants a token this page does not have. */
function Locked() {
  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-4 px-6">
      <div className="flex items-center gap-2 font-semibold text-fg tracking-tight">
        <Logo />
        codetiller
      </div>
      <p className="text-fg-muted text-sm leading-relaxed">
        This page needs the access token of the running server. Open the link <Code>tiller ui</Code>{' '}
        printed when it started, or paste the token here (it is also in <Code>.cache/ui-token</Code>
        ).
      </p>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          const value = String(new FormData(e.currentTarget).get('token') ?? '').trim()
          if (!value) return
          setToken(value)
          location.reload()
        }}
      >
        <Input name="token" type="password" aria-label="Access token" autoComplete="off" />
        <Button type="submit" variant="primary">
          Unlock
        </Button>
      </form>
    </div>
  )
}

/** The app, once the server accepts this page's token. */
function Gate() {
  const authorized = useAuthorized()
  if (authorized.data === false) return <Locked />
  // an unreachable server shows the pages' own errors rather than a lock screen
  if (authorized.isPending) return null
  return <Layout />
}

function Layout() {
  const tasks = useTasks()
  const { pathname } = useLocation()
  const needsYou = tasks.data?.items.filter((t) => NEEDS_YOU.includes(t.state)).length ?? 0
  useNeedsYouCount(needsYou)
  useNeedsYouNotifications(tasks.data?.items)
  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-20 border-line border-b bg-surface/85 backdrop-blur">
        <div className="mx-auto flex h-12 max-w-6xl items-center gap-4 px-4 sm:gap-6 sm:px-6">
          <Link
            to="/"
            className="flex items-center gap-2 rounded-md font-semibold text-fg tracking-tight"
          >
            <Logo />
            <span className="max-sm:sr-only">codetiller</span>
          </Link>
          <nav aria-label="Main" className="flex items-center gap-1">
            {AREAS.map((a) => (
              <NavItem key={a.to} to={a.to} active={a.match(pathname)}>
                {a.label}
                {a.to === '/' && needsYou ? (
                  <span
                    title={`${needsYou} need you`}
                    className="min-w-5 rounded-full bg-warning-soft px-1.5 text-center font-semibold text-11 text-warning tabular-nums ring-1 ring-warning-line ring-inset"
                  >
                    {needsYou}
                    <span className="sr-only"> need you</span>
                  </span>
                ) : null}
              </NavItem>
            ))}
          </nav>
          <FactoryStatus />
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
        <Outlet />
      </main>
    </div>
  )
}

// new areas = a route here + a route module on the server (packages/server/src/routes)
/** A page that throws keeps the navigation around it instead of a blank app. */
function PageError() {
  const error = useRouteError()
  return (
    <div className="space-y-3">
      <h1 className="font-semibold text-fg text-xl tracking-tight">This page failed to render</h1>
      <ErrorBox error={error} />
    </div>
  )
}

const router = createBrowserRouter([
  {
    element: <Gate />,
    errorElement: <PageError />,
    children: [
      { path: '/', element: <TasksPage />, errorElement: <PageError /> },
      { path: '/tasks/:id', element: <TaskPage />, errorElement: <PageError /> },
      { path: '/evals', element: <BenchmarksPage />, errorElement: <PageError /> },
      { path: '/benchmarks/:id', element: <BenchmarkPage />, errorElement: <PageError /> },
      { path: '/compare', element: <ComparePage />, errorElement: <PageError /> },
      { path: '/metrics', element: <MetricsPage />, errorElement: <PageError /> },
      { path: '/settings', element: <SettingsPage />, errorElement: <PageError /> },
      { path: '/runs/:id', element: <RunPage />, errorElement: <PageError /> },
    ],
  },
])

// eval data changes rarely; live task views poll on their own (api.ts)
const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, refetchOnWindowFocus: false } },
})

const root = document.getElementById('root')
if (!root) throw new Error('#root missing')
createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
)
