import { useState, type ReactNode } from 'react'
import type { OrderDetailResponse, OrderWriteResponse, PurchaseOrderCreateRequest, PurchaseOrderRecord } from '@shared/api'
import { formatCentsPlain, parseDollarsToCents } from '@shared/money'
import { useI18n } from '@/i18n'
import { send, useSend } from '@/lib/api'
import { cn } from '@/lib/utils'
import { BTN, BTN_PRIMARY, BTN_SM, Field, FormDialog, INPUT, TEXTAREA } from './form'
import { MUTED } from './ui'
import { FileLinks, fmtSize, UploadDialog } from './uploads'

type Detail = OrderDetailResponse
type Dialog = { kind: 'request' | 'add' } | { kind: 'edit'; po: PurchaseOrderRecord } | { kind: 'doc'; po: PurchaseOrderRecord }
// replaceApproved + reason are required by the API when the latest PO is approved.
type CreateBody = PurchaseOrderCreateRequest

const sm = cn(BTN, BTN_SM)

function PoDialog({ d, kind, po, onClose }: { d: Detail; kind: 'request' | 'add' | 'edit'; po?: PurchaseOrderRecord; onClose: () => void }) {
  const { m } = useI18n()
  const t = m.files.po
  const [version] = useState(d.order.version)
  const [number, setNumber] = useState(po?.poNumber ?? '')
  const [amount, setAmount] = useState(po?.amountCents == null ? '' : formatCentsPlain(po.amountCents))
  const [reason, setReason] = useState('')
  const [tried, setTried] = useState(false)
  const replacing = kind !== 'edit' && d.purchaseOrders[0]?.status === 'approved'
  const base = `/orders/${encodeURIComponent(d.order.number)}/purchase-orders`
  const w = useSend((b: CreateBody) => (po ? send<OrderWriteResponse>('PATCH', `${base}/${po.id}/details`, b) : send<OrderWriteResponse>('POST', base, b)))
  const cents = amount.trim() === '' ? null : parseDollarsToCents(amount)
  const amountBad = kind !== 'request' && amount.trim() !== '' && cents === null
  return (
    <FormDialog
      open onOpenChange={(o) => !o && onClose()} submitLabel={kind === 'edit' ? m.common.save : t.create} pending={w.isPending} error={w.error}
      title={kind === 'edit' ? t.editTitle : kind === 'add' ? t.addTitle : t.requestTitle} description={kind === 'request' ? t.requestBody : kind === 'add' ? t.addBody : t.editTitle}
      disabled={replacing && !reason.trim()}
      onSubmit={() => {
        setTried(true)
        if (amountBad) return
        const body: CreateBody = { expectedVersion: version }
        if (kind !== 'request') { body.poNumber = number.trim() || null; body.amountCents = cents }
        if (replacing) { body.replaceApproved = true; body.reason = reason.trim() }
        w.mutate(body, { onSuccess: onClose })
      }}
    >
      {kind !== 'request' && (
        <div className="flex flex-wrap gap-3">
          <Field label={t.number} className="flex-[1_1_160px]"><input className={INPUT} value={number} maxLength={100} onChange={(e) => setNumber(e.target.value)} /></Field>
          <Field label={t.amount} className="flex-[1_1_140px]">
            <input className={INPUT} inputMode="decimal" value={amount} aria-invalid={(tried && amountBad) || undefined} onChange={(e) => setAmount(e.target.value)} />
          </Field>
        </div>
      )}
      {tried && amountBad && <p role="alert" className="text-xs text-status-red-fg">{t.amountInvalid}</p>}
      {replacing && (
        <>
          <p role="status" className="rounded-[7px] bg-status-amber px-2.5 py-2 text-[12.5px] text-status-amber-fg">{t.approvedWarning}</p>
          <Field label={t.reason} hint={t.reasonHint}><textarea className={TEXTAREA} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        </>
      )}
    </FormDialog>
  )
}

function PoBlock({ d, p, latest, menu, onDialog }: { d: Detail; p: PurchaseOrderRecord; latest: boolean; menu: ReactNode; onDialog: (x: Dialog) => void }) {
  const { m, fmt } = useI18n()
  const t = m.files.po
  const active = d.order.state === 'active'
  const approved = p.status === 'approved'
  const label = p.poNumber ?? t.unnumbered
  return (
    <li data-po={p.id} className="flex flex-col gap-2 rounded-[10px] border border-secondary p-3 text-[13px]">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="num min-w-0 font-medium">{label}{latest && <span className={`${MUTED} ml-2 font-normal`}>{m.order.po.latest}</span>}</span>
        <span className="num">{p.amountCents === null ? m.common.dash : fmt.money(p.amountCents)}</span>
        {menu}
        <span className={`${MUTED} num`}>{fmt.relative(p.updatedAt)}</span>
        <span className="ml-auto flex flex-wrap items-center gap-1.5">
          <button type="button" className={sm} disabled={!active || approved} aria-describedby={approved ? `po-lock-${p.id}` : undefined} onClick={() => onDialog({ kind: 'edit', po: p })}>{t.edit}</button>
          <button type="button" className={sm} disabled={!active} onClick={() => onDialog({ kind: 'doc', po: p })}>{t.addDoc}</button>
        </span>
      </div>
      {approved && <span id={`po-lock-${p.id}`} className={MUTED}>{t.locked}</span>}
      <ul className="flex flex-col gap-1.5" aria-label={`${t.docs}: ${label}`}>
        {p.documents.length === 0 && <li className={MUTED}>{t.noDocs}</li>}
        {p.documents.map((x) => (
          <li key={x.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
            <span className="min-w-0 truncate">{x.file.filename ?? m.common.dash} <span className={MUTED}>· {fmtSize(x.file.bytes)} · {fmt.relative(x.file.uploadedAt)}</span></span>
            <FileLinks file={x.file} name={x.file.filename ?? label} />
          </li>
        ))}
      </ul>
    </li>
  )
}

/** `menu` renders a PO's status dropdown (it lives in OrderDetail with the other status controls). */
export function PoTab({ d, menu }: { d: Detail; menu: (po: PurchaseOrderRecord) => ReactNode }) {
  const { m } = useI18n()
  const t = m.files.po
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const canCreate = d.order.poRequired && d.order.state === 'active'
  const close = () => setDialog(null)
  return (
    <div className="flex flex-col gap-3 p-4">
      {canCreate && (
        <div className="flex flex-wrap gap-2">
          <button type="button" className={cn(BTN, BTN_SM, BTN_PRIMARY)} onClick={() => setDialog({ kind: 'add' })}>{t.add}</button>
          <button type="button" className={sm} onClick={() => setDialog({ kind: 'request' })}>{t.request}</button>
        </div>
      )}
      {!d.order.poRequired && d.purchaseOrders.length === 0 && <p className="py-4 text-center text-[13px] text-muted-foreground">{t.notNeeded}</p>}
      {d.order.poRequired && d.purchaseOrders.length === 0 && <p className="py-4 text-center text-[13px] text-muted-foreground">{m.order.po.empty}</p>}
      <ul className="flex flex-col gap-3">
        {d.purchaseOrders.map((p, i) => <PoBlock key={p.id} d={d} p={p} latest={i === 0} menu={menu(p)} onDialog={setDialog} />)}
      </ul>
      {(dialog?.kind === 'request' || dialog?.kind === 'add') && <PoDialog d={d} kind={dialog.kind} onClose={close} />}
      {dialog?.kind === 'edit' && <PoDialog d={d} kind="edit" po={dialog.po} onClose={close} />}
      {dialog?.kind === 'doc' && (
        <UploadDialog
          d={d} onClose={close} title={t.docTitle(dialog.po.poNumber ?? t.unnumbered)} description={t.docBody}
          path={`/purchase-orders/${dialog.po.id}/documents`} allowSvg={false}
        />
      )}
    </div>
  )
}
