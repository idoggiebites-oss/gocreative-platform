import { useEffect, useState } from 'react'
import { businessToday } from '@shared/businessDate'
import type { CheckRecord, PaymentRecord, PaymentsResponse } from '@shared/api'
import { PAYMENT_METHODS, type PaymentMethod } from '@shared/enums'
import { formatCentsPlain, parseDollarsToCents } from '@shared/money'
import { useI18n } from '@/i18n'
import { isConflict, useCreateCheck, useMe, usePayments, useRecordPayment, useVoidPayment } from '@/lib/api'
import { cn } from '@/lib/utils'
import { CheckActions } from './CheckActions'
import { BTN, BTN_PRIMARY, BTN_SM, ConflictNotice, Field, FormDialog, H2, INPUT, SEC, TEXTAREA, useEditSession } from './form'
import QueryBoundary from './QueryBoundary'
import { CHECK_TONE, Chip, FINANCIAL_TONE, MUTED } from './ui'

const sm = cn(BTN, BTN_SM)
const smPrimary = cn(BTN, BTN_SM, BTN_PRIMARY)
type Live = { d: PaymentsResponse; fetching: boolean; onClose: () => void }
const cents = (v: string) => { const c = parseDollarsToCents(v); return c !== null && c >= 1 ? c : null }

function PaymentForm({ d, fetching, onClose }: Live) {
  const { m } = useI18n()
  const t = m.pay
  const w = useRecordPayment(d.number)
  const ed = useEditSession(d.version, () => ({
    amount: d.balance.outstandingCents ? formatCentsPlain(d.balance.outstandingCents) : '', method: 'check' as PaymentMethod, on: businessToday(new Date()), notes: '',
  }), !fetching)
  const f = ed.values
  const set = (x: Partial<typeof f>) => ed.setValues({ ...f, ...x })
  const amount = cents(f.amount)
  const [tried, setTried] = useState(false)
  return (
    <FormDialog
      open onOpenChange={(o) => !o && onClose()} title={t.record} description={t.recordBody} submitLabel={t.record} pending={w.isPending}
      error={isConflict(w.error) ? null : w.error} disabled={ed.blocked || d.state === 'cancelled'}
      onSubmit={() => {
        setTried(true)
        if (amount === null || !f.on) return
        ed.clear()
        w.mutateAsync({ amountCents: amount, method: f.method, paidOn: f.on, notes: f.notes.trim() || null, expectedVersion: ed.version }).then(onClose, ed.onError)
      }}
    >
      <ConflictNotice show={ed.conflict} />
      {d.state === 'cancelled' && <p role="alert" className="text-xs text-status-red-fg">{t.closedNote}</p>}
      <Field label={t.amount} hint={tried && amount === null ? t.amountInvalid : undefined}>
        <input className={cn(INPUT, 'num')} inputMode="decimal" required value={f.amount} aria-invalid={(tried && amount === null) || undefined} onChange={(e) => set({ amount: e.target.value })} />
      </Field>
      <Field label={t.method}>
        <select className={INPUT} value={f.method} onChange={(e) => set({ method: e.target.value as PaymentMethod })}>
          {PAYMENT_METHODS.map((k) => <option key={k} value={k}>{m.labels.paymentMethod[k]}</option>)}
        </select>
      </Field>
      <Field label={t.paidOn}><input className={INPUT} type="date" required value={f.on} onChange={(e) => set({ on: e.target.value })} /></Field>
      <Field label={t.notes}><textarea className={TEXTAREA} rows={2} maxLength={2000} value={f.notes} onChange={(e) => set({ notes: e.target.value })} /></Field>
    </FormDialog>
  )
}

/** Record payment for an order, from its tab or the Payments page. Reads the order's payments itself; closes if they can't load. */
export function RecordPaymentDialog({ number, onClose }: { number: string; onClose: () => void }) {
  const q = usePayments(number)
  useEffect(() => { if (q.isError && !q.data) onClose() }, [q.isError, q.data, onClose])
  return q.data ? <PaymentForm d={q.data} fetching={q.isFetching || q.isError} onClose={onClose} /> : null
}

function VoidDialog({ d, p, fetching, onClose }: Live & { p: PaymentRecord | undefined }) {
  const { m, fmt } = useI18n()
  const t = m.pay
  const w = useVoidPayment(d.number)
  const ed = useEditSession(d.version, () => '', !fetching)
  const gone = !p || !!p.voided
  return (
    <FormDialog
      open onOpenChange={(o) => !o && onClose()} title={t.voidTitle} description={p ? t.voidBody(fmt.money(p.amountCents)) : t.gone} submitLabel={t.voidConfirm} pending={w.isPending}
      error={isConflict(w.error) ? null : w.error} disabled={ed.blocked || gone || !ed.values.trim()}
      onSubmit={() => { if (!p) return; ed.clear(); w.mutate({ id: p.id, reason: ed.values.trim(), expectedVersion: ed.version }, { onSuccess: onClose, onError: ed.onError }) }}
    >
      <ConflictNotice show={ed.conflict} />
      {gone && <p role="alert" className="text-xs text-status-red-fg">{p ? t.voidGone : t.gone}</p>}
      <Field label={t.voidReason}><textarea className={TEXTAREA} rows={2} maxLength={500} required value={ed.values} onChange={(e) => ed.setValues(e.target.value)} /></Field>
    </FormDialog>
  )
}

function NewCheckDialog({ d, fetching, onClose }: Live) {
  const { m } = useI18n()
  const t = m.checks
  const w = useCreateCheck(d.number)
  const ed = useEditSession(d.version, () => ({ amount: d.balance.outstandingCents ? formatCentsPlain(d.balance.outstandingCents) : '', on: '', number: '', notes: '' }), !fetching)
  const f = ed.values
  const set = (x: Partial<typeof f>) => ed.setValues({ ...f, ...x })
  const amount = cents(f.amount)
  const [tried, setTried] = useState(false)
  return (
    <FormDialog
      open onOpenChange={(o) => !o && onClose()} title={t.new} description={t.newBody} submitLabel={t.new} pending={w.isPending}
      error={isConflict(w.error) ? null : w.error} disabled={ed.blocked || d.state === 'cancelled'}
      onSubmit={() => {
        setTried(true)
        if (amount === null) return
        ed.clear()
        w.mutate({ expectedCents: amount, availableOn: f.on || null, checkNumber: f.number.trim() || null, notes: f.notes.trim() || null, expectedVersion: ed.version }, { onSuccess: onClose, onError: ed.onError })
      }}
    >
      <ConflictNotice show={ed.conflict} />
      <Field label={t.expected} hint={tried && amount === null ? t.amountInvalid : undefined}>
        <input className={cn(INPUT, 'num')} inputMode="decimal" required value={f.amount} aria-invalid={(tried && amount === null) || undefined} onChange={(e) => set({ amount: e.target.value })} />
      </Field>
      <Field label={t.availableOn}><input className={INPUT} type="date" value={f.on} onChange={(e) => set({ on: e.target.value })} /></Field>
      <Field label={t.checkNumber}><input className={INPUT} maxLength={50} value={f.number} onChange={(e) => set({ number: e.target.value })} /></Field>
      <Field label={t.notes}><textarea className={TEXTAREA} rows={2} maxLength={2000} value={f.notes} onChange={(e) => set({ notes: e.target.value })} /></Field>
    </FormDialog>
  )
}

function Balance({ d }: { d: PaymentsResponse }) {
  const { m, fmt } = useI18n()
  const t = m.pay
  const b = d.balance
  const money = (c: number | null) => (c === null ? m.common.dash : fmt.money(c))
  const cells: [string, string][] = [[t.agreed, money(b.agreedCents)], [t.received, fmt.money(b.receivedCents)], [t.outstanding, money(b.outstandingCents)], [t.credit, fmt.money(b.creditCents)]]
  return (
    <div className="flex flex-col gap-2 px-4">
      <div className="flex flex-wrap items-center gap-2 text-[13px]">
        <Chip tone={FINANCIAL_TONE[b.status]}>{m.labels.financialStatus[b.status]}</Chip>
        <span className="text-muted-foreground">{m.labels.paymentTerms[d.paymentTerms]}</span>
        {d.paymentDueOn && <span className="num text-muted-foreground">{t.dueOn(fmt.date(d.paymentDueOn))}</span>}
      </div>
      <dl className="grid grid-cols-[repeat(auto-fit,minmax(120px,1fr))] gap-3">
        {cells.map(([k, v]) => <div key={k} className="flex flex-col gap-0.5"><dt className={MUTED}>{k}</dt><dd className="num text-lg font-semibold tracking-[-0.015em]">{v}</dd></div>)}
      </dl>
      {b.agreedCents === null && <p className={MUTED}>{t.noAgreed}</p>}
    </div>
  )
}

function PaymentRow({ p, owner, onVoid }: { p: PaymentRecord; owner: boolean; onVoid: () => void }) {
  const { m, fmt } = useI18n()
  const t = m.pay
  const v = p.voided
  return (
    <li data-payment={p.id} data-voided={v ? 'true' : undefined} className="flex flex-col gap-1 rounded-[10px] border border-secondary p-3 text-[13px]">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className={cn('num font-medium', v && 'text-muted-foreground line-through')}>{fmt.money(p.amountCents)}</span>
        <span>{m.labels.paymentMethod[p.method]}</span>
        <span className="num text-muted-foreground">{fmt.date(p.paidOn)}</span>
        {p.checkCollectionId !== null && <Chip tone="gray">{t.fromCheck}</Chip>}
        {v && <Chip tone="red">{t.voidedChip}</Chip>}
        <span className="grow" />
        {owner && !v && <button type="button" className={sm} aria-label={`${t.void}: ${fmt.money(p.amountCents)}`} onClick={onVoid}>{t.void}</button>}
      </div>
      {p.recordedBy && <span className={MUTED}>{t.recordedBy(p.recordedBy)}</span>}
      {p.notes && <span className={MUTED}>{p.notes}</span>}
      {v && <span className="text-xs text-status-red-fg">{t.voidedLine(v.by ?? m.common.dash, fmt.date(v.at), v.reason)}</span>}
    </li>
  )
}

function CheckRow({ k }: { k: CheckRecord }) {
  const { m, fmt } = useI18n()
  const t = m.checks
  const received = k.amountReceivedCents
  return (
    <li data-check={k.id} className="flex flex-col gap-2 rounded-[10px] border border-secondary p-3 text-[13px]">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-medium">{k.checkNumber ? t.number(k.checkNumber) : t.noNumber}</span>
        <Chip tone={CHECK_TONE[k.status]}>{m.labels.checkStatus[k.status]}</Chip>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        <span className="num">{t.expectedLine(fmt.money(k.expectedCents))}</span>
        {received !== null && (received === k.expectedCents ? <span className="num">{t.receivedLine(fmt.money(received))}</span> : <span className="num font-medium text-status-amber-fg">{t.differs(fmt.money(received), fmt.money(k.expectedCents))}</span>)}
        <span className={cn(MUTED, 'num')}>{k.availableOn ? t.available(fmt.date(k.availableOn)) : t.notAvailable}</span>
        {k.collectedAt && <span className={cn(MUTED, 'num')}>{k.collectedBy ? t.collectedLine(fmt.date(k.collectedAt), k.collectedBy) : t.collectedNoName(fmt.date(k.collectedAt))}</span>}
        {k.depositedOn && <span className={cn(MUTED, 'num')}>{t.depositedLine(fmt.date(k.depositedOn))}</span>}
        {k.clearedOn && <span className={cn(MUTED, 'num')}>{t.clearedLine(fmt.date(k.clearedOn))}</span>}
      </div>
      {k.notes && <span className={MUTED}>{k.notes}</span>}
      <CheckActions check={k} />
    </li>
  )
}

type Dialog = { kind: 'pay' | 'check' } | { kind: 'void'; id: number }

function Panel({ d, fetching }: { d: PaymentsResponse; fetching: boolean }) {
  const { m } = useI18n()
  const me = useMe()
  const owner = me.data?.role === 'owner'
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const close = () => setDialog(null)
  const live: Live = { d, fetching, onClose: close }
  const cancelled = d.state === 'cancelled'
  const afterPickup = d.paymentTerms === 'due_after_pickup'
  return (
    <div className="flex flex-col gap-3 pb-4">
      <div className={SEC}>
        <h2 className={H2}>{m.pay.title}</h2>
        <button type="button" className={smPrimary} disabled={cancelled} onClick={() => setDialog({ kind: 'pay' })}>{m.pay.record}</button>
      </div>
      <Balance d={d} />
      <div className="flex flex-col gap-2 px-4">
        <h3 className="text-[13px] font-semibold">{m.pay.listTitle}</h3>
        {cancelled && <p className={MUTED}>{m.pay.closedNote}</p>}
        {d.payments.length === 0 ? <p className="text-[13px] text-muted-foreground">{m.pay.empty}</p> : (
          <ul aria-label={m.pay.listTitle} className="flex flex-col gap-2">{d.payments.map((p) => <PaymentRow key={p.id} p={p} owner={owner} onVoid={() => setDialog({ kind: 'void', id: p.id })} />)}</ul>
        )}
      </div>
      <div className="flex flex-col gap-2 px-4">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-[13px] font-semibold">{m.checks.title}</h3>
          {afterPickup && <button type="button" className={sm} disabled={cancelled} onClick={() => setDialog({ kind: 'check' })}>{m.checks.new}</button>}
        </div>
        {!afterPickup && d.checks.length === 0 ? <p className="text-[13px] text-muted-foreground">{m.checks.notForTerms}</p>
          : d.checks.length === 0 ? <p className="text-[13px] text-muted-foreground">{m.checks.empty}</p>
          : <ul aria-label={m.checks.title} className="flex flex-col gap-2">{d.checks.map((k) => <CheckRow key={k.id} k={k} />)}</ul>}
      </div>
      {dialog?.kind === 'pay' && <PaymentForm {...live} />}
      {dialog?.kind === 'void' && <VoidDialog {...live} p={d.payments.find((x) => x.id === dialog.id)} />}
      {dialog?.kind === 'check' && <NewCheckDialog {...live} />}
    </div>
  )
}

export function PaymentsTab({ number }: { number: string }) {
  const query = usePayments(number)
  return <QueryBoundary query={query}>{(d) => <Panel d={d} fetching={query.isFetching || query.isError} />}</QueryBoundary>
}
