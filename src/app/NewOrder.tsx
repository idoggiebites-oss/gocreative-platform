import { useEffect, useId, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import type { CreateOrderRequest, CustomerListRow, OrderWriteResponse } from '@shared/api'
import { ORDER_SOURCES, PAYMENT_TERMS, type OrderSource, type PaymentTerms } from '@shared/enums'
import { useI18n } from '@/i18n'
import { send, useCustomer, useCustomers, useSend } from '@/lib/api'
import { cn } from '@/lib/utils'
import { NewCustomerDialog, KIND_TONE } from './CustomerList'
import { BTN, BTN_PRIMARY, Check, Field, INPUT, LBL, LINK, MutationError, Segmented } from './form'
import { ItemsEditor, newRow, rowIssues, rowsInvalid, toInputs, type Row } from './ItemsEditor'
import { CARD, Chip, PAGE } from './ui'

type Chosen = Pick<CustomerListRow, 'id' | 'name' | 'kind' | 'defaultPoRequired' | 'defaultPaymentTerms'>

/** Search-as-you-type customer picker (an ARIA combobox over /customers). */
function CustomerCombobox({ value, onPick }: { value: Chosen | null; onPick: (c: Chosen) => void }) {
  const { m } = useI18n()
  const id = useId()
  const [text, setText] = useState(value?.name ?? '')
  const [debounced, setDebounced] = useState('')
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => { if (value) setText(value.name) }, [value])
  useEffect(() => {
    const t = setTimeout(() => setDebounced(text.trim()), 200)
    return () => clearTimeout(t)
  }, [text])
  const list = useCustomers(value && text === value.name ? '' : debounced, '', open)
  const rows = list.data?.rows ?? []
  useEffect(() => {
    const close = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [])
  const choose = (c: CustomerListRow) => { onPick(c); setText(c.name); setOpen(false) }
  return (
    <div ref={box} className="relative">
      <input
        className={cn(INPUT, 'w-full')} role="combobox" aria-expanded={open} aria-controls={`${id}-list`} aria-autocomplete="list" aria-label={m.newOrder.customer}
        aria-activedescendant={open && rows[active] ? `${id}-${rows[active].id}` : undefined} autoComplete="off" placeholder={m.newOrder.customerPlaceholder}
        value={text}
        onChange={(e) => { setText(e.target.value); setOpen(true); setActive(0) }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive((a) => Math.min(a + 1, rows.length - 1)) }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)) }
          else if (e.key === 'Enter' && open && rows[active]) { e.preventDefault(); choose(rows[active]) }
          else if (e.key === 'Escape') setOpen(false)
        }}
      />
      {open && (
        <ul id={`${id}-list`} role="listbox" aria-label={m.newOrder.customer} className="absolute z-20 mt-1 max-h-64 w-full overflow-auto rounded-[7px] border border-border bg-popover py-1 shadow-md">
          {rows.length === 0 && <li className="px-3 py-2 text-[13px] text-muted-foreground">{list.isFetching ? m.common.loading : m.palette.noResults}</li>}
          {rows.map((c, i) => (
            <li
              key={c.id} id={`${id}-${c.id}`} role="option" aria-selected={i === active}
              onMouseDown={(e) => { e.preventDefault(); choose(c) }} onMouseEnter={() => setActive(i)}
              className={cn('flex cursor-pointer items-center justify-between gap-2 px-3 py-1.5 text-[13px]', i === active && 'bg-secondary')}
            >
              <span className="truncate">{c.name}</span><span className={LBL}>{m.labels.customerKind[c.kind]}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export default function NewOrder() {
  const { m } = useI18n()
  const t = m.newOrder
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const preset = Number(params.get('customer')) || null
  const [customer, setCustomer] = useState<Chosen | null>(null)
  const [contactId, setContactId] = useState('')
  const [source, setSource] = useState<OrderSource>('email')
  const [title, setTitle] = useState('')
  const [due, setDue] = useState('')
  const [po, setPo] = useState(false)
  const [terms, setTerms] = useState<PaymentTerms>('due_at_pickup')
  const [artwork, setArtwork] = useState(true)
  const [rows, setRows] = useState<Row[]>(() => [newRow()])
  const [tried, setTried] = useState(false)
  const [adding, setAdding] = useState(false)
  const [created, setCreated] = useState<string | null>(null)
  const [quoteError, setQuoteError] = useState<Error | null>(null)

  const detail = useCustomer(customer?.id ?? preset)
  const contacts = (detail.data?.contacts ?? []).filter((c) => !c.archived)
  const pick = (c: Chosen, primary?: number) => {
    setCustomer(c)
    setPo(c.defaultPoRequired)
    setTerms(c.defaultPaymentTerms)
    setContactId(primary ? String(primary) : '')
  }
  // ?customer=ID from a customer's page: fill the same fields once its detail arrives.
  const presetDone = useRef(false)
  useEffect(() => {
    const d = detail.data
    if (!preset || presetDone.current || !d || d.customer.id !== preset) return
    presetDone.current = true
    pick({ id: d.customer.id, name: d.customer.name, kind: d.customer.kind, defaultPoRequired: d.customer.defaultPoRequired, defaultPaymentTerms: d.customer.defaultPaymentTerms }, d.contacts.find((c) => c.isPrimary && !c.archived)?.id)
  }, [detail.data, preset])
  // Picking from the list: preselect the primary contact once the contacts are known.
  const contactTouched = useRef(false)
  useEffect(() => {
    if (contactTouched.current || contactId || !detail.data || detail.data.customer.id !== customer?.id) return
    const primary = detail.data.contacts.find((c) => c.isPrimary && !c.archived)
    if (primary) setContactId(String(primary.id))
  }, [detail.data, customer, contactId])

  const create = useSend<OrderWriteResponse, { quote: boolean }>(async ({ quote }) => {
    const body: CreateOrderRequest = {
      customerId: customer!.id, contactId: contactId ? Number(contactId) : null, source, title: title.trim(), dueDate: due || null,
      poRequired: po, paymentTerms: terms, artworkRequired: artwork, items: toInputs(rows),
    }
    const order = await send<OrderWriteResponse>('POST', '/orders', body)
    if (quote) {
      try {
        // The quote reads the version the create just returned, never a refetch.
        await send('POST', `/orders/${order.number}/quotes`, { expectedVersion: order.version })
      } catch (e) {
        setCreated(order.number)
        setQuoteError(e as Error)
        throw e
      }
    }
    return order
  })

  const noProduct = !rows.some((r) => r.kind === 'product')
  const errors = {
    customer: !customer, title: !title.trim(), rows: rowsInvalid(rows),
  }
  const submit = (quote: boolean) => {
    setTried(true)
    if (errors.customer || errors.title || errors.rows || (quote && noProduct)) return
    create.mutate({ quote }, { onSuccess: (o) => void navigate(`/app/orders/${o.number}`) })
  }
  const hasIssues = rows.some((r) => rowIssues(r).length > 0)

  return (
    <div className={cn(PAGE, 'max-w-[1100px]')}>
      <nav aria-label={m.order.breadcrumb} className="text-[13px] text-muted-foreground">
        <Link to="/app/orders" className="text-muted-foreground no-underline hover:text-foreground">{m.nav.orders}</Link> <span aria-hidden>/</span> <span className="font-medium text-foreground">{t.title}</span>
      </nav>
      <div className="flex flex-col gap-1"><h1 className="text-xl font-semibold tracking-[-0.015em]">{t.title}</h1><span className={LBL}>{t.numberNote}</span></div>
      <form noValidate onSubmit={(e) => { e.preventDefault(); submit(false) }} className="flex flex-col gap-4">
        <section className={`${CARD} flex flex-col gap-3.5 px-4 py-3.5`} aria-labelledby="s1">
          <h2 id="s1" className="text-sm font-semibold">{t.customerSection}</h2>
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex min-w-0 flex-[2_1_320px] flex-col gap-1"><span className={LBL}>{t.customer}</span><CustomerCombobox value={customer} onPick={(c) => { contactTouched.current = false; pick(c) }} /></div>
            <button type="button" className={cn(LINK, 'inline-flex h-[34px] cursor-pointer items-center border-0 bg-transparent p-0 text-[13px]')} onClick={() => setAdding(true)}>{t.newCustomer}</button>
            <Field label={t.contact} className="flex-[1_1_240px]">
              <select className={INPUT} value={contactId} disabled={!customer} onChange={(e) => { contactTouched.current = true; setContactId(e.target.value) }}>
                <option value="">{t.noContact}</option>
                {contacts.map((c) => <option key={c.id} value={c.id}>{c.title ? `${c.name} · ${c.title}` : c.name}</option>)}
              </select>
            </Field>
          </div>
          {tried && errors.customer && <p role="alert" className="text-xs text-status-red-fg">{t.customerRequired}</p>}
          {customer && (
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-2 rounded-[7px] bg-background px-2.5 py-2 text-[13px]">
              <Chip tone={KIND_TONE[customer.kind]}>{m.labels.customerKind[customer.kind]}</Chip>
              <span>{t.defaultsFrom}</span>
              <b className="font-medium">{customer.defaultPoRequired ? m.order.detail.poRequired : t.noPoRequired}</b><span aria-hidden>·</span>
              <b className="font-medium">{m.labels.paymentTerms[customer.defaultPaymentTerms]}</b>
              <span className={LBL}>{t.editableBelow}</span>
            </div>
          )}
        </section>

        <section className={`${CARD} flex flex-col gap-3.5 px-4 py-3.5`} aria-labelledby="s2">
          <h2 id="s2" className="text-sm font-semibold">{t.detailsSection}</h2>
          <div className="flex flex-wrap items-end gap-3">
            <Segmented label={m.order.detail.source} value={source} options={ORDER_SOURCES} labels={m.labels.orderSource} onChange={setSource} />
            <Field label={t.orderTitle} className="flex-[2_1_280px]"><input className={INPUT} value={title} aria-invalid={(tried && errors.title) || undefined} onChange={(e) => setTitle(e.target.value)} /></Field>
            <Field label={t.dueDate} className="flex-[1_1_170px]"><input className={INPUT} type="date" value={due} onChange={(e) => setDue(e.target.value)} /></Field>
          </div>
          {tried && errors.title && <p role="alert" className="text-xs text-status-red-fg">{t.titleRequired}</p>}
          <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
            <Check checked={po} onChange={setPo}>{m.order.detail.poRequired}</Check>
            <Field label={m.order.detail.paymentTerms} className="flex-[0_1_220px]">
              <select className={INPUT} value={terms} onChange={(e) => setTerms(e.target.value as PaymentTerms)}>
                {PAYMENT_TERMS.map((k) => <option key={k} value={k}>{m.labels.paymentTerms[k]}</option>)}
              </select>
            </Field>
            <Check checked={artwork} onChange={setArtwork}>{t.artworkRequired}</Check>
            {customer && <span className={cn(LBL, 'inline-flex h-[34px] items-center')}>{t.prefilled(customer.name)}</span>}
          </div>
        </section>

        <ItemsEditor rows={rows} onChange={setRows} showIssues={tried} />
        {tried && !errors.rows && noProduct && <p role="alert" className="text-xs text-status-red-fg">{m.api.errors.no_product_line}</p>}
        {tried && hasIssues && <p role="alert" className="text-xs text-status-red-fg">{t.fixItems}</p>}

        <div className="flex flex-wrap items-center justify-end gap-2.5">
          <MutationError error={quoteError ?? create.error} />
          {created && <Link to={`/app/orders/${created}`} className={LINK}>{t.openCreated(created)}</Link>}
          <Link to="/app/orders" className={BTN}>{m.common.cancel}</Link>
          <button type="submit" className={BTN} disabled={create.isPending || !!created}>{create.isPending ? m.common.saving : t.save}</button>
          <button type="button" className={cn(BTN, BTN_PRIMARY)} disabled={create.isPending || !!created} onClick={() => submit(true)}>{t.saveAndQuote}</button>
        </div>
      </form>
      {adding && <NewCustomerDialog open onOpenChange={setAdding} onCreated={(c) => { contactTouched.current = false; pick(c) }} />}
    </div>
  )
}
