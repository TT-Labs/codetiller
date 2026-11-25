import { useEffect, useRef } from 'react'
import { NEEDS_YOU, type TaskSummary } from './api'

export const notificationsSupported = () => typeof Notification !== 'undefined'

const LABEL: Record<string, string> = {
  WAITING_FOR_HUMAN: 'needs your answer',
  REVIEW: 'is ready for review',
  PR_OPEN: 'has a pull request to review',
  FAILED: 'failed',
}

/**
 * Tell the human when a task starts needing them while they look elsewhere. Only transitions seen
 * by this tab count (nothing on first load), only when the browser already has permission, and
 * not while the tab is in front: the list shows it there.
 */
export function useNeedsYouNotifications(items: TaskSummary[] | undefined) {
  const seen = useRef<Map<string, string> | null>(null)
  useEffect(() => {
    if (!items) return
    const prev = seen.current
    seen.current = new Map(items.map((i) => [i.id, i.state]))
    if (!prev || !notificationsSupported() || Notification.permission !== 'granted') return
    if (document.visibilityState === 'visible' && document.hasFocus()) return
    for (const item of items) {
      const before = prev.get(item.id)
      if (before === item.state || !NEEDS_YOU.includes(item.state)) continue
      // tag: a task that changes again replaces its own notification
      const n = new Notification(`${item.id} ${LABEL[item.state] ?? 'needs you'}`, {
        body: item.title,
        tag: `codetiller-${item.id}`,
      })
      n.onclick = () => {
        window.focus()
        window.location.assign(`/tasks/${item.id}`)
        n.close()
      }
    }
  }, [items])
}
