import { useEffect, useState } from 'react'
import type { OrderDetailResponse, PurchaseRecord } from '@shared/api'
import { businessToday } from '@shared/businessDate'
import { formatCentsPlain, parseDollarsToCents } from '@shared/money'
import { useI18n } from '@/i18n'
import { isConflict, useCancelPurchase, useCreatePurchase, useCreateSupplier, useMarkPurchaseOrdered, usePurchases, useRecordReceipt, useSuppliers, useUpdatePurchase } from '@/lib/api'
import { cn } from '@/lib/utils'
import { BTN, BTN_PRIMARY, BTN_SM, Check, ConflictNotice, Field, FormDialog, H2, INPUT, MutationError, SEC, TEXTAREA, useEditSession } from './form'
import QueryBoundary from './QueryBoundary'
import { SizeGrid } from './SizeGrid'
import { Chip, MUTED, PURCHASE_TONE } from './ui'

type Detail = OrderDetailResponse
type Dialog = { kind: 'add' } | { kind: 'edit' | 'ordered' | 'receipt' | 'cancel'; id: number }
/** What every dialog gets: the CURRENT purchase from the purchases query (undefined if gone), and whether that query is not fresh
 * (refetching, or its last refetch failed and the list shown is the old cache): conflict recovery waits for a successful refresh. */
type Live = { p: PurchaseRecord | undefined; fetching: boolean }

const sm = cn(BTN, BTN_SM)
const smPrimary = cn(BTN, BTN_SM, BTN_PRIMARY)
const toInt = (v: string) => (/^\d+$/.test(v.trim()) ? Number(v) : 0)
/** Typed size cells -> the API's sizes map (zeros dropped), and their sum. */
const sizesOf = (cells: Record<string, string>) => Object.fromEntries(Object.entries(cells).map(([k, v]) => [k, toInt(v)] as const).filter(([, v]) => v > 0))
const sumOf = (cells: Record<string, string>) => Object.values(sizesOf(cells)).reduce((s, v) => s + v, 0)
const cellsOf = (sizes: Record<string, number> | null) => Object.fromEntries(Object.entries(sizes ?? {}).map(([k, v]) => [k, String(v)]))
// '' = left empty (null); undefined = typed but not a dollar amount.
const cents = (v: string) => (v.trim() === '' ? null : (parseDollarsToCents(v) ?? undefined))

/** The shared size grid plus the sum that sets the quantity. */
function SizesWithSum({ cells, onChange }: { cells: Record<string, string>; onChange: (c: Record<string, string>) => void }) {
  const { m } = useI18n()
  return (
    <div className="flex flex-col gap-1.5">
      <SizeGrid cells={cells} onChange={onChange} label={m.purchasing.sizeLabel} />
      <span className="text-xs text-muted-foreground">{m.purchasing.sizesSum(sumOf(cells))}</span>
    </div>
  )
}

function PurchaseDialog({ d, p, edit, fetching, onClose }: { d: Detail; edit: boolean; onClose: () => void } & Live) {
  const { m } = useI18n()
  const t = m.purchasing
  const suppliers = useSuppliers()
  const createSupplier = useCreateSupplier()
  const ed = useEditSession(d.order.version, () => ({
    supplierId: p ? String(p.supplierId) : '', description: p?.description ?? '', quantity: p ? String(p.quantity) : '', useSizes: !!p?.sizes, sizes: cellsOf(p?.sizes ?? null),
    est: p?.estimatedUnitCostCents == null ? '' : formatCentsPlain(p.estimatedUnitCostCents), act: p?.actualUnitCostCents == null ? '' : formatCentsPlain(p.actualUnitCostCents),
    expectedOn: p?.expectedOn ?? '', notes: p?.notes ?? '',
  }), !fetching)
  const gone = edit && (!p || p.status === 'cancelled')
  const f = ed.values
  const set = (x: Partial<typeof f>) => ed.setValues({ ...f, ...x })
  const [newName, setNewName] = useState<string | null>(null)
  const [tried, setTried] = useState(false)
  const create = useCreatePurchase(d.order.number)
  const update = useUpdatePurchase(d.order.number)
  const w = edit ? update : create
  // Once ordered, only the actual cost, expected date and notes can change (the server refuses the rest).
  const locked = !!p && p.status !== 'not_ordered'
  const defaultId = suppliers.data?.suppliers.find((s) => s.isDefault)?.id
  const supplierValue = newName !== null ? '__new' : f.supplierId || (defaultId ? String(defaultId) : '')
  const qty = f.useSizes ? sumOf(f.sizes) : toInt(f.quantity)
  const est = cents(f.est)
  const act = cents(f.act)
  const bad = !f.description.trim() || qty < 1 || est === undefined || act === undefined
  return (
    <FormDialog
      open onOpenChange={(o) => !o && onClose()} title={edit ? t.editTitle : t.addTitle} description={edit ? (locked ? t.lockedNote : t.editTitle) : t.addBody} submitLabel={edit ? m.common.save : t.add}
      pending={w.isPending} error={isConflict(w.error) ? null : w.error} disabled={ed.blocked || gone}
      onSubmit={() => {
        setTried(true)
        if (bad || newName !== null) return
        ed.clear()
        const common = { expectedOn: f.expectedOn || null, notes: f.notes.trim() || null, expectedVersion: ed.version }
        const mine = {
          ...(f.supplierId ? { supplierId: Number(f.supplierId) } : {}), description: f.description.trim(), quantity: qty, sizes: f.useSizes ? sizesOf(f.sizes) : null,
          estimatedUnitCostCents: est ?? null,
        }
        const opts = { onSuccess: onClose, onError: ed.onError }
        if (!edit) create.mutate({ ...mine, ...common }, opts)
        else if (p) update.mutate({ id: p.id, ...(locked ? {} : mine), actualUnitCostCents: act ?? null, ...common }, opts)
      }}
    >
      <ConflictNotice show={ed.conflict} />
      {gone && <p role="alert" className="text-xs text-status-red-fg">{t.gone}</p>}
      <Field label={t.supplier}>
        <select
          className={INPUT} value={supplierValue} disabled={locked}
          onChange={(e) => (e.target.value === '__new' ? setNewName('') : (setNewName(null), set({ supplierId: e.target.value })))}
        >
          {suppliers.data?.suppliers.map((s) => <option key={s.id} value={s.id}>{s.isDefault ? t.supplierDefault(s.name) : s.name}</option>)}
          <option value="__new">{t.addSupplier}</option>
        </select>
      </Field>
      {newName !== null && (
        <div className="flex flex-wrap items-end gap-2">
          <Field label={t.newSupplier} className="flex-[1_1_180px]"><input className={INPUT} value={newName} maxLength={100} onChange={(e) => setNewName(e.target.value)} /></Field>
          <button
            type="button" className={sm} disabled={!newName.trim() || createSupplier.isPending}
            onClick={() => createSupplier.mutate({ name: newName.trim() }, { onSuccess: (r) => { set({ supplierId: String(r.supplier.id) }); setNewName(null) } })}
          >{t.createSupplier}</button>
          <MutationError error={createSupplier.error} />
        </div>
      )}
      <Field label={t.description}><input className={INPUT} value={f.description} maxLength={200} readOnly={locked} aria-invalid={(tried && !f.description.trim()) || undefined} onChange={(e) => set({ description: e.target.value })} /></Field>
      <Check checked={f.useSizes} onChange={(v) => !locked && set(v ? { useSizes: true } : { useSizes: false, quantity: String(sumOf(f.sizes) || '') })}>{t.useSizes}</Check>
      {f.useSizes && !locked && <SizesWithSum cells={f.sizes} onChange={(sizes) => set({ sizes })} />}
      <Field label={t.quantity}>
        <input className={cn(INPUT, 'num')} type="number" inputMode="numeric" min={1} readOnly={locked || f.useSizes} aria-invalid={(tried && qty < 1) || undefined} value={f.useSizes ? (qty || '') : f.quantity} onChange={(e) => set({ quantity: e.target.value })} />
      </Field>
      <div className="flex flex-wrap gap-3">
        <Field label={t.estCost} className="flex-[1_1_150px]"><input className={cn(INPUT, 'num')} inputMode="decimal" value={f.est} readOnly={locked} aria-invalid={(tried && est === undefined) || undefined} onChange={(e) => set({ est: e.target.value })} /></Field>
        {edit && <Field label={t.actCost} className="flex-[1_1_150px]"><input className={cn(INPUT, 'num')} inputMode="decimal" value={f.act} aria-invalid={(tried && act === undefined) || undefined} onChange={(e) => set({ act: e.target.value })} /></Field>}
      </div>
      {tried && (est === undefined || act === undefined) && <p role="alert" className="text-xs text-status-red-fg">{t.costInvalid}</p>}
      <Field label={t.expectedOn}><input className={INPUT} type="date" value={f.expectedOn} onChange={(e) => set({ expectedOn: e.target.value })} /></Field>
      <Field label={t.notes}><textarea className={TEXTAREA} rows={2} maxLength={2000} value={f.notes} onChange={(e) => set({ notes: e.target.value })} /></Field>
    </FormDialog>
  )
}

function OrderedDialog({ d, p, fetching, onClose }: { d: Detail; onClose: () => void } & Live) {
  const { m } = useI18n()
  const t = m.purchasing
  const ed = useEditSession(d.order.version, () => businessToday(new Date()), !fetching)
  const gone = !p || p.status !== 'not_ordered'
  const w = useMarkPurchaseOrdered(d.order.number)
  return (
    <FormDialog
      open onOpenChange={(o) => !o && onClose()} title={t.orderedTitle} description={t.orderedBody} submitLabel={t.orderedConfirm} pending={w.isPending}
      error={isConflict(w.error) ? null : w.error} disabled={ed.blocked || !ed.values || gone}
      onSubmit={() => { if (!p) return; ed.clear(); w.mutate({ id: p.id, orderedOn: ed.values, expectedVersion: ed.version }, { onSuccess: onClose, onError: ed.onError }) }}
    >
      <ConflictNotice show={ed.conflict} />
      {gone && <p role="alert" className="text-xs text-status-red-fg">{t.gone}</p>}
      <p className="text-[13px] text-muted-foreground">{p?.description}</p>
      <Field label={t.orderedOnLabel}><input className={INPUT} type="date" required value={ed.values} onChange={(e) => ed.setValues(e.target.value)} /></Field>
    </FormDialog>
  )
}

function ReceiptDialog({ d, p, fetching, onClose }: { d: Detail; onClose: () => void } & Live) {
  const { m } = useI18n()
  const t = m.purchasing
  const ed = useEditSession(d.order.version, () => ({ quantity: String(p ? Math.max(p.quantity - p.receivedQuantity, 1) : 1), useSizes: false, sizes: {} as Record<string, string>, on: businessToday(new Date()), notes: '' }), !fetching)
  const gone = !p || !['ordered', 'partially_received', 'received'].includes(p.status)
  const f = ed.values
  const set = (x: Partial<typeof f>) => ed.setValues({ ...f, ...x })
  const w = useRecordReceipt(d.order.number)
  const qty = f.useSizes ? sumOf(f.sizes) : toInt(f.quantity)
  return (
    <FormDialog
      open onOpenChange={(o) => !o && onClose()} title={t.recordTitle} description={t.recordBody} submitLabel={t.recordConfirm} pending={w.isPending}
      error={isConflict(w.error) ? null : w.error} disabled={ed.blocked || gone || qty < 1 || !f.on}
      onSubmit={() => {
        if (!p) return
        ed.clear()
        w.mutate({ id: p.id, quantity: qty, sizes: f.useSizes ? sizesOf(f.sizes) : null, receivedOn: f.on, notes: f.notes.trim() || null, expectedVersion: ed.version }, { onSuccess: onClose, onError: ed.onError })
      }}
    >
      <ConflictNotice show={ed.conflict} />
      {gone && <p role="alert" className="text-xs text-status-red-fg">{t.gone}</p>}
      {p && <p className="text-[13px] text-muted-foreground">{p.description} · {t.received(p.receivedQuantity, p.quantity)}</p>}
      <Check checked={f.useSizes} onChange={(v) => set(v ? { useSizes: true } : { useSizes: false, quantity: String(sumOf(f.sizes) || '') })}>{t.useSizes}</Check>
      {f.useSizes && <SizesWithSum cells={f.sizes} onChange={(sizes) => set({ sizes })} />}
      <Field label={t.quantity}><input className={cn(INPUT, 'num')} type="number" inputMode="numeric" min={1} readOnly={f.useSizes} value={f.useSizes ? (qty || '') : f.quantity} onChange={(e) => set({ quantity: e.target.value })} /></Field>
      <Field label={t.receivedOn}><input className={INPUT} type="date" required value={f.on} onChange={(e) => set({ on: e.target.value })} /></Field>
      <Field label={t.notes}><textarea className={TEXTAREA} rows={2} maxLength={2000} value={f.notes} onChange={(e) => set({ notes: e.target.value })} /></Field>
    </FormDialog>
  )
}

function CancelDialog({ d, p, onClose }: { d: Detail; onClose: () => void } & Live) {
  const { m } = useI18n()
  const t = m.purchasing
  const ed = useEditSession(d.order.version, () => '')
  const gone = !p || p.status === 'cancelled'
  const w = useCancelPurchase(d.order.number)
  return (
    <FormDialog
      open onOpenChange={(o) => !o && onClose()} title={t.cancelTitle} description={t.cancelBody} submitLabel={t.cancelConfirm} pending={w.isPending}
      error={isConflict(w.error) ? null : w.error} disabled={ed.blocked || gone || !ed.values.trim()}
      onSubmit={() => { if (!p) return; ed.clear(); w.mutate({ id: p.id, reason: ed.values.trim(), expectedVersion: ed.version }, { onSuccess: onClose, onError: ed.onError }) }}
    >
      <ConflictNotice show={ed.conflict} />
      {gone && <p role="alert" className="text-xs text-status-red-fg">{t.gone}</p>}
      <p className="text-[13px] text-muted-foreground">{p?.description}</p>
      <Field label={t.reason}><textarea className={TEXTAREA} rows={2} maxLength={500} required value={ed.values} onChange={(e) => ed.setValues(e.target.value)} /></Field>
    </FormDialog>
  )
}

function PurchaseRow({ p, active, onDialog }: { p: PurchaseRecord; active: boolean; onDialog: (x: Dialog) => void }) {
  const { m, fmt } = useI18n()
  const t = m.purchasing
  const money = (c: number | null) => (c === null ? m.common.dash : fmt.money(c))
  const open = p.status !== 'cancelled'
  // Stored status 'ordered' shows as received once the receipts cover it, but a late delivery or a cancel is still valid.
  const receiving = p.status === 'ordered' || p.status === 'partially_received' || p.status === 'received'
  return (
    <li>
      <section data-purchase={p.id} aria-label={p.description} className="flex flex-col gap-2 rounded-[10px] border border-secondary p-3 text-[13px]">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <span className="min-w-0 flex-[1_1_220px] font-medium">{p.description} <span className="num font-normal text-muted-foreground">× {p.quantity}</span></span>
          <Chip tone={PURCHASE_TONE[p.status]}>{m.labels.purchaseStatus[p.status]}</Chip>
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          <span>{p.supplierName}</span>
          <span className="num">{t.received(p.receivedQuantity, p.quantity)}</span>
          <span className="num">{t.line(money(p.estimatedTotalCents), money(p.actualTotalCents))}</span>
          {p.orderedOn && <span className={cn(MUTED, 'num')}>{t.orderedOn(fmt.date(p.orderedOn))}</span>}
          {p.expectedOn && <span className={cn(MUTED, 'num')}>{t.expected(fmt.date(p.expectedOn))}</span>}
        </div>
        {p.overReceived && <span role="status" className="text-xs text-status-amber-fg">{t.over(p.receivedQuantity - p.quantity)}</span>}
        {p.notes && <span className={MUTED}>{p.notes}</span>}
        {p.receipts.length > 0 && (
          <ul className="flex flex-col gap-1 border-t border-secondary pt-2" aria-label={t.receipts}>
            {p.receipts.map((r) => (
              <li key={r.id} className={MUTED}>
                <span className="num">{t.receipt(r.quantity, fmt.date(r.receivedOn), r.recordedBy)}</span>
                {r.sizes && <span className="num"> · {Object.entries(r.sizes).map(([k, v]) => `${k} ${v}`).join(', ')}</span>}
                {r.notes && <> · {r.notes}</>}
              </li>
            ))}
          </ul>
        )}
        {active && open && (
          <div className="flex flex-wrap items-center gap-1.5">
            <button type="button" className={sm} onClick={() => onDialog({ kind: 'edit', id: p.id })}>{t.edit}</button>
            {p.status === 'not_ordered' && <button type="button" className={smPrimary} onClick={() => onDialog({ kind: 'ordered', id: p.id })}>{t.markOrdered}</button>}
            {receiving && <button type="button" className={smPrimary} onClick={() => onDialog({ kind: 'receipt', id: p.id })}>{t.record}</button>}
            <button type="button" className={sm} onClick={() => onDialog({ kind: 'cancel', id: p.id })}>{t.cancel}</button>
          </div>
        )}
      </section>
    </li>
  )
}

function List({ d, purchases, fetching, autoAdd, onAutoAdd }: { d: Detail; purchases: PurchaseRecord[]; fetching: boolean; autoAdd: boolean; onAutoAdd: () => void }) {
  const { m, fmt } = useI18n()
  const t = m.purchasing
  const [dialog, setDialog] = useState<Dialog | null>(null)
  useEffect(() => { if (autoAdd) { setDialog({ kind: 'add' }); onAutoAdd() } }, [autoAdd, onAutoAdd])
  const active = d.order.state === 'active'
  const unauthorized = d.readiness.items.find((i) => i.key === 'authorization')?.state === 'pending'
  const live = purchases.filter((p) => p.status !== 'cancelled')
  const sum = (k: 'estimatedTotalCents' | 'actualTotalCents') => live.reduce((s, p) => s + (p[k] ?? 0), 0)
  const close = () => setDialog(null)
  const live1 = (id: number): Live => ({ p: purchases.find((x) => x.id === id), fetching })
  return (
    <div className="flex flex-col pb-3">
      <div className={SEC}>
        <h2 className={H2}>{t.title}</h2>
        <button type="button" className={smPrimary} disabled={!active} onClick={() => setDialog({ kind: 'add' })}>{t.add}</button>
      </div>
      <div className="flex flex-col gap-2 px-4">
        {!active && <p className={MUTED}>{t.inactive}</p>}
        {!d.order.materialsRequired && <p role="status" className="rounded-[7px] bg-secondary px-2.5 py-2 text-[12.5px]">{t.notNeeded}</p>}
        {unauthorized && active && <p role="status" className="rounded-[7px] bg-status-amber px-2.5 py-2 text-[12.5px] text-status-amber-fg">{t.hint}</p>}
        {purchases.length === 0 ? <p className="py-6 text-center text-[13px] text-muted-foreground">{t.empty}</p> : (
          <>
            <ul className="flex flex-col gap-3">{purchases.map((p) => <PurchaseRow key={p.id} p={p} active={active} onDialog={setDialog} />)}</ul>
            <p className={cn(MUTED, 'num text-right')}>{t.totals(fmt.money(sum('estimatedTotalCents')), fmt.money(sum('actualTotalCents')))}</p>
          </>
        )}
      </div>
      {dialog?.kind === 'add' && <PurchaseDialog d={d} edit={false} p={undefined} fetching={fetching} onClose={close} />}
      {dialog?.kind === 'edit' && <PurchaseDialog d={d} edit {...live1(dialog.id)} onClose={close} />}
      {dialog?.kind === 'ordered' && <OrderedDialog d={d} {...live1(dialog.id)} onClose={close} />}
      {dialog?.kind === 'receipt' && <ReceiptDialog d={d} {...live1(dialog.id)} onClose={close} />}
      {dialog?.kind === 'cancel' && <CancelDialog d={d} {...live1(dialog.id)} onClose={close} />}
    </div>
  )
}

export function PurchasingTab({ d, autoAdd, onAutoAdd }: { d: Detail; autoAdd: boolean; onAutoAdd: () => void }) {
  const query = usePurchases(d.order.number)
  return <QueryBoundary query={query}>{(r) => <List d={d} purchases={r.purchases} fetching={query.isFetching || query.isError} autoAdd={autoAdd} onAutoAdd={onAutoAdd} />}</QueryBoundary>
}
