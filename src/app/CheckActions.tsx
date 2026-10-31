import { useState } from 'react'
import type { CheckRecord } from '@shared/api'
import { formatCentsPlain, parseDollarsToCents } from '@shared/money'
import { useI18n } from '@/i18n'
import { useCheckReady, useClearCheck, useCollectCheck, useDepositCheck } from '@/lib/api'
import { cn } from '@/lib/utils'
import { BTN, BTN_PRIMARY, BTN_SM, Field, FormDialog, INPUT, MutationError } from './form'

const sm = cn(BTN, BTN_SM)
const smPrimary = cn(BTN, BTN_SM, BTN_PRIMARY)
/** The few fields the actions need, so the dashboard (which only knows the id and expected amount) can use them too. */
export type CheckLike = Pick<CheckRecord, 'id' | 'orderNumber' | 'status' | 'expectedCents' | 'checkNumber'>

function CollectDialog({ check, onClose }: { check: CheckLike; onClose: () => void }) {
  const { m, fmt } = useI18n()
  const t = m.checks
  const w = useCollectCheck()
  const [amount, setAmount] = useState(formatCentsPlain(check.expectedCents))
  const [number, setNumber] = useState(check.checkNumber ?? '')
  const cents = parseDollarsToCents(amount)
  const valid = cents !== null && cents >= 1
  // The check moves are guarded by the check's own status, so the live status (from the parent's query) decides.
  const gone = check.status !== 'ready_for_collection'
  return (
    <FormDialog
      open onOpenChange={(o) => !o && onClose()} title={t.collect} description={t.collectBody} submitLabel={t.collect} pending={w.isPending}
      error={w.error} disabled={gone || !valid}
      onSubmit={() => { if (valid) w.mutate({ id: check.id, amountReceivedCents: cents, checkNumber: number.trim() || null }, { onSuccess: onClose }) }}
    >
      {gone && <p role="alert" className="text-xs text-status-red-fg">{t.gone}</p>}
      <p className="text-[13px] text-muted-foreground">{t.expectedLine(fmt.money(check.expectedCents))}</p>
      <Field label={t.amountReceived} hint={amount.trim() !== '' && !valid ? t.amountInvalid : undefined}>
        <input className={cn(INPUT, 'num')} inputMode="decimal" required value={amount} aria-invalid={!valid || undefined} onChange={(e) => setAmount(e.target.value)} />
      </Field>
      {valid && cents !== check.expectedCents && <p role="status" className="rounded-[7px] bg-status-amber px-2.5 py-2 text-[12.5px] text-status-amber-fg">{t.differsWarning(fmt.money(check.expectedCents))}</p>}
      <Field label={t.checkNumber}><input className={INPUT} maxLength={50} value={number} onChange={(e) => setNumber(e.target.value)} /></Field>
    </FormDialog>
  )
}

/**
 * The next action for one check, by its status: Mark ready, Record collection (opens a dialog), Mark deposited, Mark cleared.
 * The one component behind the Payments page and the order's Checks list. Clicks refetch everything on screen; a refusal
 * shows its translated text until the next click.
 */
export function CheckActions({ check }: { check: CheckLike }) {
  const { m, fmt } = useI18n()
  const t = m.checks
  const ready = useCheckReady()
  const deposit = useDepositCheck()
  const clear = useClearCheck()
  const [dialog, setDialog] = useState(false)
  const [clickError, setClickError] = useState<Error | null>(null)
  const busy = ready.isPending || deposit.isPending || clear.isPending
  const aria = (a: string) => t.ariaFor(a, check.orderNumber, fmt.money(check.expectedCents))
  const go = (mut: { mutate: (v: { id: number }, o: { onError: (e: Error) => void }) => void }) => {
    if (busy) return
    setClickError(null)
    mut.mutate({ id: check.id }, { onError: setClickError })
  }
  const s = check.status
  const one = (label: string, mut: Parameters<typeof go>[0], primary = true) => (
    <button type="button" className={primary ? smPrimary : sm} aria-label={aria(label)} aria-busy={busy || undefined} onClick={() => go(mut)}>{label}</button>
  )
  if (s === 'cleared') return null
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        {s === 'awaiting_payment' && one(t.ready, ready, false)}
        {s === 'ready_for_collection' && <button type="button" className={smPrimary} aria-label={aria(t.collect)} onClick={() => setDialog(true)}>{t.collect}</button>}
        {s === 'collected' && one(t.deposit, deposit)}
        {s === 'deposited' && one(t.clear, clear)}
      </div>
      <MutationError error={clickError} />
      {dialog && <CollectDialog check={check} onClose={() => setDialog(false)} />}
    </div>
  )
}
