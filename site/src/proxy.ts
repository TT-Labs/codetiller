import createMiddleware from 'next-intl/middleware'
import { routing } from './i18n/routing'

export default createMiddleware(routing)

export const config = {
  // everything but the API, Next's own paths and files with an extension
  matcher: '/((?!api|_next|_vercel|.*\\..*).*)',
}
