import type { FormEvent, ReactNode } from 'react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useI18n } from '@/i18n'
import { ApiError } from '@/lib/api'
import { cn } from '@/lib/utils'

// The mockups' form controls: 34px fields, 32px buttons, 28px small buttons.
export const INPUT = 'h-[34px] min-w-0 rounded-[7px] border border-input bg-card px-2.5 text-[13px] text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/40 disabled:bg-header aria-invalid:border-status-red-fg read-only:bg-header'
export const TEXTAREA = 'min-w-0 rounded-[7px] border border-input bg-card px-2.5 py-2 text-[13px] text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/40'
export const LBL = 'text-xs text-muted-foreground'
export const BTN = 'inline-flex h-8 items-center justify-center gap-1.5 rounded-[7px] border border-input bg-card px-3 text-[13px] font-medium whitespace-nowrap text-foreground no-underline hover:bg-secondary disabled:cursor-not-allowed disabled:bg-header disabled:text-muted-foreground aria-busy:opacity-60'
export const BTN_PRIMARY = 'border-primary bg-primary text-primary-foreground hover:bg-(--brand-hover) hover:text-primary-foreground disabled:border-input'
export const BTN_SM = 'h-7 px-2.5 text-[12.5px]'
export const LINK = 'text-primary no-underline hover:text-(--brand-hover)'
export const SEC = 'flex items-center justify-between gap-2 px-4 pt-3.5 pb-2.5'
export const H2 = 'text-sm font-semibold'

export function Field({ label, children, className, hint }: { label: ReactNode; children: ReactNode; className?: string; hint?: ReactNode }) {
  return (
    <label className={cn('flex min-w-0 flex-col gap-1', className)}>
      <span className={LBL}>{label}</span>
      {children}
      {hint && <span className={LBL}>{hint}</span>}
    </label>
  )
}

export function Check({ checked, onChange, children }: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode }) {
  return (
    <label className="inline-flex h-[34px] items-center gap-2 text-[13px]">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="size-4 accent-primary" />
      {children}
    </label>
  )
}

/** A one-of-N button group (the mockup's `.seg`). */
export function Segmented<T extends string>({ label, value, options, labels, onChange }: { label: string; value: T; options: readonly T[]; labels: Record<T, string>; onChange: (v: T) => void }) {
  return (
    <div className="flex flex-col gap-1">
      <span className={LBL} id={`seg-${label}`}>{label}</span>
      <div role="group" aria-labelledby={`seg-${label}`} className="inline-flex overflow-hidden rounded-[7px] border border-input bg-card">
        {options.map((o) => (
          <button
            key={o} type="button" aria-pressed={value === o} onClick={() => onChange(o)}
            className={cn('h-8 cursor-pointer border-r border-input px-3.5 text-[13px] font-medium last:border-r-0', value === o ? 'bg-status-blue text-status-blue-fg' : 'text-[#4A4741] hover:bg-secondary')}
          >
            {labels[o]}
          </button>
        ))}
      </div>
    </div>
  )
}

/**
 * The server's refusal, as translated text only (the server's English `error` is for logs).
 * `conflict_retry` also says the page was reloaded: every write refetches on settle.
 */
export function MutationError({ error }: { error: Error | null }) {
  const { m } = useI18n()
  if (!error) return null
  const refused = error instanceof ApiError && error.status === 409
  const codes: Record<string, string | undefined> = m.api.errors
  const reasons: Record<string, string | undefined> = m.order.gate.reasons
  const detail = error instanceof ApiError
    ? [error.body.code ? codes[error.body.code] : undefined, ...(error.body.reasons ?? []).map((r) => reasons[r] ?? m.api.unknownReason)].filter(Boolean).join(' ')
    : ''
  return (
    <span role="alert" className="text-xs text-status-red-fg">
      {refused ? m.api.changeRefused : m.api.changeFailed}{detail && <> <span className="opacity-80">{detail}</span></>}
    </span>
  )
}

/** A modal form: Enter submits, Esc cancels. */
export function FormDialog({ open, onOpenChange, title, description, submitLabel, pending, error, onSubmit, children, disabled }: {
  open: boolean; onOpenChange: (o: boolean) => void; title: string; description?: string; submitLabel: string; pending: boolean; error: Error | null
  onSubmit: () => void; children: ReactNode; disabled?: boolean
}) {
  const { m } = useI18n()
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!pending) onSubmit()
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className={description ? undefined : 'sr-only'}>{description ?? title}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-3">
          {children}
          <MutationError error={error} />
          <div className="flex justify-end gap-2">
            <button type="button" className={BTN} onClick={() => onOpenChange(false)}>{m.common.cancel}</button>
            <button type="submit" disabled={pending || disabled} className={cn(BTN, BTN_PRIMARY)}>{pending ? m.common.saving : submitLabel}</button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
