import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useI18n } from '@/i18n'
import { ApiError, isConflict } from '@/lib/api'
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
export function Segmented<T extends string>({ label, value, options, labels, onChange, disabled }: { label: string; value: T; options: readonly T[]; labels: Record<T, string>; onChange: (v: T) => void; disabled?: boolean }) {
  return (
    <div className="flex flex-col gap-1">
      <span className={LBL} id={`seg-${label}`}>{label}</span>
      <div role="group" aria-labelledby={`seg-${label}`} className="inline-flex overflow-hidden rounded-[7px] border border-input bg-card">
        {options.map((o) => (
          <button
            key={o} type="button" aria-pressed={value === o} disabled={disabled} onClick={() => onChange(o)}
            className={cn('h-8 cursor-pointer disabled:cursor-not-allowed disabled:opacity-60 border-r border-input px-3.5 text-[13px] font-medium last:border-r-0', value === o ? 'bg-status-blue text-status-blue-fg' : 'text-[#4A4741] hover:bg-secondary')}
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

/**
 * An edit form's session: the field values AND the version they were read at are captured together when editing starts.
 * A background refetch never changes the version that gets sent. After a 409 conflict_retry the stale values are
 * replaced with the fresh ones (once the refetch lands) and `conflict` stays true so the notice shows. `blocked` is true
 * only while waiting for that refetch, so no save goes out with stale values and Save works again once they're in.
 * `ready` is false while other queries the seed reads (the purchases list) are still refetching: waiting ends only when the version has moved AND they are in.
 * ponytail: waiting ends when the version moves; a conflict that leaves it unchanged would need the form closed and reopened.
 */
export function useEditSession<T>(current: number, seed: () => T, ready = true) {
  const [s, setS] = useState(() => ({ version: current, values: seed() }))
  // conflict = show the notice; waiting = the refetch hasn't landed yet, so saving is blocked.
  // They are separate so Save works again as soon as the fresh values are in (Codex review of 20692ec).
  const [conflict, setConflict] = useState(false)
  const [waiting, setWaiting] = useState(false)
  const latest = useRef(seed)
  latest.current = seed
  useEffect(() => {
    if (waiting && ready && current !== s.version) {
      setS({ version: current, values: latest.current() })
      setWaiting(false)
    }
  }, [waiting, ready, current, s.version])
  return {
    values: s.values, setValues: (values: T) => setS((x) => ({ ...x, values })), version: s.version, conflict,
    blocked: waiting,
    onError: (e: unknown) => { if (isConflict(e)) { setConflict(true); setWaiting(true) } },
    clear: () => setConflict(false),
  }
}

/** The translated notice shown after a conflict: the stale edits were discarded. */
export function ConflictNotice({ show }: { show: boolean }) {
  const { m } = useI18n()
  if (!show) return null
  return <p role="status" className="rounded-[7px] bg-status-amber px-2.5 py-2 text-[12.5px] text-status-amber-fg">{m.api.conflictReloaded}</p>
}

const FALLBACK_FOCUS = 'main'

/** A modal form: Enter submits, Esc cancels. Focus goes back to whatever opened it (or the page's main area if that element is gone). */

export function FormDialog({ open, onOpenChange, title, description, submitLabel, pendingLabel, pending, error, onSubmit, children, disabled }: {
  open: boolean; onOpenChange: (o: boolean) => void; title: string; description?: string; submitLabel: string; pendingLabel?: string; pending: boolean; error: Error | null
  onSubmit: () => void; children: ReactNode; disabled?: boolean
}) {
  const { m } = useI18n()
  const opener = useRef<Element | null>(null)
  if (opener.current === null && typeof document !== 'undefined') opener.current = document.activeElement
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!pending) onSubmit()
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-md"
        onCloseAutoFocus={(e) => {
          e.preventDefault()
          const restore = () => {
            const back = opener.current instanceof HTMLElement && opener.current.isConnected && opener.current !== document.body ? opener.current : document.querySelector<HTMLElement>(FALLBACK_FOCUS)
            if (back && !back.matches('button, a, input, select, textarea, [tabindex]')) back.tabIndex = -1
            back?.focus()
          }
          restore()
          // A save re-renders the page just after the dialog closes and can remove the opener (Record -> Revoke): if focus fell to the body, fall back.
          setTimeout(() => { if (!document.activeElement || document.activeElement === document.body) restore() }, 150)
        }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className={description ? undefined : 'sr-only'}>{description ?? title}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-3">
          {children}
          <MutationError error={error} />
          <div className="flex justify-end gap-2">
            <button type="button" className={BTN} onClick={() => onOpenChange(false)}>{m.common.cancel}</button>
            <button type="submit" disabled={pending || disabled} className={cn(BTN, BTN_PRIMARY)}>{pending ? (pendingLabel ?? m.common.saving) : submitLabel}</button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
