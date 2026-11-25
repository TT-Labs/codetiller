import { notFound } from 'next/navigation'

/** Any address no page answers: rendered by `[locale]/not-found.tsx`, inside the site's layout. */
export default function CatchAll() {
  notFound()
}
