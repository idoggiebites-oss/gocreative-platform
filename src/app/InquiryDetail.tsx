import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import type { InquiryConvertRequest, InquiryConvertResponse, InquiryDetailResponse } from '@shared/api'
import { CUSTOMER_KINDS, type CustomerKind } from '@shared/enums'
import { useI18n } from '@/i18n'
import { send, useInquiry, useInquiryEstimates, useMe, useSend } from '@/lib/api'
import { BTN, BTN_PRIMARY, Check, Field, FormDialog, H2, INPUT, LINK, MutationError, SEC, TEXTAREA } from './form'
import InquiryEstimates from './InquiryEstimates'
import QueryBoundary from './QueryBoundary'
import { CARD, Chip, MUTED, PAGE, TD, TH, type Tone } from './ui'

const TONE: Record<InquiryDetailResponse['status'], Tone> = { new: 'blue', converted: 'green', declined: 'gray', spam: 'amber' }

function ConvertDialog({ d, onClose }: { d: InquiryDetailResponse; onClose: () => void }) {
  const { m } = useI18n()
  const t = m.inquiries
  const nav = useNavigate()
  const first = d.matches[0]
  const [choice, setChoice] = useState<string>(first ? String(first.id) : 'new')
  const match = d.matches.find((c) => String(c.id) === choice)
  const [contact, setContact] = useState<string>('new')
  const [name, setName] = useState(d.organization ?? d.contactName ?? '')
  const [kind, setKind] = useState<CustomerKind>(d.customerKind ?? 'individual')
  const [org, setOrg] = useState(d.organization ?? '')
  const [title, setTitle] = useState(`${d.organization ?? d.contactName ?? ''} (${d.ref ?? `#${d.id}`})`.trim())
  const [due, setDue] = useState(d.dueDate ?? '')
  const [artwork, setArtwork] = useState(true) // a public upload never clears this by itself; staff may turn it off on purpose
  const verified = useInquiryEstimates(d.id).data?.estimates.at(-1)?.factsSource === 'staff_reviewed'
  const convert = useSend<InquiryConvertResponse, InquiryConvertRequest>((b) => send('POST', `/inquiries/${d.id}/convert`, b))
  return (
    <FormDialog
      open onOpenChange={(o) => { if (!o) onClose() }} title={t.convertTitle} description={t.convertBody} submitLabel={t.submit} pending={convert.isPending} error={convert.error}
      disabled={!title.trim() || (choice === 'new' && !name.trim())}
      onSubmit={() => convert.mutate(
        {
          expectedVersion: d.version, title: title.trim(), dueDate: due || null, artworkRequired: artwork,
          customer: match ? { existingId: match.id, contactId: contact === 'new' ? null : Number(contact) } : { new: { name: name.trim(), kind, organization: org.trim() || null } },
        },
        { onSuccess: (r) => void nav(`/app/orders/${r.number}`) },
      )}
    >
      <p className="text-[13px]" data-testid="convert-specs">{verified ? t.specsVerified : t.specsUnverified}</p>
      <Field label={t.customer} hint={d.matches.length > 0 ? t.suggested : undefined}>
        <select className={INPUT} value={choice} onChange={(e) => { setChoice(e.target.value); setContact('new') }}>
          {d.matches.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          <option value="new">{t.newCustomer}</option>
        </select>
      </Field>
      {match ? (
        <Field label={t.contactOn}>
          <select className={INPUT} value={contact} onChange={(e) => setContact(e.target.value)}>
            <option value="new">{t.newContact(d.contactName ?? '')}</option>
            {match.contacts.map((k) => <option key={k.id} value={k.id}>{k.name}{k.email ? `, ${k.email}` : ''}</option>)}
          </select>
        </Field>
      ) : (
        <>
          <Field label={t.customerName}><input className={INPUT} value={name} maxLength={200} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label={t.kind}>
            <select className={INPUT} value={kind} onChange={(e) => setKind(e.target.value as CustomerKind)}>
              {CUSTOMER_KINDS.map((k) => <option key={k} value={k}>{m.labels.customerKind[k]}</option>)}
            </select>
          </Field>
          <Field label={t.organization}><input className={INPUT} value={org} maxLength={200} onChange={(e) => setOrg(e.target.value)} /></Field>
        </>
      )}
      <Field label={t.orderTitle}><input className={INPUT} value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} /></Field>
      <Field label={t.dueDate} hint={d.dueDate ? t.dueHint : undefined}><input className={INPUT} type="date" value={due} onChange={(e) => setDue(e.target.value)} /></Field>
      <Check checked={artwork} onChange={setArtwork}>{t.artworkRequired}</Check>
    </FormDialog>
  )
}

function Detail({ d }: { d: InquiryDetailResponse }) {
  const { m, fmt } = useI18n()
  const t = m.inquiries
  const nav = useNavigate()
  const [dialog, setDialog] = useState<'convert' | 'decline' | 'delete' | null>(null)
  const [reason, setReason] = useState('')
  const status = useSend<unknown, { to: 'new' | 'declined' | 'spam'; reason?: string }>((b) => send('POST', `/inquiries/${d.id}/status`, { expectedVersion: d.version, ...b }))
  const remove = useSend<unknown, void>(() => send('DELETE', `/inquiries/${d.id}`, { expectedVersion: d.version }))
  const list = '/app/orders?view=inquiries'
  const method = (x: string) => (x === 'help' ? t.helpMethod : (Object.hasOwn(m.labels.method, x) ? (m.labels.method as Record<string, string>)[x] : x))
  const me = useMe()
  return (
    <div className={PAGE}>
      <div className="flex flex-col gap-1">
        <Link to={list} className={`${LINK} text-[13px]`}>{t.back}</Link>
        <div className="flex flex-wrap items-center gap-2">
          <h1 tabIndex={-1} className="text-xl font-semibold">{d.ref ?? `#${d.id}`}</h1>
          <Chip tone={TONE[d.status]}>{t.tabs[d.status]}</Chip>
        </div>
        <p className={MUTED}>{t.received(fmt.date(d.receivedAt))}</p>
        {d.orderNumber && <p className="text-[13px]">{t.becameOrder} <Link className={LINK} to={`/app/orders/${d.orderNumber}`}>{d.orderNumber}</Link></p>}
        {d.declineReason && <p className="text-[13px]">{t.declinedBecause} {d.declineReason}</p>}
      </div>

      <div className="flex flex-wrap gap-2">
        {d.status === 'new' && d.convertible && <button type="button" className={`${BTN} ${BTN_PRIMARY}`} onClick={() => setDialog('convert')}>{t.convert}</button>}
        {d.status === 'new' && <button type="button" className={BTN} onClick={() => setDialog('decline')}>{t.decline}</button>}
        {d.status === 'new' && <button type="button" className={BTN} disabled={status.isPending} onClick={() => status.mutate({ to: 'spam' })}>{t.spam}</button>}
        {(d.status === 'declined' || d.status === 'spam') && <button type="button" className={BTN} disabled={status.isPending} onClick={() => status.mutate({ to: 'new' })}>{t.reopen}</button>}
        {d.status !== 'converted' && me.data?.role === 'owner' && <button type="button" className={BTN} onClick={() => setDialog('delete')}>{t.delete}</button>}
      </div>
      <MutationError error={status.error} />

      <section className={CARD} aria-labelledby="inq-request">
        <div className={SEC}><h2 id="inq-request" className={H2}>{t.request}</h2></div>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[13px]">
            <thead><tr className="bg-header"><th className={TH}>{m.orders.inquiryCols.id}</th><th className={TH}>{t.qty}</th><th className={TH}>{t.sizes}</th><th className={TH}>{t.color}</th></tr></thead>
            <tbody>
              {d.lines.map((l, i) => (
                <tr key={i}>
                  <td className={`${TD} whitespace-normal`}>
                    <strong>{l.product}</strong>, {method(l.method)}
                    {l.prints.map((p, k) => <p key={k} className={MUTED}>{t.printLabel}: {[p.location, p.size, p.filename].filter(Boolean).join(', ')}</p>)}
                    {l.personalization && <p className={MUTED}>{t.personalization}: {l.personalization}</p>}
                    {l.material && <p className={MUTED}>{t.material}: {l.material}</p>}
                    {l.notes && <p className={MUTED}>{t.noteLabel}: {l.notes}</p>}
                  </td>
                  <td className={`${TD} num`}>{l.quantity}</td>
                  <td className={`${TD} num`}>{l.sizes ? Object.entries(l.sizes).map(([s, n]) => `${s} ${n}`).join(', ') : m.common.dash}</td>
                  <td className={TD}>{l.color ?? m.common.dash}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <InquiryEstimates inquiryId={d.id} canReview={d.status === 'new'} />

      <section className={CARD} aria-labelledby="inq-project">
        <div className={SEC}><h2 id="inq-project" className={H2}>{t.project}</h2></div>
        <div className="flex flex-col gap-2 px-4 pb-4 text-[13px]">
          <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{d.description ?? t.noProject}</p>
          <p><strong>{t.requestedDeadline}:</strong> {d.dueDate ? fmt.date(d.dueDate) : t.noDeadline}{d.dueDate && <span className={MUTED}> {t.deadlineHint}</span>}</p>
          {d.designHelp && <p>{t.designHelp}</p>}
        </div>
      </section>

      <section className={CARD} aria-labelledby="inq-contact">
        <div className={SEC}><h2 id="inq-contact" className={H2}>{t.contact}</h2></div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 px-4 pb-4 text-[13px]">
          {d.customerKind && <><dt className={MUTED}>{t.kind}</dt><dd>{m.labels.customerKind[d.customerKind]}</dd></>}
          {d.organization && <><dt className={MUTED}>{t.organization}</dt><dd>{d.organization}</dd></>}
          <dt className={MUTED}>{m.orders.inquiryCols.name}</dt><dd>{d.contactName ?? m.common.dash}</dd>
          <dt className={MUTED}>{m.orders.inquiryCols.email}</dt><dd>{d.contactEmail ?? m.common.dash}</dd>
          <dt className={MUTED}>{m.orders.inquiryCols.phone}</dt><dd className="num">{d.contactPhone ?? m.common.dash}</dd>
        </dl>
      </section>

      <section className={CARD} aria-labelledby="inq-files">
        <div className={SEC}><h2 id="inq-files" className={H2}>{t.files}</h2></div>
        {d.files.length === 0 ? <p className={`${MUTED} px-4 pb-4`}>{t.noFiles}</p> : (
          <ul className="flex flex-col gap-2 px-4 pb-4 text-[13px]">
            {d.files.map((f) => (
              <li key={f.id} className="flex flex-wrap items-center gap-2">
                <a className={LINK} href={`/api/app/files/${f.id}`} target="_blank" rel="noopener">{f.filename ?? `${t.open} #${f.id}`}</a>
                <Chip tone={f.kind === 'po' ? 'amber' : 'gray'}>{f.kind === 'po' ? t.poUnverified : t.artwork}</Chip>
              </li>
            ))}
          </ul>
        )}
      </section>

      {dialog === 'convert' && <ConvertDialog d={d} onClose={() => setDialog(null)} />}
      {dialog === 'decline' && (
        <FormDialog open onOpenChange={() => setDialog(null)} title={t.declineTitle} submitLabel={t.declineSubmit} pending={status.isPending} error={status.error}
          onSubmit={() => status.mutate({ to: 'declined', reason: reason.trim() || undefined }, { onSuccess: () => setDialog(null) })}>
          <Field label={t.declineReason}><textarea className={TEXTAREA} rows={3} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        </FormDialog>
      )}
      {dialog === 'delete' && (
        <FormDialog open onOpenChange={() => setDialog(null)} title={t.deleteTitle} description={t.deleteBody} submitLabel={t.deleteSubmit} pending={remove.isPending} error={remove.error}
          onSubmit={() => remove.mutate(undefined, { onSuccess: () => void nav(list) })}>
          <span />
        </FormDialog>
      )}
    </div>
  )
}

export default function InquiryDetail() {
  const { id } = useParams()
  const query = useInquiry(id ?? '')
  const { m } = useI18n()
  return <QueryBoundary query={query} notFound={<p className="p-6">{m.inquiries.notFound}</p>}>{(d) => <Detail d={d} />}</QueryBoundary>
}
