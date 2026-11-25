import { useEffect } from 'react'

// two writers, one title: the page names itself, the layout knows how many tasks need the human
let page = ''
let needsYou = 0

const render = () => {
  document.title = `${needsYou ? `(${needsYou}) ` : ''}${page ? `${page} · ` : ''}codetiller`
}

/** Tab title for the current page, e.g. "T-9 API: oversized… · codetiller". */
export function usePageTitle(title: string | undefined) {
  useEffect(() => {
    page = title ?? ''
    render()
    return () => {
      page = ''
      render()
    }
  }, [title])
}

/** Prefix every tab title with the number of tasks waiting for the human. */
export function useNeedsYouCount(count: number) {
  useEffect(() => {
    needsYou = count
    render()
  }, [count])
}
