import { useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router'
import { Lock, Info } from 'lucide-react'
import type { OrderDetailResponse, OrderItem, OrderWriteResponse } from '@shared/api'
import { AUTHORIZATION_METHODS, ORDER_SOURCES, PAYMENT_TERMS, type AuthorizationMethod, type OrderSource, type PaymentTerms, type PrepStatus, type QuoteStatus } from '@shared/enums'
import { useI18n } from '@/i18n'
import { isConflict, send, useChangePrep, useCustomer, useSend, useUsers } from '@/lib/api'
import { cn } from '@/lib/utils'
import { acceptBlockCode, quoteActionsOpen } from '../../worker/domain/quotes'
import { BTN, BTN_PRIMARY, BTN_SM, Check, ConflictNotice, Field, FormDialog, H2, INPUT, MutationError, SEC, TEXTAREA, useEditSession } from './form'
import { ItemsEditor, rowsFromItems, rowsInvalid, toInputs } from './ItemsEditor'
import { CARD, Chip, MUTED, QUOTE_TONE, TD, TH, type Tone } from './ui'

type Detail = OrderDetailResponse
const STARTED = ['in_production', 'quality_control', 'production_complete']
/** Why a quote's lines cannot be accepted yet (translated), or null. Same pure rule the server enforces. */
export const acceptBlockReason = (items: readonly OrderItem[], t: { no_product_line: string; invalid: string }) => {
  const code = acceptBlockCode(items)
  return code && t[code]
}

const sm = cn(BTN, BTN_SM)
const smPrimary = cn(BTN, BTN_SM, BTN_PRIMARY)

/**
 * One write against this order. The version sent is `version` (default: the one on the detail the screen was rendered from).
 * Anything with editable fields passes the version captured when editing started, so a background refetch cannot change it:
 * a stale form gets a 409 conflict_retry, which is shown (translated) while the refetch brings the new state.
 */
export function useOrderWrite(d: Detail, version = d.order.version) {
  const base = `/orders/${encodeURIComponent(d.order.number)}`
  return useSend<OrderWriteResponse, { method: 'POST' | 'PUT' | 'PATCH' | 'DELETE'; sub?: string; body?: object }>(
    // Notes and repeat deliberately take no version (they never conflict with an edit).
    ({ method, sub = '', body }) => send(method, `${base}${sub}`, sub === '/notes' || sub === '/repeat' ? body : { ...body, expectedVersion: version }),
  )
}

/** For dialogs: the version is fixed when the dialog opens. */
const useDialogWrite = (d: Detail) => useOrderWrite(d, useState(d.order.version)[0])

// A product line reads "Product · Color"; a charge or discount line shows its description (or its kind).
export const lineTitle = (i: OrderItem, kindLabel: string) =>
  i.product ? (i.garmentColor ? `${i.product} · ${i.garmentColor}` : i.product) : (i.description ?? kindLabel)

// ---------------------------------------------------------------- dialogs

function AuthorizeDialog({ d, onClose }: { d: Detail; onClose: () => void }) {
  const { m } = useI18n()
  const [method, setMethod] = useState<AuthorizationMethod>('phone')
  const [notes, setNotes] = useState('')
  const w = useDialogWrite(d)
  return (
    <FormDialog
      open onOpenChange={(o) => !o && onClose()} title={m.order.auth.recordTitle} description={m.order.auth.recordBody} submitLabel={m.order.auth.record}
      pending={w.isPending} error={w.error}
      onSubmit={() => w.mutate({ method: 'POST', sub: '/authorization', body: { method, notes: notes.trim() || null } }, { onSuccess: onClose })}
    >
      <Field label={m.order.auth.method}>
        <select className={INPUT} value={method} onChange={(e) => setMethod(e.target.value as AuthorizationMethod)}>
          {AUTHORIZATION_METHODS.map((k) => <option key={k} value={k}>{m.labels.authorizationMethod[k]}</option>)}
        </select>
      </Field>
      <Field label={m.order.auth.notes}><textarea className={TEXTAREA} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
    </FormDialog>
  )
}

/** A dialog that asks for a required reason and sends it (revoke authorization, cancel order). */
function ReasonDialog({ d, onClose, title, body, label, submit, method, sub }: {
  d: Detail; onClose: () => void; title: string; body: string; label: string; submit: string; method: 'POST' | 'DELETE'; sub: string
}) {
  const { m } = useI18n()
  const [reason, setReason] = useState('')
  const w = useDialogWrite(d)
  return (
    <FormDialog
      open onOpenChange={(o) => !o && onClose()} title={title} description={body} submitLabel={submit} pending={w.isPending} error={w.error} disabled={!reason.trim()}
      onSubmit={() => w.mutate({ method, sub, body: { reason: reason.trim() } }, { onSuccess: onClose })}
    >
      <Field label={label} hint={m.order.reasonHint}><textarea className={TEXTAREA} rows={3} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
    </FormDialog>
  )
}

function NoPurchasingDialog({ d, onClose }: { d: Detail; onClose: () => void }) {
  const { m } = useI18n()
  const w = useDialogWrite(d)
  return (
    <FormDialog
      open onOpenChange={(o) => !o && onClose()} title={m.order.readiness.noPurchasingTitle} description={m.order.readiness.noPurchasingBody} submitLabel={m.order.readiness.noPurchasingConfirm}
      pending={w.isPending} error={w.error}
      onSubmit={() => w.mutate({ method: 'PATCH', body: { materialsRequired: false, confirmNoPurchasing: true } }, { onSuccess: onClose })}
    >
      <p className="text-[13px] text-muted-foreground">{m.order.readiness.noPurchasingBody}</p>
    </FormDialog>
  )
}

function RepeatDialog({ d, onClose }: { d: Detail; onClose: () => void }) {
  const { m } = useI18n()
  const navigate = useNavigate()
  const [source, setSource] = useState<OrderSource>(d.order.source)
  const [due, setDue] = useState('')
  const w = useOrderWrite(d)
  return (
    <FormDialog
      open onOpenChange={(o) => !o && onClose()} title={m.order.repeat.title} description={m.order.repeat.body} submitLabel={m.order.repeat.submit} pending={w.isPending} error={w.error}
      onSubmit={() => w.mutate({ method: 'POST', sub: '/repeat', body: { source, dueDate: due || null } }, { onSuccess: (r) => { onClose(); void navigate(`/app/orders/${r.number}`) } })}
    >
      <Field label={m.order.detail.source}>
        <select className={INPUT} value={source} onChange={(e) => setSource(e.target.value as OrderSource)}>
          {ORDER_SOURCES.map((k) => <option key={k} value={k}>{m.labels.orderSource[k]}</option>)}
        </select>
      </Field>
      <Field label={m.newOrder.dueDate}><input className={INPUT} type="date" value={due} onChange={(e) => setDue(e.target.value)} /></Field>
    </FormDialog>
  )
}

/** Cancel / Reopen / Repeat, in the page header. */
export function OrderActions({ d }: { d: Detail }) {
  const { m } = useI18n()
  const [dialog, setDialog] = useState<'cancel' | 'repeat' | null>(null)
  const reopen = useOrderWrite(d)
  const { state } = d.order
  return (
    <div className="flex flex-wrap items-center gap-2">
      <button type="button" className={BTN} onClick={() => setDialog('repeat')}>{m.order.repeat.button}</button>
      {state === 'active' && <button type="button" className={BTN} onClick={() => setDialog('cancel')}>{m.order.cancel.button}</button>}
      {state === 'cancelled' && <button type="button" className={BTN} aria-busy={reopen.isPending || undefined} onClick={() => reopen.mutate({ method: 'POST', sub: '/reopen' })}>{m.order.reopen}</button>}
      <MutationError error={reopen.error} />
      {dialog === 'cancel' && <ReasonDialog d={d} onClose={() => setDialog(null)} title={m.order.cancel.title} body={m.order.cancel.body} label={m.order.cancel.reason} submit={m.order.cancel.submit} method="POST" sub="/cancel" />}
      {dialog === 'repeat' && <RepeatDialog d={d} onClose={() => setDialog(null)} />}
    </div>
  )
}

// ---------------------------------------------------------------- readiness

const STATE_TONE: Record<'complete' | 'pending' | 'not_required', Tone> = { complete: 'green', pending: 'amber', not_required: 'gray' }

export function ReadinessCard({ d, po, goTab, addPurchase }: { d: Detail; po: ReactNode; goTab: (t: 'po' | 'artwork') => void; addPurchase: () => void }) {
  const { m, fmt } = useI18n()
  const t = m.order.readiness
  const w = useOrderWrite(d)
  const prep = useChangePrep(d.order.number)
  const [dialog, setDialog] = useState<'auth' | 'nopurchasing' | null>(null)
  const { order, quote } = d
  const active = order.state === 'active'
  const stale = !!quote && quote.itemsRevision !== order.itemsRevision
  const reasons: Record<string, string | undefined> = m.order.gate.reasons
  const done = d.readiness.items.filter((i) => i.state !== 'pending').length
  const run = (method: 'POST' | 'PATCH', sub: string | undefined, body?: object) => w.mutate({ method, sub, body })
  const busy = w.isPending || undefined

  const actions = (key: string, state: string, reason?: string): ReactNode => {
    if (!active) return null
    const btn = (label: string, onClick: () => void, primary = false, disabled = false) => (
      <button type="button" className={primary ? smPrimary : sm} aria-busy={busy} disabled={disabled} onClick={() => !w.isPending && onClick()}>{label}</button>
    )
    if (key === 'quote' && state === 'pending') {
      if (!quoteActionsOpen(order)) return null
      const newVersion = btn(t.newVersion, () => run('POST', '/quotes'))
      if (reason === 'no_quote') return btn(t.createQuote, () => run('POST', '/quotes'), true)
      if (reason === 'not_accepted' && quote && (quote.status === 'draft' || quote.status === 'sent')) {
        if (stale) return newVersion
        const block = acceptBlockReason(quote.items, m.order.quote.acceptBlocked)
        return <>{btn(t.acceptQuote, () => run('PATCH', `/quotes/${quote.version}`, { to: 'accepted' }), true, !!block)}{block && <span className={MUTED}>{block}</span>}</>
      }
      return newVersion
    }
    if (key === 'authorization') {
      if (order.poRequired) return d.purchaseOrders.length > 0 ? btn(m.order.gate.viewPo, () => goTab('po')) : btn(m.files.po.request, () => goTab('po'), true)
      return state === 'pending' ? btn(t.recordAuthorization, () => setDialog('auth'), true) : null
    }
    if (key === 'artwork') {
      if (state === 'pending') return <>{btn(t.artworkNotRequired, () => run('PATCH', undefined, { artworkRequired: false }))}{btn(t.uploadArtwork, () => goTab('artwork'), true)}</>
      if (state === 'not_required') return btn(t.artworkRequired, () => run('PATCH', undefined, { artworkRequired: true }))
    }
    if (key === 'materials' && state === 'pending') return <>{btn(t.noPurchasing, () => setDialog('nopurchasing'))}{btn(t.addPurchase, addPurchase, true)}</>
    if (key === 'preparation') {
      const setPrep = (prepStatus: PrepStatus) => !prep.isPending && prep.mutate({ prepStatus, expectedVersion: order.version })
      const pb = (label: string, to: PrepStatus, primary = false) => <button type="button" className={primary ? smPrimary : sm} aria-busy={prep.isPending || undefined} disabled={prep.isPending || order.state !== 'active'} onClick={() => setPrep(to)}>{label}</button>
      if (state === 'pending') return <>{order.prepStatus === 'in_progress' ? null : pb(t.startPrep, 'in_progress')}{pb(t.markReady, 'ready', true)}{pb(t.prepNotRequired, 'not_required')}</>
      if (state === 'not_required') return pb(t.prepRequired, 'not_started')
    }
    return null
  }

  const why = (key: string, state: string, reason?: string): string => {
    if (state === 'pending') return reasons[`${key}.${reason}`] ?? m.api.unknownReason
    if (state === 'not_required') return t.notRequiredWhy[key as keyof typeof t.notRequiredWhy]
    if (key === 'quote' && quote) return t.quoteDone(quote.version, fmt.date(quote.decidedAt ?? quote.createdAt))
    if (key === 'authorization') {
      return order.poRequired ? t.poDone : t.authDone[order.authorizationMethod ?? 'unknown'](order.authorizedAt ? fmt.date(order.authorizedAt) : m.common.dash)
    }
    return t.done[key as keyof typeof t.done]
  }

  return (
    <section className={CARD} aria-labelledby="rdy">
      <div className={cn(SEC, 'border-b border-secondary pb-3')}>
        <h2 id="rdy" className={H2}>{t.title}</h2>
        <span className={MUTED}>{t.summary(done, d.readiness.items.length)}</span>
      </div>
      {d.readiness.items.map((it) => (
        <div key={it.key} data-readiness={it.key} className="flex flex-wrap items-center gap-x-3.5 gap-y-2.5 border-b border-secondary px-4 py-2.5 text-[13px] last:border-b-0">
          <span className="w-[170px] flex-none font-medium">{t.names[it.key]}</span>
          <span className="w-[112px] flex-none"><Chip tone={STATE_TONE[it.state]}>{t.state[it.state]}</Chip></span>
          <span className="min-w-0 flex-[1_1_240px] text-[#4A4741]">{why(it.key, it.state, it.reason)}</span>
          <span className="flex flex-wrap items-center gap-1.5">
            {it.key === 'authorization' && order.poRequired && po}
            {actions(it.key, it.state, it.reason)}
          </span>
        </div>
      ))}
      <div className="px-4 py-2 empty:hidden"><MutationError error={w.error} /><MutationError error={prep.error} /></div>
      {dialog === 'auth' && <AuthorizeDialog d={d} onClose={() => setDialog(null)} />}
      {dialog === 'nopurchasing' && <NoPurchasingDialog d={d} onClose={() => setDialog(null)} />}
    </section>
  )
}

// ---------------------------------------------------------------- items & quote

function ItemsTable({ d }: { d: Detail }) {
  const { m, fmt } = useI18n()
  const t = m.order.items
  if (d.items.length === 0) return <p className="px-4 py-8 text-center text-[13px] text-muted-foreground">{t.empty}</p>
  const signed = (i: Detail['items'][number]) => (i.kind === 'discount' ? -1 : 1) * i.quantity * i.unitPriceCents
  const total = d.items.reduce((s, i) => s + signed(i), 0)
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[13px]">
        <thead><tr>
          <th className={TH}>{t.product}</th><th className={TH}>{t.sizes}</th>
          <th className={cn(TH, 'text-right')}>{t.qty}</th><th className={cn(TH, 'text-right')}>{t.unit}</th><th className={cn(TH, 'text-right')}>{t.total}</th>
        </tr></thead>
        <tbody>
          {d.items.map((i) => (
            <tr key={i.id} className="align-top">
              <td className="border-b border-secondary p-3">
                <div className="flex min-w-[190px] flex-col gap-[3px]">
                  <span className="font-medium">{lineTitle(i, m.labels.itemKind[i.kind])}</span>
                  <span className={MUTED}>{i.method ? m.labels.method[i.method] : m.labels.itemKind[i.kind]}{i.product && i.description ? ` · ${i.description}` : ''}{i.notes ? ` · ${i.notes}` : ''}</span>
                </div>
              </td>
              <td className="border-b border-secondary p-3">
                {i.sizes && (
                  <div className="grid grid-cols-[repeat(9,minmax(34px,auto))] gap-0.5 text-xs">
                    {Object.entries(i.sizes).map(([size, n]) => (
                      <span key={size} className="num flex flex-col items-center rounded-[5px] bg-background px-1 py-[3px]">
                        <b className="text-[10.5px] font-medium text-muted-foreground">{size}</b>{n}
                      </span>
                    ))}
                  </div>
                )}
              </td>
              <td className="num border-b border-secondary p-3 text-right">{i.quantity}</td>
              <td className="num border-b border-secondary p-3 text-right">{fmt.money(i.unitPriceCents)}</td>
              <td className="num border-b border-secondary p-3 text-right font-medium">{fmt.money(signed(i))}</td>
            </tr>
          ))}
          <tr>
            <td colSpan={4} className="p-3 text-right text-muted-foreground">{t.itemsTotal}</td>
            <td className="num p-3 text-right font-semibold">{fmt.money(total)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  )
}

function ItemsEdit({ d, onDone }: { d: Detail; onDone: () => void }) {
  const { m } = useI18n()
  const t = m.order.items
  const [tried, setTried] = useState(false)
  const ed = useEditSession(d.order.version, () => rowsFromItems(d.items))
  const rows = ed.values
  const w = useOrderWrite(d, ed.version)
  const invalid = rowsInvalid(rows)
  return (
    <div className="flex flex-col gap-3 p-4">
      <ConflictNotice show={ed.conflict} />
      <ItemsEditor rows={rows} onChange={ed.setValues} showIssues={tried} framed={false} />
      <p className={MUTED}>{t.reapprovalNote}</p>
      <div className="flex flex-wrap items-center justify-end gap-2">
        <MutationError error={isConflict(w.error) ? null : w.error} />
        <button type="button" className={BTN} onClick={onDone}>{m.common.cancel}</button>
        <button
          type="button" className={cn(BTN, BTN_PRIMARY)} disabled={w.isPending || ed.blocked}
          onClick={() => {
            setTried(true)
            if (invalid) return
            ed.clear()
            w.mutate({ method: 'PUT', sub: '/items', body: { items: toInputs(rows) } }, { onSuccess: onDone, onError: ed.onError })
          }}
        >{w.isPending ? m.common.saving : t.saveItems}</button>
      </div>
    </div>
  )
}

function ItemsSection({ d }: { d: Detail }) {
  const { m } = useI18n()
  const t = m.order.items
  const [editing, setEditing] = useState(false)
  const started = STARTED.includes(d.order.productionStatus)
  const blocked = d.order.state !== 'active' ? m.api.errors.order_not_active : started ? m.api.errors.production_started : null
  if (editing) return <ItemsEdit d={d} onDone={() => setEditing(false)} />
  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 pt-3">
        <h2 className={H2}>{m.order.tabs.items}</h2>
        <span className="flex flex-wrap items-center gap-2">
          {blocked && <span className={MUTED}>{t.editBlocked(blocked)}</span>}
          <button type="button" className={sm} disabled={!!blocked} onClick={() => setEditing(true)}>{t.edit}</button>
        </span>
      </div>
      <ItemsTable d={d} />
    </div>
  )
}

const dateOf = (iso: string | null) => iso

function QuotePanel({ d }: { d: Detail }) {
  const { m, fmt } = useI18n()
  const t = m.order.quote
  const q = d.quote
  const w = useOrderWrite(d)
  const { order } = d
  const active = order.state === 'active'
  const canMake = quoteActionsOpen(order)
  const stale = !!q && q.itemsRevision !== order.itemsRevision
  const run = (sub: string, method: 'POST' | 'PATCH' = 'POST', body?: object) => !w.isPending && w.mutate({ method, sub, body })
  const status = (to: 'sent' | 'accepted' | 'declined') => run(`/quotes/${q!.version}`, 'PATCH', { to })
  const totals: [string, number][] = q ? [[t.subtotal, q.subtotalCents], ...(q.chargesCents ? [[t.charges, q.chargesCents] as [string, number]] : []), ...(q.discountsCents ? [[t.discounts, -q.discountsCents] as [string, number]] : [])] : []
  const s: QuoteStatus | null = q?.status ?? null
  const open = s === 'draft' || s === 'sent'
  const acceptBlock = q && open ? acceptBlockReason(q.items, t.acceptBlocked) : null
  return (
    <div className="flex flex-col gap-2 border-t border-border px-4 py-3.5 text-[13px]">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-[13px] font-semibold">{t.versions}</h3>
        <span className="flex flex-wrap gap-2">
          {q && <button type="button" className={sm} disabled={!canMake} aria-busy={w.isPending || undefined} onClick={() => run(`/quotes/${q.version}/duplicate`)}>{t.duplicate}</button>}
          <button type="button" className={smPrimary} disabled={!canMake} aria-busy={w.isPending || undefined} onClick={() => run('/quotes')}>{t.newVersion}</button>
        </span>
      </div>
      {!q && <p className="py-2 text-muted-foreground">{t.empty}</p>}
      {q && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-secondary py-2.5">
          <b className="num w-7">v{q.version}</b>
          <Chip tone={QUOTE_TONE[q.status]}>{m.labels.quoteStatus[q.status]}</Chip>
          <span className={cn(MUTED, 'flex-[1_1_200px]')}>
            <span className="num">{fmt.money(q.totalCents)}</span>
            {q.sentAt && <> · {t.sent(fmt.date(dateOf(q.sentAt)!))}</>}
            {(q.status === 'accepted' || q.status === 'declined') && q.decidedAt && <> · {t.decided[q.status](fmt.date(q.decidedAt))}</>}
          </span>
          {q.status === 'accepted' && <span className={cn(MUTED, 'inline-flex items-center gap-1')}><Lock className="size-3.5" strokeWidth={1.9} aria-hidden />{t.locked}</span>}
          <span className="flex flex-wrap gap-1.5">
            {q.status === 'draft' && <button type="button" className={sm} disabled={!canMake} onClick={() => run(`/quotes/${q.version}/refresh`)}>{t.refresh}</button>}
            {q.status === 'draft' && <button type="button" className={sm} disabled={!active} onClick={() => status('sent')}>{t.markSent}</button>}
            {open && <button type="button" className={smPrimary} disabled={!active || stale || !!acceptBlock} title={stale ? t.staleDraft : (acceptBlock ?? undefined)} onClick={() => status('accepted')}>{t.accept}</button>}
            {open && <button type="button" className={sm} disabled={!active} onClick={() => status('declined')}>{t.decline}</button>}
          </span>
        </div>
      )}
      {q && stale && (
        <p role="status" className="flex items-start gap-2 rounded-[7px] bg-status-amber px-2.5 py-2 text-[12.5px] text-status-amber-fg">
          <Info className="mt-px size-4 shrink-0" strokeWidth={1.9} aria-hidden />{q.status === 'accepted' ? t.stale : t.staleDraft}
        </p>
      )}
      {acceptBlock && !stale && <p className={MUTED}>{acceptBlock}</p>}
      <MutationError error={w.error} />
      {q && q.items.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse"><thead><tr>
            <th className={TH}>{t.line}</th><th className={cn(TH, 'text-right')}>{t.qty}</th><th className={cn(TH, 'text-right')}>{t.unit}</th><th className={cn(TH, 'text-right')}>{t.amount}</th>
          </tr></thead>
            <tbody>{q.items.map((l) => (
              <tr key={l.id}>
                <td className={TD}>{lineTitle(l, m.labels.itemKind[l.kind])}</td>
                <td className={cn(TD, 'num text-right')}>{l.quantity}</td>
                <td className={cn(TD, 'num text-right')}>{fmt.money(l.unitPriceCents)}</td>
                <td className={cn(TD, 'num text-right')}>{fmt.money(l.lineTotalCents)}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
      {q && totals.map(([label, cents]) => <div key={label} className="flex justify-between"><span className="text-muted-foreground">{label}</span><span className="num">{fmt.money(cents)}</span></div>)}
      {q && <div className="flex justify-between border-t border-border pt-2"><span className="text-muted-foreground">{t.total}</span><span className="num font-semibold">{fmt.money(q.totalCents)}</span></div>}
      <p className="flex items-start gap-2 rounded-[7px] bg-status-blue px-2.5 py-2 text-[12.5px] text-status-blue-fg"><Info className="mt-px size-4 shrink-0" strokeWidth={1.9} aria-hidden />{t.reapprovalNote}</p>
    </div>
  )
}

function AuthorizationPanel({ d }: { d: Detail }) {
  const { m, fmt } = useI18n()
  const t = m.order.auth
  const [dialog, setDialog] = useState<'record' | 'revoke' | null>(null)
  const { order } = d
  const active = order.state === 'active'
  return (
    <div className="flex flex-col gap-2 border-t border-border px-4 py-3.5 text-[13px]" data-panel="authorization">
      <h3 className="text-[13px] font-semibold">{t.title}</h3>
      {order.poRequired ? <p className="text-muted-foreground">{t.poOnly}</p> : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            {order.authorizedAt ? (
              <>
                <Chip tone="green">{t.authorized}</Chip>
                <span className="text-[#4A4741]">{order.authorizationMethod ? `${m.labels.authorizationMethod[order.authorizationMethod]} · ` : ''}<span className="num">{fmt.date(order.authorizedAt)}</span></span>
              </>
            ) : <Chip tone="amber">{t.notAuthorized}</Chip>}
            <span className="grow" />
            {order.authorizedAt
              ? <button type="button" className={sm} disabled={!active} onClick={() => setDialog('revoke')}>{t.revoke}</button>
              : <button type="button" className={smPrimary} disabled={!active} onClick={() => setDialog('record')}>{t.recordButton}</button>}
          </div>
          {order.authorizationNotes && <p className={MUTED}>{order.authorizationNotes}</p>}
        </>
      )}
      {dialog === 'record' && <AuthorizeDialog d={d} onClose={() => setDialog(null)} />}
      {dialog === 'revoke' && <ReasonDialog d={d} onClose={() => setDialog(null)} title={t.revokeTitle} body={t.revokeBody} label={t.reason} submit={t.revokeSubmit} method="DELETE" sub="/authorization" />}
    </div>
  )
}

export function ItemsQuoteTab({ d }: { d: Detail }) {
  return (
    <div>
      <ItemsSection d={d} />
      <QuotePanel d={d} />
      <AuthorizationPanel d={d} />
    </div>
  )
}

// ---------------------------------------------------------------- details & notes

export function DetailsEditor({ d, onDone }: { d: Detail; onDone: () => void }) {
  const { m } = useI18n()
  const o = d.order
  const ed = useEditSession(o.version, () => ({
    title: o.title, due: o.dueDate ?? '', contact: d.contact ? String(d.contact.id) : '', source: o.source, po: o.poRequired, terms: o.paymentTerms,
    assignee: o.assigneeId ? String(o.assigneeId) : '',
  }))
  const f = ed.values
  const setF = ed.setValues
  const customer = useCustomer(d.customer.id)
  const users = useUsers()
  const w = useOrderWrite(d, ed.version)
  const contacts = (customer.data?.contacts ?? []).filter((c) => !c.archived || c.id === d.contact?.id)
  const t = m.order.edit
  return (
    <form
      className="flex flex-col gap-3" onSubmit={(e) => {
        e.preventDefault()
        if (!f.title.trim() || w.isPending || ed.blocked) return
        ed.clear()
        w.mutate({
          method: 'PATCH',
          body: {
            title: f.title.trim(), dueDate: f.due || null, contactId: f.contact ? Number(f.contact) : null, source: f.source, poRequired: f.po, paymentTerms: f.terms,
            ...(users.data ? { assigneeId: f.assignee ? Number(f.assignee) : null } : {}),
          },
        }, { onSuccess: onDone, onError: ed.onError })
      }}
    >
      <ConflictNotice show={ed.conflict} />
      <Field label={m.newOrder.orderTitle}><input className={INPUT} value={f.title} aria-invalid={!f.title.trim() || undefined} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
      <Field label={m.newOrder.dueDate}><input className={INPUT} type="date" value={f.due} onChange={(e) => setF({ ...f, due: e.target.value })} /></Field>
      <Field label={m.newOrder.contact}>
        <select className={INPUT} value={f.contact} onChange={(e) => setF({ ...f, contact: e.target.value })}>
          <option value="">{m.newOrder.noContact}</option>
          {contacts.map((c) => <option key={c.id} value={c.id}>{c.title ? `${c.name} · ${c.title}` : c.name}</option>)}
        </select>
      </Field>
      <Field label={m.order.detail.source}>
        <select className={INPUT} value={f.source} onChange={(e) => setF({ ...f, source: e.target.value as OrderSource })}>
          {ORDER_SOURCES.map((k) => <option key={k} value={k}>{m.labels.orderSource[k]}</option>)}
        </select>
      </Field>
      <Check checked={f.po} onChange={(po) => setF({ ...f, po })}>{m.order.detail.poRequired}</Check>
      <Field label={m.order.detail.paymentTerms}>
        <select className={INPUT} value={f.terms} onChange={(e) => setF({ ...f, terms: e.target.value as PaymentTerms })}>
          {PAYMENT_TERMS.map((k) => <option key={k} value={k}>{m.labels.paymentTerms[k]}</option>)}
        </select>
      </Field>
      {users.data && (
        <Field label={m.order.detail.assignee}>
          <select className={INPUT} value={f.assignee} onChange={(e) => setF({ ...f, assignee: e.target.value })}>
            <option value="">{t.unassigned}</option>
            {users.data.users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
        </Field>
      )}
      <MutationError error={isConflict(w.error) ? null : w.error} />
      <div className="flex gap-2">
        <button type="submit" className={cn(BTN, BTN_PRIMARY)} disabled={w.isPending || ed.blocked}>{w.isPending ? m.common.saving : m.common.save}</button>
        <button type="button" className={BTN} onClick={onDone}>{m.common.cancel}</button>
      </div>
    </form>
  )
}

export function NoteComposer({ d }: { d: Detail }) {
  const { m } = useI18n()
  const [body, setBody] = useState('')
  const w = useOrderWrite(d)
  return (
    <>
      <Field label={m.customers.addNote}><textarea className={TEXTAREA} rows={2} value={body} placeholder={m.order.notePlaceholder} onChange={(e) => setBody(e.target.value)} /></Field>
      <div className="flex items-center gap-2">
        <button type="button" className={sm} disabled={!body.trim() || w.isPending} onClick={() => w.mutate({ method: 'POST', sub: '/notes', body: { body: body.trim() } }, { onSuccess: () => setBody('') })}>{m.order.addNote}</button>
        <MutationError error={w.error} />
      </div>
    </>
  )
}

