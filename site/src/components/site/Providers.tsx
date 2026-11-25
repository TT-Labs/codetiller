'use client'

import { MotionConfig } from 'motion/react'
import type { ReactNode } from 'react'

/** Motion honours the system's "reduce motion": movement is dropped, fades stay. */
export function Providers({ children }: { children: ReactNode }) {
  return <MotionConfig reducedMotion="user">{children}</MotionConfig>
}
