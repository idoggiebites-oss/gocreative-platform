import { useEffect, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { Plus, Search } from 'lucide-react'
import type { CustomerCreateRequest, CustomerResponse } from '@shared/api'
import { CUSTOMER_KINDS, PAYMENT_TERMS, type CustomerKind, type PaymentTerms } from '@shared/enums'
import { useI18n } from '@/i18n'
import { send, useCustomers, useSend } from '@/lib/api'
import { cn } from '@/lib/utils'
import { customerDefaults } from '../../worker/domain/customerDefaults'
import { BTN, BTN_PRIMARY, Check, Field, FormDialog, INPUT } from './form'
import QueryBoundary from './QueryBoundary'
import { CARD, Chip, MUTED, PAGE, TD, TH, useRowLink, type Tone } from './ui'

export const KIND_TONE: Record<CustomerKind, Tone> = { district: 'blue', organization: 'gray', individual: 'gray' }

export const isEmail = (s: string) => s === '' || /^\S+@\S+\.\S+$/.test(s)

/** "+ New customer": kind picks the PO and payment-terms defaults, which stay editable. */
export function NewCustomerDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; onCreated: (c: CustomerResponse['customer']) => void }) {
  const { m } = useI18n()
  const [f, setF] = useState({ name: '', kind: 'district' as CustomerKind, organization: '', email: '', phone: '', po: true, terms: 'due_after_pickup' as PaymentTerms })
  const [tried, setTried] = useState(false)
  const create = useSend<CustomerResponse, CustomerCreateRequest>((b) => send('POST', '/customers', b))
  const t = m.customers
  const nameBad = tried && !f.name.trim()
  const emailBad = tried && !isEmail(f.email.trim())
  return (
    <FormDialog
      open={open} onOpenChange={onOpenChange} title={t.newTitle} submitLabel={t.create} pending={create.isPending} error={create.error}
      onSubmit={() => {
        setTried(true)
        if (!f.name.trim() || !isEmail(f.email.trim())) return
        create.mutate(
          { name: f.name.trim(), kind: f.kind, organization: f.organization.trim() || null, email: f.email.trim() || null, phone: f.phone.trim() || null, defaultPoRequired: f.po, defaultPaymentTerms: f.terms },
          { onSuccess: (r) => { onOpenChange(false); onCreated(r.customer) } },
        )
      }}
    >
      <Field label={t.name}><input className={INPUT} value={f.name} aria-invalid={nameBad || undefined} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
      {nameBad && <p role="alert" className="text-xs text-status-red-fg">{t.nameRequired}</p>}
      <Field label={t.kind}>
        <select className={INPUT} value={f.kind} onChange={(e) => { const kind = e.target.value as CustomerKind; const d = customerDefaults(kind); setF({ ...f, kind, po: d.defaultPoRequired, terms: d.defaultPaymentTerms }) }}>
          {CUSTOMER_KINDS.map((k) => <option key={k} value={k}>{m.labels.customerKind[k]}</option>)}
        </select>
      </Field>
      <Field label={t.organization}><input className={INPUT} value={f.organization} onChange={(e) => setF({ ...f, organization: e.target.value })} /></Field>
      <div className="flex flex-wrap gap-3">
        <Field label={t.email} className="flex-[1_1_180px]"><input className={INPUT} type="email" value={f.email} aria-invalid={emailBad || undefined} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
        <Field label={t.phone} className="flex-[1_1_140px]"><input className={INPUT} type="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
      </div>
      {emailBad && <p role="alert" className="text-xs text-status-red-fg">{t.emailInvalid}</p>}
      <div className="flex flex-wrap items-end gap-x-6 gap-y-2">
        <Check checked={f.po} onChange={(po) => setF({ ...f, po })}>{m.order.detail.poRequired}</Check>
        <Field label={m.order.detail.paymentTerms} className="flex-[0_1_200px]">
          <select className={INPUT} value={f.terms} onChange={(e) => setF({ ...f, terms: e.target.value as PaymentTerms })}>
            {PAYMENT_TERMS.map((k) => <option key={k} value={k}>{m.labels.paymentTerms[k]}</option>)}
          </select>
        </Field>
      </div>
      <span className={MUTED}>{t.defaultsHint}</span>
    </FormDialog>
  )
}

export default function CustomerList() {
  const { m, fmt } = useI18n()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const q = params.get('q') ?? ''
  const kindParam = params.get('kind')
  const kind = (CUSTOMER_KINDS as readonly string[]).includes(kindParam ?? '') ? (kindParam as CustomerKind) : ''
  const [text, setText] = useState(q)
  const [adding, setAdding] = useState(params.get('new') === '1')
  const query = useCustomers(q, kind)
  const rowLink = useRowLink()
  const t = m.customers

  // Same pattern as the orders list: the URL is the truth, typing is debounced into it.
  useEffect(() => { setText(q) }, [q])
  useEffect(() => { if (params.get('new') === '1') setAdding(true) }, [params])
  useEffect(() => {
    const id = setTimeout(() => {
      if (text.trim() === q) return
      setParams((p) => {
        const next = new URLSearchParams(p)
        if (text.trim()) next.set('q', text.trim())
        else next.delete('q')
        return next
      }, { replace: true })
    }, 250)
    return () => clearTimeout(id)
  }, [text, q, setParams])

  const setKind = (k: CustomerKind | '') => setParams((p) => {
    const next = new URLSearchParams(p)
    if (k) next.set('kind', k)
    else next.delete('kind')
    return next
  }, { replace: true })

  return (
    <div className={cn(PAGE, 'gap-3 pt-4')}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-[-0.015em]">{t.title}</h1>
        <button type="button" className={cn(BTN, BTN_PRIMARY)} onClick={() => setAdding(true)}><Plus className="size-[15px]" strokeWidth={2} aria-hidden />{t.new}</button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex h-[34px] flex-[0_1_320px] items-center gap-2 rounded-[7px] border border-input bg-card px-2.5 text-[13px] text-muted-foreground focus-within:ring-2 focus-within:ring-ring/40">
          <Search className="size-3.5 shrink-0" strokeWidth={1.75} aria-hidden />
          <input type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder={t.searchPlaceholder} aria-label={t.search} className="min-w-0 flex-1 border-0 bg-transparent text-foreground outline-none" />
        </label>
        <select aria-label={t.kindFilter} className={INPUT} value={kind} onChange={(e) => setKind(e.target.value as CustomerKind | '')}>
          <option value="">{t.allKinds}</option>
          {CUSTOMER_KINDS.map((k) => <option key={k} value={k}>{m.labels.customerKind[k]}</option>)}
        </select>
      </div>
      <QueryBoundary query={query}>
        {(d) => (
          <>
            <section className={`${CARD} overflow-x-auto`}>
              {d.rows.length === 0 ? <p className="px-4 py-10 text-center text-[13px] text-muted-foreground">{q || kind ? t.emptyFiltered : t.empty}</p> : (
                <table className="w-full border-collapse text-[13px]">
                  <thead><tr className="bg-header">
                    <th className={TH}>{t.cols.name}</th><th className={TH}>{t.cols.kind}</th><th className={TH}>{t.cols.contact}</th>
                    <th className={cn(TH, 'text-right')}>{t.cols.active}</th><th className={cn(TH, 'text-right')}>{t.cols.outstanding}</th><th className={TH}>{t.cols.last}</th>
                  </tr></thead>
                  <tbody>
                    {d.rows.map((r) => {
                      const to = `/app/customers/${r.id}`
                      return (
                        <tr key={r.id} {...rowLink(to)}>
                          <td className={`${TD} font-medium`}><Link to={to} className="text-foreground no-underline hover:text-primary hover:underline">{r.name}</Link></td>
                          <td className={TD}><Chip tone={KIND_TONE[r.kind]}>{m.labels.customerKind[r.kind]}</Chip></td>
                          <td className={TD}>{r.email ?? r.phone ?? m.common.dash}</td>
                          <td className={cn(TD, 'num text-right')}>{r.activeOrders}</td>
                          <td className={cn(TD, 'num text-right text-muted-foreground')}>{r.outstanding === null ? m.common.dash : fmt.money(r.outstanding)}</td>
                          <td className={cn(TD, 'num')}>{r.lastOrderAt ? fmt.date(r.lastOrderAt) : m.common.dash}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              )}
            </section>
            <span className={MUTED}>{m.orders.showing(d.rows.length)}</span>
          </>
        )}
      </QueryBoundary>
      {adding && <NewCustomerDialog open onOpenChange={(o) => { setAdding(o); if (!o && params.has('new')) setParams((p) => { const n = new URLSearchParams(p); n.delete('new'); return n }, { replace: true }) }} onCreated={(c) => void navigate(`/app/customers/${c.id}`)} />}
    </div>
  )
}

