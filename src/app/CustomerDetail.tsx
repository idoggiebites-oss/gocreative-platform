import { useState } from 'react'
import { Link, useParams } from 'react-router'
import { Plus, SearchX } from 'lucide-react'
import type { ContactRequest, ContactResponse, CustomerContact, CustomerDetailResponse, CustomerPatchRequest, CustomerResponse, NoteResponse } from '@shared/api'
import { CUSTOMER_KINDS, PAYMENT_TERMS, type CustomerKind, type PaymentTerms } from '@shared/enums'
import { useI18n } from '@/i18n'
import { ApiError, send, useCustomer, useSend } from '@/lib/api'
import { cn } from '@/lib/utils'
import { KIND_TONE, isEmail } from './CustomerList'
import { BTN, BTN_PRIMARY, BTN_SM, Check, Field, FormDialog, H2, INPUT, LINK, MutationError, SEC, TEXTAREA } from './form'
import QueryBoundary from './QueryBoundary'
import { CARD, Chip, MUTED, PAGE, PRODUCTION_TONE, QUOTE_TONE, TD, TH } from './ui'

type Detail = CustomerDetailResponse
const isConflict = (e: unknown) => e instanceof ApiError && e.status === 409 && e.body.code === 'conflict_retry'

function EditCustomerDialog({ d, onClose, onConflict }: { d: Detail; onClose: () => void; onConflict: () => void }) {
  const { m } = useI18n()
  const c = d.customer
  const [f, setF] = useState({ name: c.name, kind: c.kind, organization: c.organization ?? '', email: c.email ?? '', phone: c.phone ?? '', po: c.defaultPoRequired, terms: c.defaultPaymentTerms })
  const [tried, setTried] = useState(false)
  const save = useSend<CustomerResponse, CustomerPatchRequest>((b) => send('PATCH', `/customers/${c.id}`, b))
  const t = m.customers
  return (
    <FormDialog
      open onOpenChange={(o) => !o && onClose()} title={t.editTitle} submitLabel={m.common.save} pending={save.isPending} error={save.error && isConflict(save.error) ? null : save.error}
      onSubmit={() => {
        setTried(true)
        if (!f.name.trim() || !isEmail(f.email.trim())) return
        // The version comes from the detail this dialog was opened from.
        save.mutate(
          { expectedVersion: c.version, name: f.name.trim(), kind: f.kind, organization: f.organization.trim() || null, email: f.email.trim() || null, phone: f.phone.trim() || null, defaultPoRequired: f.po, defaultPaymentTerms: f.terms },
          { onSuccess: onClose, onError: (e) => { if (isConflict(e)) { onClose(); onConflict() } } },
        )
      }}
    >
      <Field label={t.name}><input className={INPUT} value={f.name} aria-invalid={(tried && !f.name.trim()) || undefined} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
      <Field label={t.kind}>
        <select className={INPUT} value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as CustomerKind })}>
          {CUSTOMER_KINDS.map((k) => <option key={k} value={k}>{m.labels.customerKind[k]}</option>)}
        </select>
      </Field>
      <Field label={t.organization}><input className={INPUT} value={f.organization} onChange={(e) => setF({ ...f, organization: e.target.value })} /></Field>
      <div className="flex flex-wrap gap-3">
        <Field label={t.email} className="flex-[1_1_180px]"><input className={INPUT} type="email" value={f.email} aria-invalid={(tried && !isEmail(f.email.trim())) || undefined} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
        <Field label={t.phone} className="flex-[1_1_140px]"><input className={INPUT} type="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
      </div>
      {tried && !isEmail(f.email.trim()) && <p role="alert" className="text-xs text-status-red-fg">{t.emailInvalid}</p>}
      <div className="flex flex-wrap items-end gap-x-6 gap-y-2">
        <Check checked={f.po} onChange={(po) => setF({ ...f, po })}>{m.order.detail.poRequired}</Check>
        <Field label={m.order.detail.paymentTerms} className="flex-[0_1_200px]">
          <select className={INPUT} value={f.terms} onChange={(e) => setF({ ...f, terms: e.target.value as PaymentTerms })}>
            {PAYMENT_TERMS.map((k) => <option key={k} value={k}>{m.labels.paymentTerms[k]}</option>)}
          </select>
        </Field>
      </div>
    </FormDialog>
  )
}

function ContactDialog({ customerId, contact, onClose }: { customerId: number; contact: CustomerContact | null; onClose: () => void }) {
  const { m } = useI18n()
  const [f, setF] = useState({ name: contact?.name ?? '', title: contact?.title ?? '', email: contact?.email ?? '', phone: contact?.phone ?? '', primary: false })
  const [tried, setTried] = useState(false)
  const save = useSend<ContactResponse, ContactRequest>((b) =>
    contact ? send('PATCH', `/customers/${customerId}/contacts/${contact.id}`, b) : send('POST', `/customers/${customerId}/contacts`, b))
  const t = m.customers
  return (
    <FormDialog
      open onOpenChange={(o) => !o && onClose()} title={contact ? t.editContact : t.addContact} submitLabel={m.common.save} pending={save.isPending} error={save.error}
      onSubmit={() => {
        setTried(true)
        if (!f.name.trim() || !isEmail(f.email.trim())) return
        save.mutate(
          { name: f.name.trim(), title: f.title.trim() || null, email: f.email.trim() || null, phone: f.phone.trim() || null, ...(contact ? {} : { isPrimary: f.primary }) },
          { onSuccess: onClose },
        )
      }}
    >
      <Field label={t.name}><input className={INPUT} value={f.name} aria-invalid={(tried && !f.name.trim()) || undefined} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
      <Field label={t.role}><input className={INPUT} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
      <div className="flex flex-wrap gap-3">
        <Field label={t.email} className="flex-[1_1_180px]"><input className={INPUT} type="email" value={f.email} aria-invalid={(tried && !isEmail(f.email.trim())) || undefined} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
        <Field label={t.phone} className="flex-[1_1_140px]"><input className={INPUT} type="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
      </div>
      {tried && !isEmail(f.email.trim()) && <p role="alert" className="text-xs text-status-red-fg">{t.emailInvalid}</p>}
      {!contact && <Check checked={f.primary} onChange={(primary) => setF({ ...f, primary })}>{t.makePrimary}</Check>}
    </FormDialog>
  )
}

function Contacts({ d }: { d: Detail }) {
  const { m } = useI18n()
  const t = m.customers
  const [editing, setEditing] = useState<CustomerContact | 'new' | null>(null)
  const act = useSend<ContactResponse, { id: number; what: 'primary' | 'archive' | 'unarchive' }>(({ id, what }) =>
    what === 'primary' ? send('PATCH', `/customers/${d.customer.id}/contacts/${id}`, { isPrimary: true }) : send('POST', `/customers/${d.customer.id}/contacts/${id}/${what}`))
  const sm = cn(BTN, BTN_SM)
  return (
    <section className={CARD} aria-labelledby="ct">
      <div className={SEC}>
        <h2 id="ct" className={H2}>{t.contacts}</h2>
        <button type="button" className={sm} onClick={() => setEditing('new')}><Plus className="size-[15px]" strokeWidth={2} aria-hidden />{t.addContact}</button>
      </div>
      {d.contacts.length === 0 ? <p className="px-4 pb-4 text-[13px] text-muted-foreground">{t.noContacts}</p> : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[13px]">
            <thead><tr><th className={TH}>{t.name}</th><th className={TH}>{t.role}</th><th className={TH}>{t.email}</th><th className={TH}>{t.phone}</th><th className={TH}>{t.status}</th><th className={TH} /></tr></thead>
            <tbody>
              {d.contacts.map((c) => (
                <tr key={c.id} className={cn(c.archived && 'text-muted-foreground')}>
                  <td className={`${TD} font-medium`}>{c.name}</td>
                  <td className={TD}>{c.title ?? m.common.dash}</td>
                  <td className={TD}>{c.email ? <a className={LINK} href={`mailto:${c.email}`}>{c.email}</a> : m.common.dash}</td>
                  <td className={`${TD} num`}>{c.phone ?? m.common.dash}</td>
                  <td className={TD}>{c.archived ? <Chip tone="gray">{t.archived}</Chip> : c.isPrimary ? <Chip tone="blue">{t.primary}</Chip> : null}</td>
                  <td className={`${TD} text-right`}>
                    <span className="inline-flex gap-1.5">
                      {!c.archived && <button type="button" className={sm} aria-label={t.editNamed(c.name)} onClick={() => setEditing(c)}>{m.common.edit}</button>}
                      {!c.archived && !c.isPrimary && <button type="button" className={sm} aria-label={t.makePrimaryNamed(c.name)} disabled={act.isPending} onClick={() => act.mutate({ id: c.id, what: 'primary' })}>{t.makePrimary}</button>}
                      <button type="button" className={sm} aria-label={(c.archived ? t.unarchiveNamed : t.archiveNamed)(c.name)} disabled={act.isPending} onClick={() => act.mutate({ id: c.id, what: c.archived ? 'unarchive' : 'archive' })}>{c.archived ? t.unarchive : t.archive}</button>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="px-4 pb-3"><MutationError error={act.error} /></div>
      {editing && <ContactDialog customerId={d.customer.id} contact={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </section>
  )
}

function Notes({ d }: { d: Detail }) {
  const { m, fmt } = useI18n()
  const [body, setBody] = useState('')
  const add = useSend<NoteResponse, string>((b) => send('POST', `/customers/${d.customer.id}/notes`, { body: b }))
  return (
    <section className={`${CARD} flex flex-col gap-2.5 px-4 py-3.5`} aria-labelledby="nt">
      <div className="flex items-center justify-between"><h2 id="nt" className="text-[13px] font-semibold">{m.order.notes}</h2><span className={MUTED}>{m.order.staffOnly}</span></div>
      <Field label={m.customers.addNote}><textarea className={TEXTAREA} rows={2} value={body} placeholder={m.order.notePlaceholder} onChange={(e) => setBody(e.target.value)} /></Field>
      <div className="flex items-center gap-2">
        <button type="button" className={cn(BTN, BTN_SM)} disabled={!body.trim() || add.isPending} onClick={() => add.mutate(body.trim(), { onSuccess: () => setBody('') })}>{m.order.addNote}</button>
        <MutationError error={add.error} />
      </div>
      {d.notes.length === 0 && <p className="text-[13px] text-muted-foreground">{m.order.notesEmpty}</p>}
      {d.notes.map((n) => <div key={n.id} className="flex flex-col gap-0.5 text-[13px]"><span className="whitespace-pre-wrap">{n.body}</span><span className={MUTED}>{n.authorName ?? m.common.dash} · {fmt.date(n.createdAt)}</span></div>)}
    </section>
  )
}

function Customer({ d }: { d: Detail }) {
  const { m, fmt, lang } = useI18n()
  const t = m.customers
  const c = d.customer
  const [editing, setEditing] = useState(false)
  const [conflict, setConflict] = useState(false)
  const since = new Intl.DateTimeFormat(lang === 'es' ? 'es-US' : 'en-US', { month: 'short', year: 'numeric' }).format(new Date(c.createdAt))
  const active = d.orders.filter((o) => o.state === 'active').length
  const card = `${CARD} flex flex-col gap-2.5 px-4 py-3.5`
  return (
    <div className={cn(PAGE, 'max-w-[1280px] gap-4 pt-5')}>
      <nav aria-label={m.order.breadcrumb} className="text-[13px] text-muted-foreground">
        <Link to="/app/customers" className="text-muted-foreground no-underline hover:text-foreground">{m.nav.customers}</Link> <span aria-hidden>/</span> <span className="font-medium text-foreground">{c.name}</span>
      </nav>
      {conflict && <div role="status" className="rounded-[10px] border border-status-amber-fg/20 bg-status-amber px-3.5 py-2.5 text-[13px] text-status-amber-fg">{t.conflict}</div>}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="text-xl font-semibold tracking-[-0.015em]">{c.name}</h1>
            <Chip tone={KIND_TONE[c.kind]}>{m.labels.customerKind[c.kind]}</Chip>
          </div>
          <span className="text-[13px] text-muted-foreground">{t.summary(since, d.orders.length, active)}{c.organization && ` · ${c.organization}`}</span>
        </div>
        <div className="flex gap-2">
          <button type="button" className={BTN} onClick={() => { setConflict(false); setEditing(true) }}>{t.edit}</button>
          <Link to={`/app/orders/new?customer=${c.id}`} className={cn(BTN, BTN_PRIMARY)}><Plus className="size-[15px]" strokeWidth={2} aria-hidden />{m.shell.newOrder}</Link>
        </div>
      </div>
      <div className="flex flex-wrap items-start gap-4">
        <div className="flex min-w-0 flex-[999_1_640px] flex-col gap-4">
          <Contacts d={d} />
          <section className={CARD} aria-labelledby="oh">
            <div className={SEC}><h2 id="oh" className={H2}>{t.orderHistory}</h2></div>
            {d.orders.length === 0 ? <p className="px-4 pb-4 text-[13px] text-muted-foreground">{t.noOrders}</p> : (
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-[13px]">
                  <thead><tr><th className={TH}>{m.orders.cols.order}</th><th className={TH}>{t.orderTitle}</th><th className={TH}>{t.status}</th><th className={cn(TH, 'text-right')}>{t.total}</th><th className={TH}>{t.date}</th></tr></thead>
                  <tbody>
                    {d.orders.map((o) => (
                      <tr key={o.number}>
                        <td className={`${TD} num font-medium`}><Link to={`/app/orders/${o.number}`} className={LINK}>{o.number}</Link></td>
                        <td className={TD}>{o.title}</td>
                        <td className={TD}>
                          <span className="flex gap-1.5">
                            {o.state === 'active' ? <Chip tone={PRODUCTION_TONE[o.productionStatus]}>{m.labels.productionStatus[o.productionStatus]}</Chip> : <Chip tone="gray">{m.labels.orderState[o.state]}</Chip>}
                            {o.quote && <Chip tone={QUOTE_TONE[o.quote.status]}>{m.labels.quoteStatus[o.quote.status]}</Chip>}
                          </span>
                        </td>
                        <td className={cn(TD, 'num text-right')}>{o.quote ? fmt.money(o.quote.totalCents) : m.common.dash}</td>
                        <td className={`${TD} num`}>{fmt.date(o.createdAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
        <div className="flex min-w-0 flex-[1_1_300px] flex-col gap-4">
          <section className={card} aria-labelledby="df">
            <h2 id="df" className="text-[13px] font-semibold">{t.defaults}</h2>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-[13px]">
              <dt className="text-muted-foreground">{m.order.detail.poRequired}</dt><dd className="text-right">{c.defaultPoRequired ? m.common.yes : m.common.no}</dd>
              <dt className="text-muted-foreground">{m.order.detail.paymentTerms}</dt><dd className="text-right">{m.labels.paymentTerms[c.defaultPaymentTerms]}</dd>
              <dt className="text-muted-foreground">{t.email}</dt><dd className="min-w-0 truncate text-right">{c.email ?? m.common.dash}</dd>
              <dt className="text-muted-foreground">{t.phone}</dt><dd className="num text-right">{c.phone ?? m.common.dash}</dd>
            </dl>
          </section>
          <section className={card} aria-labelledby="bal">
            <h2 id="bal" className="text-[13px] font-semibold">{t.balance}</h2>
            <span className="num text-2xl font-semibold tracking-[-0.02em] text-muted-foreground">{m.common.dash}</span>
            <span className={MUTED}>{t.balanceLater}</span>
          </section>
          <Notes d={d} />
        </div>
      </div>
      {editing && <EditCustomerDialog d={d} onClose={() => setEditing(false)} onConflict={() => setConflict(true)} />}
    </div>
  )
}

export default function CustomerDetail() {
  const { id = '' } = useParams()
  const n = /^[1-9]\d{0,14}$/.test(id) ? Number(id) : null
  const query = useCustomer(n)
  const { m } = useI18n()
  const missing = (
    <div className={PAGE}>
      <section className={`${CARD} flex flex-col items-center gap-3 px-6 py-16 text-center`}>
        <div className="flex size-10 items-center justify-center rounded-full bg-secondary text-muted-foreground"><SearchX className="size-5" strokeWidth={1.75} aria-hidden /></div>
        <h1 className="text-sm font-semibold">{m.customers.notFound}</h1>
        <Link to="/app/customers" className={BTN}>{m.customers.back}</Link>
      </section>
    </div>
  )
  if (n === null) return missing
  return <QueryBoundary query={query} notFound={missing}>{(d) => <Customer d={d} />}</QueryBoundary>
}
