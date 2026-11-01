// Sections and steps arriving on scroll, once. Adapted from Motion Primitives' In View / Animated Group (MIT):
// full transform strings for hardware acceleration, and reduced motion keeps everything in place.
import type { ReactNode } from 'react'
import { motion, useReducedMotion } from 'motion/react'

const EASE_OUT = [0.23, 1, 0.32, 1] as const

export function Reveal({ children, index = 0, className, as = 'div' }: { children: ReactNode; index?: number; className?: string; as?: 'div' | 'li' }) {
  const reduce = useReducedMotion()
  const Tag = as === 'li' ? motion.li : motion.div
  return (
    <Tag
      className={className}
      initial={reduce ? false : { opacity: 0, transform: 'translateY(16px)' }}
      whileInView={{ opacity: 1, transform: 'translateY(0px)' }}
      viewport={{ once: true, amount: 0.15 }}
      transition={{ duration: 0.28, ease: EASE_OUT, delay: index * 0.06 }}
    >
      {children}
    </Tag>
  )
}
