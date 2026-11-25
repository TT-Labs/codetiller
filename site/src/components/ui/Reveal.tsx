'use client'

import { motion } from 'motion/react'
import type { ReactNode } from 'react'

/**
 * Content that settles into place the first time it is scrolled to. With reduced motion it only
 * fades (MotionConfig in Providers); without scripts it is simply there (the <noscript> rule in
 * the root layout).
 */
export function Reveal({
  children,
  delay = 0,
  className,
}: {
  children: ReactNode
  /** seconds; for the items of a row or a list */
  delay?: number
  className?: string
}) {
  return (
    <motion.div
      data-reveal
      className={className}
      initial={{ opacity: 0, y: 14 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '0px 0px -12% 0px' }}
      transition={{ duration: 0.6, delay, ease: [0.22, 1, 0.36, 1] }}
    >
      {children}
    </motion.div>
  )
}
