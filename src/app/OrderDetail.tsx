import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Link, useParams } from 'react-router'
import { Lock, SearchX } from 'lucide-react'
import type { UseMutationResult } from '@tanstack/react-query'
import type { GateReasonCode, OrderDetailResponse, OrderItem } from '@shared/api'
import { PRODUCTION_STATUSES, type PoStatus, type ProductionStatus } from '@shared/enums'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useI18n } from '@/i18n'
import { ApiError, useChangePo, useChangeProduction, useOrder } from '@/lib/api'
import { cn } from '@/lib/utils'
import { checkOrderProductionMove } from '../../worker/domain/productionFlow'
import { allowedPoTransitions } from '../../worker/domain/purchaseOrder'
import QueryBoundary from './QueryBoundary'
import { CARD, Chip, ChipTrigger, QUOTE_TONE, ARTWORK_TONE, MUTED, PAGE, PO_TONE, PRODUCTION_TONE, TD, TH, type Tone } from './ui'

type Detail = OrderDetailResponse
// A product line reads "Product · Color"; a charge or discount line shows its description (or its kind).
const lineTitle = (i: OrderItem, kindLabel: string) =>
  i.product ? (i.garmentColor ? `${i.product} · ${i.garmentColor}` : i.product) : (i.description ?? kindLabel)
type PoMutation = UseMutationResult<unknown, Error, { poId: number; to: PoStatus }>
type ProdMutation = UseMutationResult<unknown, Error, ProductionStatus>
type Controls = { po: PoMutation; prod: ProdMutation }

const BTN = 'inline-flex h-8 items-center justify-center gap-1.5 rounded-[7px] border border-input bg-card px-3 text-[13px] font-medium hover:bg-secondary disabled:opacity-60'
const BTN_PRIMARY = 'border-primary bg-primary text-primary-foreground hover:bg-(--brand-hover) hover:text-primary-foreground'

/** The server's refusal, shown next to the control that caused it (never swallowed). */
function MoveError({ error }: { error: Error | null }) {
  const { m } = useI18n()
  if (!error) return null
  const refused = error instanceof ApiError && error.status === 409
  // Only translated text is shown: the server's English `error` is for logs. Unknown codes fall back to the generic line.
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

/** A status chip that is a dropdown of the moves the domain rules allow; a plain chip when there are none. */
function StatusMenu<T extends string>(p: {
  current: T; options: readonly T[]; labels: Record<T, string>; tones: Record<T, Tone>; pending: boolean; onPick: (to: T) => void; name: string
}) {
  const { m } = useI18n()
  const wrap = useRef<HTMLSpanElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const wasPending = useRef(false)
  // Keyboard users stay where they were: after a save, focus goes back to the trigger, or to the
  // wrapper when the status has no further moves and the trigger is gone. The trigger is never
  // disabled while saving (a disabled element drops focus); aria-busy says it is working instead.
  useEffect(() => {
    if (wasPending.current && !p.pending) {
      const a = document.activeElement
      if (!a || a === document.body || wrap.current?.contains(a)) (trigger.current ?? wrap.current)?.focus()
    }
    wasPending.current = p.pending
  })
  return (
    <span ref={wrap} tabIndex={-1} role="group" aria-label={p.name} className="outline-none">
      {p.options.length === 0 ? <Chip tone={p.tones[p.current]}>{p.labels[p.current]}</Chip> : (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <ChipTrigger ref={trigger} tone={p.tones[p.current]} aria-busy={p.pending || undefined} aria-label={`${p.name}: ${p.labels[p.current]}. ${m.order.changeStatus}`}>
              {p.pending ? m.order.changing : p.labels[p.current]}
            </ChipTrigger>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-auto min-w-44">
            {p.options.map((o) => <DropdownMenuItem key={o} disabled={p.pending} onSelect={() => p.onPick(o)}>{p.labels[o]}</DropdownMenuItem>)}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </span>
  )
}

function useMoves(d: Detail) {
  // The same pure rule and readiness the server re-checks, so the menu never offers a move that would be refused.
  const production = PRODUCTION_STATUSES.filter((to) => checkOrderProductionMove(d.order.state, d.order.productionStatus, to, d.readiness).ok)
  return { production }
}

function PoMenu({ po, status, mut }: { po: Detail['purchaseOrders'][number]; status: PoStatus; mut: PoMutation }) {
  const { m } = useI18n()
  return (
    <StatusMenu
      current={status} options={allowedPoTransitions(status)} labels={m.labels.poStatus} tones={PO_TONE} name={m.order.track.po}
      pending={mut.isPending && mut.variables?.poId === po.id} onPick={(to) => mut.mutate({ poId: po.id, to })}
    />
  )
}

function StatusStrip({ d, c, moves }: { d: Detail; c: Controls; moves: ReturnType<typeof useMoves> }) {
  const { m, fmt } = useI18n()
  const { order, quote: est } = d
  const po = d.purchaseOrders[0]
  const t = m.order.track
  const cell = 'flex min-w-0 flex-col gap-1.5 border-r border-secondary px-3.5 py-3 last:border-r-0'
  const label = 'text-[11.5px] font-medium uppercase tracking-[.04em] text-muted-foreground'
  return (
    <section aria-label={m.order.status} className={`${CARD} grid grid-cols-[repeat(auto-fit,minmax(170px,1fr))]`}>
      <div className={cell}>
        <span className={label}>{t.quote}</span>
        {est ? <span><Chip tone={QUOTE_TONE[est.status]}>{m.labels.quoteStatus[est.status]}</Chip></span> : <span className="text-[13px] text-muted-foreground">{m.order.noQuote}</span>}
        {est && <span className={MUTED}>{m.order.quoteSub(est.version, fmt.date(est.sentAt ?? est.createdAt))}</span>}
      </div>
      <div className={cell}>
        <span className={label}>{t.artwork}</span>
        <span><Chip tone={ARTWORK_TONE[order.artworkStatus]}>{m.labels.artworkStatus[order.artworkStatus]}</Chip></span>
        <span className={MUTED}>{m.order.artworkSub}</span>
      </div>
      <div className={cell}>
        <span className={label}>{t.po}</span>
        {po ? <span><PoMenu po={po} status={po.status} mut={c.po} /></span>
          : <span className="text-[13px] text-muted-foreground">{order.poRequired ? m.order.noPo : m.order.poNotRequired}</span>}
        {po && <span className={`${MUTED} num`}>{m.order.poSub(po.poNumber, fmt.relative(po.updatedAt))}</span>}
        <MoveError error={c.po.error} />
      </div>
      <div className={cell}>
        <span className={label}>{t.production}</span>
        <span>
          <StatusMenu
            current={order.productionStatus} options={moves.production} labels={m.labels.productionStatus} tones={PRODUCTION_TONE}
            name={t.production} pending={c.prod.isPending} onPick={(to) => c.prod.mutate(to)}
          />
        </span>
        <span className={MUTED}>{d.gate.ok ? m.order.gateClear : m.order.gateClosed}</span>
        <MoveError error={c.prod.error} />
      </div>
      <div className={cell}>
        <span className={label}>{t.invoice}</span>
        <span className="text-[13px] text-muted-foreground">{order.invoiceRef || order.paymentRef ? m.order.ref(order.invoiceRef, order.paymentRef) : m.order.notInvoiced}</span>
      </div>
    </section>
  )
}

function GateBanner({ d, c, openPo }: { d: Detail; c: Controls; openPo: () => void }) {
  const { m } = useI18n()
  if (d.gate.ok) return null
  const known: Record<string, string> = m.order.gate.reasons satisfies Record<GateReasonCode, string>
  const po = d.purchaseOrders[0]
  return (
    <div role="status" className="flex flex-wrap items-center gap-3 rounded-[10px] border border-status-amber-fg/20 bg-status-amber px-3.5 py-3 text-[13px] text-status-amber-fg">
      <Lock className="size-4 shrink-0" strokeWidth={1.9} aria-hidden />
      <span className="min-w-[min(300px,100%)] flex-1">
        <b className="font-semibold">{m.order.gate.title}</b> {d.gate.reasons.map((r) => known[r] ?? r).join(' ')}
      </span>
      {d.purchaseOrders.length > 0 && <button type="button" onClick={openPo} className={BTN}>{m.order.gate.viewPo}</button>}
      {po?.status === 'under_review' && (
        <button type="button" disabled={c.po.isPending} onClick={() => c.po.mutate({ poId: po.id, to: 'approved' })} className={cn(BTN, BTN_PRIMARY)}>
          {c.po.isPending ? m.order.changing : m.order.gate.recordApproval}
        </button>
      )}
    </div>
  )
}

function ItemsTab({ d }: { d: Detail }) {
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
                  <span className={MUTED}>{i.method ? m.labels.method[i.method] : m.labels.itemKind[i.kind]}{i.notes ? ` · ${i.notes}` : ''}</span>
                </div>
              </td>
              <td className="border-b border-secondary p-3">
                {i.sizes && (
                  <div className="grid grid-cols-[repeat(8,minmax(34px,auto))] gap-0.5 text-xs">
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

function QuoteTab({ d }: { d: Detail }) {
  const { m, fmt } = useI18n()
  const q = d.quote
  const t = m.order.quote
  if (!q) return <p className="px-4 py-8 text-center text-[13px] text-muted-foreground">{t.empty}</p>
  const totals: [string, number][] = [[t.subtotal, q.subtotalCents], ...(q.chargesCents ? [[t.charges, q.chargesCents] as [string, number]] : []), ...(q.discountsCents ? [[t.discounts, -q.discountsCents] as [string, number]] : [])]
  return (
    <div className="flex flex-col gap-3 p-4 text-[13px]">
      <div className="flex items-center gap-2"><span className="font-medium">{t.version(q.version)}</span><Chip tone={QUOTE_TONE[q.status]}>{m.labels.quoteStatus[q.status]}</Chip></div>
      {q.status === 'accepted' && q.itemsRevision !== d.order.itemsRevision && <p role="status" className="text-xs text-status-amber-fg">{t.stale}</p>}
      {q.items.length > 0 && (
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
      {totals.map(([label, cents]) => <div key={label} className="flex justify-between"><span className="text-muted-foreground">{label}</span><span className="num">{fmt.money(cents)}</span></div>)}
      <div className="flex justify-between border-t border-border pt-2"><span className="text-muted-foreground">{t.total}</span><span className="num font-semibold">{fmt.money(q.totalCents)}</span></div>
      <p className={MUTED}>{t.uploadNote}</p>
    </div>
  )
}

function PoTab({ d, c }: { d: Detail; c: Controls }) {
  const { m, fmt } = useI18n()
  if (d.purchaseOrders.length === 0) return <p className="px-4 py-8 text-center text-[13px] text-muted-foreground">{m.order.po.empty}</p>
  return (
    <div className="flex flex-col gap-2 pb-3">
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[13px]">
          <thead><tr><th className={TH}>{m.order.po.number}</th><th className={cn(TH, 'text-right')}>{m.order.po.amount}</th><th className={TH}>{m.order.po.status}</th><th className={TH}>{m.order.po.updated}</th></tr></thead>
          <tbody>
            {d.purchaseOrders.map((p, i) => (
              <tr key={p.id}>
                <td className={`${TD} num font-medium`}>{p.poNumber ?? m.common.dash}{i === 0 && <span className={`${MUTED} ml-2 font-normal`}>{m.order.po.latest}</span>}</td>
                <td className={cn(TD, 'num text-right')}>{p.amountCents === null ? m.common.dash : fmt.money(p.amountCents)}</td>
                <td className={TD}><div className="flex flex-col items-start gap-1 py-1"><PoMenu po={p} status={p.status} mut={c.po} /></div></td>
                <td className={cn(TD, 'num')}>{fmt.relative(p.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="px-4"><MoveError error={c.po.error} /></div>
      <p className={`${MUTED} px-4`}>{m.order.po.uploadNote}</p>
    </div>
  )
}

function ProductionTab({ d, c, moves }: { d: Detail; c: Controls; moves: ReturnType<typeof useMoves> }) {
  const { m } = useI18n()
  const s = d.order.productionStatus
  return (
    <div className="flex flex-col gap-3 p-4 text-[13px]">
      <div className="flex flex-wrap items-center gap-2"><span className="text-muted-foreground">{m.order.production.current}</span><Chip tone={PRODUCTION_TONE[s]}>{m.labels.productionStatus[s]}</Chip></div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-muted-foreground">{m.order.production.moves}</span>
        {moves.production.length === 0 && <span className={MUTED}>{m.order.production.none}</span>}
        {moves.production.map((to) => (
          <button key={to} type="button" aria-busy={c.prod.isPending || undefined} onClick={() => !c.prod.isPending && c.prod.mutate(to)} className={cn(BTN, 'aria-busy:opacity-60')}>{m.labels.productionStatus[to]}</button>
        ))}
      </div>
      <MoveError error={c.prod.error} />
      <p className={d.gate.ok ? MUTED : 'text-xs text-status-amber-fg'}>{d.gate.ok ? m.order.production.gateOk : m.order.gateClosed}</p>
    </div>
  )
}

const field = (o: unknown, key: string): string | null => (o && typeof o === 'object' && typeof (o as Record<string, unknown>)[key] === 'string' ? (o as Record<string, string>)[key] : null)

function ActivityTab({ d }: { d: Detail }) {
  const { m, fmt } = useI18n()
  if (d.activity.length === 0) return <p className="px-4 py-8 text-center text-[13px] text-muted-foreground">{m.order.activity.empty}</p>
  const prod = (v: string | null) => (v && v in m.labels.productionStatus ? m.labels.productionStatus[v as ProductionStatus] : (v ?? m.common.dash))
  const po = (v: string | null) => (v && v in m.labels.poStatus ? m.labels.poStatus[v as PoStatus] : (v ?? m.common.dash))
  return (
    <ul className="flex flex-col gap-3 p-4 text-[13px]">
      {d.activity.map((a) => {
        const text =
          a.action === 'created' ? m.order.activity.created
          : a.action === 'production_status_changed' ? m.order.activity.production(prod(field(a.before, 'production_status')), prod(field(a.after, 'production_status')))
          : a.action === 'po_status_changed' ? m.order.activity.po(po(field(a.before, 'po_status')), po(field(a.after, 'po_status')))
          : m.activity.other('')
        return (
          <li key={a.id} className="flex flex-col gap-0.5">
            <span>{text}</span>
            <span className={MUTED}>{a.actor} · {fmt.relative(a.createdAt)}</span>
          </li>
        )
      })}
    </ul>
  )
}

function Side({ d }: { d: Detail }) {
  const { m, fmt } = useI18n()
  const { order, customer, contact } = d
  const card = `${CARD} flex flex-col gap-2.5 px-4 py-3.5`
  const h = 'text-[13px] font-semibold'
  const muted = <span className="text-muted-foreground">{m.common.dash}</span>
  const rows: [string, ReactNode][] = [
    [m.order.detail.source, m.labels.orderSource[order.source]],
    [m.order.detail.created, <span className="num">{fmt.date(order.createdAt)}</span>],
    [m.order.detail.due, order.dueDate ? <span className="num">{fmt.weekdayDate(order.dueDate)}</span> : muted],
    [m.order.detail.poRequired, order.poRequired ? m.common.yes : m.common.no],
    ...(order.poRequired ? [] : [[m.order.detail.authorization, order.authorizedAt
      ? <span>{order.authorizationMethod ? `${m.labels.authorizationMethod[order.authorizationMethod]} · ` : ''}<span className="num">{fmt.date(order.authorizedAt)}</span></span>
      : muted] as [string, ReactNode]]),
    [m.order.detail.paymentTerms, m.labels.paymentTerms[order.paymentTerms]],
    [m.order.detail.invoiceRef, order.invoiceRef ?? muted],
    [m.order.detail.paymentRef, order.paymentRef ?? muted],
    [m.order.detail.state, m.labels.orderState[order.state]],
  ]
  return (
    <div className="flex min-w-0 flex-[1_1_300px] flex-col gap-4">
      <section className={card} aria-labelledby="cust">
        <h2 id="cust" className={h}>{m.order.customer}</h2>
        <div className="flex flex-col gap-0.5 text-[13px]"><span className="font-medium">{customer.name}</span><span className={MUTED}>{m.labels.customerKind[customer.kind]}</span></div>
        {(contact || customer.email || customer.phone) && (
          <div className="flex flex-col gap-0.5 border-t border-secondary pt-2 text-[13px]">
            {contact && <span className="font-medium">{contact.title ? `${contact.name} · ${contact.title}` : contact.name}</span>}
            {(contact?.email ?? customer.email) && <a href={`mailto:${contact?.email ?? customer.email}`} className="truncate text-primary no-underline hover:text-(--brand-hover)">{contact?.email ?? customer.email}</a>}
            {(contact?.phone ?? customer.phone) && <span className="num text-[#4A4741]">{contact?.phone ?? customer.phone}</span>}
          </div>
        )}
      </section>
      <section className={card} aria-labelledby="det">
        <h2 id="det" className={h}>{m.order.details}</h2>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-[13px]">
          {rows.map(([k, v]) => <div key={k} className="contents"><dt className="text-muted-foreground">{k}</dt><dd className="text-right">{v}</dd></div>)}
        </dl>
      </section>
      <section className={card} aria-labelledby="notes">
        <div className="flex items-center justify-between"><h2 id="notes" className={h}>{m.order.notes}</h2><span className={MUTED}>{m.order.staffOnly}</span></div>
        {d.notes.length === 0 && <p className="text-[13px] text-muted-foreground">{m.order.notesEmpty}</p>}
        {d.notes.map((n) => (
          <div key={n.id} className="flex flex-col gap-0.5 text-[13px]"><span>{n.body}</span><span className={MUTED}>{n.authorName ?? m.common.dash} · {fmt.date(n.createdAt)}</span></div>
        ))}
        <p className={MUTED}>{m.order.notesLater}</p>
      </section>
    </div>
  )
}

const TABS = ['items', 'artwork', 'quote', 'po', 'production', 'activity'] as const
type Tab = (typeof TABS)[number]

function Order({ d }: { d: Detail }) {
  const { m, fmt } = useI18n()
  const c: Controls = { po: useChangePo(d.order.number, d.order.version), prod: useChangeProduction(d.order.number) }
  const moves = useMoves(d)
  const [tab, setTab] = useState<Tab>('items')
  // Products only: charge and discount lines carry a quantity too, but aren't items.
  const qty = d.items.filter((i) => i.kind === 'product').reduce((s, i) => s + i.quantity, 0)
  return (
    <div className={cn(PAGE, 'max-w-[1280px] gap-4 pt-5')}>
      <nav aria-label={m.order.breadcrumb} className="text-[13px] text-muted-foreground">
        <Link to="/app/orders" className="text-muted-foreground no-underline hover:text-foreground">{m.nav.orders}</Link> <span aria-hidden>/</span>{' '}
        <span className="num font-medium text-foreground">{d.order.number}</span>
      </nav>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="text-xl font-semibold tracking-[-0.015em]">{d.order.title}</h1>
            <Chip tone="gray">{m.labels.orderSource[d.order.source]}</Chip>
          </div>
          <span className="text-[13px] text-muted-foreground">
            {d.customer.name} · {m.common.items(qty)}
            {d.order.dueDate && <> · {m.order.due} <b className="num font-medium text-foreground">{fmt.weekdayDate(d.order.dueDate)}</b></>}
          </span>
        </div>
        {d.quote && (
          <div className="flex flex-col items-end gap-0.5">
            {/* The agreed total is the accepted quote's; any other quote's total is labelled with its status. */}
            <span className={MUTED}>{d.quote.status === 'accepted' ? m.order.agreedTotal : m.order.quoteTotal(m.labels.quoteStatus[d.quote.status])}</span>
            <span className="num text-xl font-semibold tracking-[-0.015em]">{fmt.money(d.quote.totalCents)}</span>
          </div>
        )}
      </div>
      <StatusStrip d={d} c={c} moves={moves} />
      <GateBanner d={d} c={c} openPo={() => setTab('po')} />
      <div className="flex flex-wrap items-start gap-4">
        <section className={`${CARD} min-w-0 flex-[999_1_600px]`}>
          <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
            <TabsList aria-label={m.order.tabsLabel}>
              {TABS.map((k) => <TabsTrigger key={k} value={k}>{m.order.tabs[k]}</TabsTrigger>)}
            </TabsList>
            <TabsContent value="items"><ItemsTab d={d} /></TabsContent>
            <TabsContent value="artwork">
              <div className="flex flex-col gap-3 p-4 text-[13px]">
                <div className="flex items-center gap-2"><span className="text-muted-foreground">{m.order.artwork.status}</span><Chip tone={ARTWORK_TONE[d.order.artworkStatus]}>{m.labels.artworkStatus[d.order.artworkStatus]}</Chip></div>
                <p className={MUTED}>{m.order.artwork.body}</p>
              </div>
            </TabsContent>
            <TabsContent value="quote"><QuoteTab d={d} /></TabsContent>
            <TabsContent value="po"><PoTab d={d} c={c} /></TabsContent>
            <TabsContent value="production"><ProductionTab d={d} c={c} moves={moves} /></TabsContent>
            <TabsContent value="activity"><ActivityTab d={d} /></TabsContent>
          </Tabs>
        </section>
        <Side d={d} />
      </div>
    </div>
  )
}

function NotFound({ number }: { number: string }) {
  const { m } = useI18n()
  return (
    <div className={PAGE}>
      <section className={`${CARD} flex flex-col items-center gap-3 px-6 py-16 text-center`}>
        <div className="flex size-10 items-center justify-center rounded-full bg-secondary text-muted-foreground"><SearchX className="size-5" strokeWidth={1.75} aria-hidden /></div>
        <h1 className="text-sm font-semibold">{m.order.notFound.title}</h1>
        <p className="max-w-sm text-[13px] text-muted-foreground">{m.order.notFound.body(number)}</p>
        <Link to="/app/orders" className={BTN}>{m.order.backToOrders}</Link>
      </section>
    </div>
  )
}

export default function OrderDetail() {
  const { number = '' } = useParams()
  const query = useOrder(number)
  return <QueryBoundary query={query} notFound={<NotFound number={number} />}>{(d) => <Order d={d} />}</QueryBoundary>
}
