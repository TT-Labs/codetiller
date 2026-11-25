import { useSearchParams } from 'react-router'

/**
 * The selected tab lives in the URL (`?tab=diff`) so a view can be linked and survives reload.
 * The default tab keeps the URL clean; an unknown value falls back to it.
 */
export function useTabParam<T extends string>(
  tabs: readonly T[],
  fallback: T,
): [T, (tab: T) => void] {
  const [params, setParams] = useSearchParams()
  const raw = params.get('tab')
  const tab = tabs.find((t) => t === raw) ?? fallback
  const set = (next: T) =>
    setParams(
      (prev) => {
        const p = new URLSearchParams(prev)
        if (next === fallback) p.delete('tab')
        else p.set('tab', next)
        return p
      },
      { replace: true },
    )
  return [tab, set]
}
