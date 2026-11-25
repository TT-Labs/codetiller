const KEY = 'tiller-token'
const HEADER = 'x-tiller-token'

/**
 * The API token arrives once in the link `tiller ui` prints (`/?token=…`). It is kept in this
 * origin's storage (the port is part of the origin, so no other local app sees it) and taken out
 * of the address so it does not end up in history or a shared screenshot.
 */
function fromLocation(): string | null {
  const url = new URL(location.href)
  const token = url.searchParams.get('token')
  if (!token) return null
  url.searchParams.delete('token')
  history.replaceState(history.state, '', url.pathname + url.search + url.hash)
  return token
}

const read = () => {
  try {
    return localStorage.getItem(KEY)
  } catch {
    return null
  }
}

let token = fromLocation() ?? read()
if (token) setToken(token)

export function setToken(value: string) {
  token = value.trim()
  try {
    localStorage.setItem(KEY, token)
  } catch {
    // private mode: the token lives as long as the page
  }
}

/** sent with every API call */
export const authHeaders = (): Record<string, string> => (token ? { [HEADER]: token } : {})
