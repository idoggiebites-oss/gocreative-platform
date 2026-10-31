import type { MouseEvent, ReactNode } from 'react'
import { Link, useNavigate } from 'react-router'
import { ChevronDown } from 'lucide-react'
import type { ArtworkStatus, EstimateStatus, PoStatus, ProductionStatus } from '@shared/enums'
import { cn } from '@/lib/utils'

export type Tone = 'amber' | 'blue' | 'green' | 'red' | 'gray'

const TONE: Record<Tone, string> = {
  amber: 'bg-status-amber text-status-amber-fg',
  blue: 'bg-status-blue text-status-blue-fg',
  green: 'bg-status-green text-status-green-fg',
  red: 'bg-status-red text-status-red-fg',
  gray: 'bg-status-gray text-status-gray-fg',
}
const CHIP = "inline-flex h-[22px] items-center gap-1.5 rounded-full px-2 text-xs font-medium whitespace-nowrap before:size-1.5 before:rounded-full before:bg-current before:content-['']"

// Each status always has a text label next to its colour (DESIGN_SYSTEM.md).
export const ARTWORK_TONE: Record<ArtworkStatus, Tone> = { none: 'gray', pending: 'amber', approved: 'green', changes_requested: 'red' }
export const PO_TONE: Record<PoStatus, Tone> = { requested: 'amber', received: 'amber', under_review: 'amber', approved: 'green', rejected: 'red', correction_required: 'red' }
export const PRODUCTION_TONE: Record<ProductionStatus, Tone> = {
  awaiting_authorization: 'amber', awaiting_artwork: 'amber', ready: 'gray', in_production: 'blue', quality_control: 'blue', ready_for_pickup: 'green', completed: 'green',
}
export const ESTIMATE_TONE: Record<EstimateStatus, Tone> = { draft: 'gray', sent: 'amber', accepted: 'green', declined: 'red' }

export function Chip({ tone, children, className }: { tone: Tone; children: ReactNode; className?: string }) {
  return <span className={cn(CHIP, TONE[tone], className)}>{children}</span>
}

/** A chip that opens a menu: the trigger of an inline status change. */
export function ChipTrigger({ tone, children, className, ...props }: { tone: Tone; children: ReactNode } & React.ComponentProps<'button'>) {
  return (
    <button type="button" {...props} className={cn(CHIP, TONE[tone], 'cursor-pointer aria-busy:cursor-wait aria-busy:opacity-60', className)}>
      {children}
      <ChevronDown className="-mr-0.5 size-3" strokeWidth={2} aria-hidden />
    </button>
  )
}

export function MethodTag({ children }: { children: ReactNode }) {
  return <span className="mr-1 inline-flex h-5 items-center rounded-[5px] bg-secondary px-1.5 text-[11.5px] font-medium text-[#4A4741]">{children}</span>
}

export const CARD = 'rounded-[10px] border border-border bg-card shadow-[0_1px_2px_rgba(28,27,25,.04)]'
export const PAGE = 'mx-auto flex w-full max-w-[1240px] flex-col gap-5 px-4 pt-6 pb-10 sm:px-8'
export const TH = 'h-[34px] whitespace-nowrap border-b border-border px-2.5 text-left text-xs font-medium text-muted-foreground'
export const TD = 'h-10 whitespace-nowrap border-b border-secondary px-2.5'
export const MUTED = 'text-xs text-muted-foreground'

/** Bold the order number inside a translated sentence, whatever the language puts around it. */
export function Sentence({ text, n }: { text: string; n: string }) {
  const [before, ...rest] = n ? text.split(n) : [text]
  if (!rest.length) return <>{text}</>
  return <>{before}<b className="num font-medium">{n}</b>{rest.join(n)}</>
}

/**
 * Makes a whole table row act as a link without breaking selection or middle-click:
 * the real <a> in the first cell does the work for keyboard and assistive tech.
 */
export function useRowLink() {
  const navigate = useNavigate()
  return (to: string) => ({
    className: 'cursor-pointer hover:[&>td]:bg-header',
    onClick: (e: MouseEvent<HTMLElement>) => {
      if ((e.target as HTMLElement).closest('a,button') || window.getSelection()?.toString()) return
      if (e.metaKey || e.ctrlKey) window.open(to, '_blank')
      else void navigate(to)
    },
    onAuxClick: (e: MouseEvent<HTMLElement>) => {
      if (e.button === 1 && !(e.target as HTMLElement).closest('a')) window.open(to, '_blank')
    },
  })
}

export type StackRow = { key: string; to: string; number: ReactNode; who: ReactNode; sub?: ReactNode; chip: ReactNode; due: ReactNode }

/**
 * Phone replacement for the wide tables (shown below 640px): number and customer on the first line,
 * the status chip and due date on the second. The number is the one real link, stretched over the row.
 */
export function StackedRows({ rows }: { rows: StackRow[] }) {
  return (
    <ul className="sm:hidden">
      {rows.map((r) => (
        <li key={r.key} className="relative flex flex-col gap-1.5 border-b border-secondary px-4 py-3 text-[13px] last:border-b-0 hover:bg-header">
          <div className="flex min-w-0 items-baseline gap-2">
            <Link to={r.to} className="num font-medium text-foreground no-underline after:absolute after:inset-0 after:content-['']">{r.number}</Link>
            <span className="min-w-0 truncate">{r.who}</span>
          </div>
          {r.sub && <span className={`${MUTED} truncate`}>{r.sub}</span>}
          <div className="flex flex-wrap items-center justify-between gap-2">{r.chip}<span className="num text-xs">{r.due}</span></div>
        </li>
      ))}
    </ul>
  )
}
