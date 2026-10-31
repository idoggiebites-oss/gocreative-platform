import { useState } from 'react'
import { NOTIFICATION_METHODS, type NotificationMethod } from '@shared/enums'
import { businessToday } from '@shared/businessDate'
import type { PickupResponse } from '@shared/api'
import { useI18n } from '@/i18n'
import { isConflict, useCollectPickup, useMe, useNotifyPickup, usePickup } from '@/lib/api'
import { cn } from '@/lib/utils'
import { BTN, BTN_PRIMARY, BTN_SM, ConflictNotice, Field, FormDialog, H2, INPUT, SEC, TEXTAREA, useEditSession } from './form'
import QueryBoundary from './QueryBoundary'
import { Chip, FULFILMENT_TONE, MUTED } from './ui'

const sm = cn(BTN, BTN_SM)
const smPrimary = cn(BTN, BTN_SM, BTN_PRIMARY)
/** What the dialogs get: the CURRENT pickup record from the query, and whether that query is not fresh (refetching or failed): conflict recovery waits for a good refetch. */
type Live = { p: PickupResponse; fetching: boolean; onClose: () => void }

function NotifyDialog({ p, fetching, onClose }: Live) {
  const { m } = useI18n()
  const t = m.pickup
  const w = useNotifyPickup(p.number)
  const ed = useEditSession(p.version, () => ({ on: p.pickup.notifiedOn ?? businessToday(new Date()), method: p.pickup.notificationMethod ?? ('phone' as NotificationMethod), notes: p.pickup.notes ?? '' }), !fetching)
  const f = ed.values
  const set = (x: Partial<typeof f>) => ed.setValues({ ...f, ...x })
  const st = p.pickup.fulfilmentStatus
  const gone = p.state !== 'active' || (st !== 'ready_for_pickup' && st !== 'customer_notified')
  return (
    <FormDialog
      open onOpenChange={(o) => !o && onClose()} title={t.notify} description={t.notifyBody} submitLabel={t.notify} pending={w.isPending}
      error={isConflict(w.error) ? null : w.error} disabled={ed.blocked || gone || !f.on}
      onSubmit={() => { ed.clear(); w.mutate({ notifiedOn: f.on, method: f.method, notes: f.notes.trim() || null, expectedVersion: ed.version }, { onSuccess: onClose, onError: ed.onError }) }}
    >
      <ConflictNotice show={ed.conflict} />
      {gone && <p role="alert" className="text-xs text-status-red-fg">{t.gone}</p>}
      <Field label={t.date}><input className={INPUT} type="date" required value={f.on} onChange={(e) => set({ on: e.target.value })} /></Field>
      <Field label={t.method}>
        <select className={INPUT} value={f.method} onChange={(e) => set({ method: e.target.value as NotificationMethod })}>
          {NOTIFICATION_METHODS.map((k) => <option key={k} value={k}>{m.labels.notificationMethod[k]}</option>)}
        </select>
      </Field>
      <Field label={t.notes}><textarea className={TEXTAREA} rows={2} maxLength={2000} value={f.notes} onChange={(e) => set({ notes: e.target.value })} /></Field>
    </FormDialog>
  )
}

function CollectDialog({ p, fetching, onClose }: Live) {
  const { m, fmt } = useI18n()
  const t = m.pickup
  const me = useMe()
  const w = useCollectPickup(p.number)
  const ed = useEditSession(p.version, () => ({ on: businessToday(new Date()), name: '', notes: p.pickup.notes ?? '', override: false, reason: '' }), !fetching)
  const f = ed.values
  const set = (x: Partial<typeof f>) => ed.setValues({ ...f, ...x })
  const st = p.pickup.fulfilmentStatus
  const gone = p.state !== 'active' || (st !== 'ready_for_pickup' && st !== 'customer_notified')
  const owner = me.data?.role === 'owner'
  // The warning follows the live record; the override choice belongs to this form session.
  const needs = p.releaseNeedsOverride
  const overriding = needs && owner && f.override
  const blocked = needs && !(overriding && f.reason.trim())
  return (
    <FormDialog
      open onOpenChange={(o) => !o && onClose()} title={t.collect} description={t.collectBody} submitLabel={t.collect} pending={w.isPending}
      error={isConflict(w.error) ? null : w.error} disabled={ed.blocked || gone || !f.name.trim() || !f.on || blocked}
      onSubmit={() => {
        ed.clear()
        w.mutate(
          { pickedUpOn: f.on, collectedByName: f.name.trim(), notes: f.notes.trim() || null, expectedVersion: ed.version, ...(overriding ? { override: true, reason: f.reason.trim() } : {}) },
          { onSuccess: onClose, onError: ed.onError },
        )
      }}
    >
      <ConflictNotice show={ed.conflict} />
      {gone && <p role="alert" className="text-xs text-status-red-fg">{t.gone}</p>}
      {needs && (
        <div role="alert" className="flex flex-col gap-2 rounded-[7px] bg-status-amber px-2.5 py-2 text-[12.5px] text-status-amber-fg">
          <p>{p.balance.outstandingCents === null ? t.unpaidUnknown : t.unpaid(fmt.money(p.balance.outstandingCents))}</p>
          <p>{owner ? t.ownerHint : t.staffHint}</p>
          {owner && <button type="button" aria-pressed={f.override} className={cn(sm, 'self-start')} onClick={() => set({ override: !f.override })}>{f.override ? t.overrideCancel : t.override}</button>}
        </div>
      )}
      {overriding && <Field label={t.reason}><textarea className={TEXTAREA} rows={2} maxLength={500} required value={f.reason} onChange={(e) => set({ reason: e.target.value })} /></Field>}
      <Field label={t.collectedBy} hint={t.collectedByHint}><input className={INPUT} required maxLength={200} value={f.name} onChange={(e) => set({ name: e.target.value })} /></Field>
      <Field label={t.date}><input className={INPUT} type="date" required value={f.on} onChange={(e) => set({ on: e.target.value })} /></Field>
      <Field label={t.notes}><textarea className={TEXTAREA} rows={2} maxLength={2000} value={f.notes} onChange={(e) => set({ notes: e.target.value })} /></Field>
    </FormDialog>
  )
}

/**
 * Record notification / Record pickup for one order. The one component behind both the dashboard's Ready for pickup rows
 * and the order's Pickup tab. It reads the pickup record itself (version and unpaid warning come from the query), and renders
 * nothing until it has loaded or once the order can't be picked up.
 */
export function PickupActions({ number }: { number: string }) {
  const { m } = useI18n()
  const t = m.pickup
  const q = usePickup(number)
  const [dialog, setDialog] = useState<'notify' | 'collect' | null>(null)
  const p = q.data
  const st = p?.pickup.fulfilmentStatus
  // The dialogs stay mounted while open even if the order moves on under them (they show their own "gone" text).
  const live = p ? { p, fetching: q.isFetching || q.isError, onClose: () => setDialog(null) } : null
  const can = p?.state === 'active' && (st === 'ready_for_pickup' || st === 'customer_notified')
  return (
    <>
      {can && (
        <div className="flex flex-wrap items-center gap-1.5">
          <button type="button" className={sm} aria-label={t.ariaFor(st === 'customer_notified' ? t.notifyAgain : t.notify, number)} onClick={() => setDialog('notify')}>{st === 'customer_notified' ? t.notifyAgain : t.notify}</button>
          <button type="button" className={smPrimary} aria-label={t.ariaFor(t.collect, number)} onClick={() => setDialog('collect')}>{t.collect}</button>
        </div>
      )}
      {live && dialog === 'notify' && <NotifyDialog {...live} />}
      {live && dialog === 'collect' && <CollectDialog {...live} />}
    </>
  )
}

/** The order's Pickup tab: where the order is, what was recorded, and the actions. */
function Panel({ p }: { p: PickupResponse }) {
  const { m, fmt } = useI18n()
  const t = m.pickup
  const k = p.pickup
  const st = k.fulfilmentStatus
  return (
    <div className="flex flex-col gap-3 pb-4">
      <div className={SEC}>
        <h2 className={H2}>{t.title}</h2>
        <Chip tone={FULFILMENT_TONE[st]}>{m.labels.fulfilmentStatus[st]}</Chip>
      </div>
      <div className="flex flex-col gap-2 px-4 text-[13px]">
        {st === 'not_ready' && <p className={MUTED}>{p.state === 'active' ? t.notReady : t.closedNote}</p>}
        {k.readyOn && <p>{t.readySince(fmt.date(k.readyOn))}</p>}
        {k.notifiedOn
          ? <p>{t.notifiedVia[k.notificationMethod ?? 'other'](fmt.date(k.notifiedOn))}</p>
          : st === 'ready_for_pickup' && <p className={MUTED}>{t.notNotified}</p>}
        {k.pickedUpOn && (
          <>
            <p className="font-medium">{t.pickedUp(fmt.date(k.pickedUpOn), k.collectedByName ?? m.common.dash)}</p>
            {k.completedBy && <p className={MUTED}>{t.recordedBy(k.completedBy)}</p>}
            {k.releaseOverride && <p role="status" className="rounded-[7px] bg-status-amber px-2.5 py-2 text-[12.5px] text-status-amber-fg">{t.overridden(k.releaseOverride.by, k.releaseOverride.reason)}</p>}
            <p className={MUTED}>{t.final}</p>
          </>
        )}
        {k.notes && <p className="whitespace-pre-wrap"><span className={MUTED}>{t.notesLabel}: </span>{k.notes}</p>}
        <PickupActions number={p.number} />
      </div>
    </div>
  )
}

export function PickupTab({ number }: { number: string }) {
  const query = usePickup(number)
  return <QueryBoundary query={query}>{(p) => <Panel p={p} />}</QueryBoundary>
}
