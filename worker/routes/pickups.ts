// The pickup (M5, the fulfilment track). HTTP, auth and validation only: the release rule is domain/fulfilment.ts
// checkPickupRelease, the SQL is worker/db/pickups.ts. Picked up = fulfilled, paid or not (decision 6); recording it
// closes the order in the same write when it is already paid.
import { Hono } from 'hono'
import type { Context } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../auth'
import type { OrderWriteResponse, PickupRecord, PickupResponse } from '../../shared/api'
import { NOTIFICATION_METHODS } from '../../shared/enums'
import { businessToday } from '../../shared/businessDate'
import { checkPickupRelease, fulfilmentStatus } from '../domain/fulfilment'
import { getOrderByNumber, orderState } from '../db/orders'
import * as db from '../db/pickups'
import { businessDate } from './orderWrites'
import { bad, number } from './orders'
import { conflict, dbErrors, loadBalance, notFound, refuse, today, withOrder } from './payments'

type C = Context<AppEnv>
type Order = NonNullable<Awaited<ReturnType<typeof getOrderByNumber>>>
const expectedVersion = z.number().int().min(0)
const optText = (max: number) => z.string().trim().max(max).nullish().transform((v) => v || null)
const notifyBody = z.object({ notifiedOn: businessDate.optional(), method: z.enum(NOTIFICATION_METHODS), notes: optText(2000), expectedVersion })
const collectBody = z.object({
  pickedUpOn: businessDate.optional(), collectedByName: z.string().trim().min(1).max(200), notes: optText(2000),
  override: z.boolean().optional(), reason: z.string().trim().max(500).optional(), expectedVersion,
})

// Unknown agreed total (no accepted quote; production_complete normally implies one): treated as money owed.
const owed = (outstandingCents: number | null) => outstandingCents ?? 1

/** The day the pickup became ready: the stored one, else the day production completed (shop time), else today. */
async function readyOn(d: D1Database, o: Order, pickup: db.PickupRow | null) {
  if (pickup) return pickup.ready_on
  const at = await db.completedAt(d, o.id)
  return at ? businessToday(new Date(at)) : today()
}

/** Refuses a pickup write on an order that isn't active, finished and still waiting for its customer. */
async function pickupGate(c: C, o: Order) {
  if (o.state !== 'active') return refuse(c, 'order_not_active', 'Order is cancelled or closed')
  if (o.production_status !== 'production_complete') return refuse(c, 'pickup_not_ready', 'Production is not complete')
  const pickup = await db.getPickup(c.env.DB, o.id)
  if (pickup?.picked_up_on) return refuse(c, 'pickup_recorded', 'This order was already picked up')
  return { pickup: pickup ?? null }
}
const written = async (c: C, orderId: number) => c.json<OrderWriteResponse>((await orderState(c.env.DB, { id: orderId }))!)

export function pickupRoutes() {
  return new Hono<AppEnv>()
    .onError(dbErrors)

    .get('/orders/:number/pickup', async (c) => {
      const n = number.safeParse(c.req.param('number'))
      if (!n.success) return bad(c, n.error)
      const o = await getOrderByNumber(c.env.DB, n.data)
      if (!o) return notFound(c, 'Order')
      const [p, bal] = await Promise.all([db.getPickup(c.env.DB, o.id), loadBalance(c.env.DB, o.id)])
      const complete = o.production_status === 'production_complete'
      const pickup: PickupRecord = {
        fulfilmentStatus: fulfilmentStatus(o.production_status, p && { notifiedAt: p.notified_on, pickedUpAt: p.picked_up_on }),
        readyOn: complete ? await readyOn(c.env.DB, o, p) : null,
        notifiedOn: p?.notified_on ?? null, notificationMethod: p?.notification_method ?? null, pickedUpOn: p?.picked_up_on ?? null,
        collectedByName: p?.collected_by_name ?? null, completedBy: p?.completed_by_name ?? null,
        releaseOverride: p?.release_override_by ? { by: p.override_by_name ?? '', reason: p.release_override_reason ?? '' } : null,
        notes: p?.notes ?? null,
      }
      const releaseNeedsOverride = complete && !p?.picked_up_on
        && !checkPickupRelease({ paymentTerms: o.payment_terms, outstandingCents: owed(bal.outstandingCents), override: false, role: 'owner' }).ok
      return c.json<PickupResponse>({ number: o.number, version: o.version, state: o.state, paymentTerms: o.payment_terms, pickup, balance: bal, releaseNeedsOverride })
    })

    .post('/orders/:number/pickup/notify', withOrder(notifyBody, async (c, o, b) => {
      const gate = await pickupGate(c, o)
      if (gate instanceof Response) return gate
      const applied = await db.notifyPickup(c.env.DB, {
        orderId: o.id, version: b.expectedVersion, actorId: c.get('user').id, readyOn: await readyOn(c.env.DB, o, gate.pickup),
        notifiedOn: b.notifiedOn ?? today(), method: b.method, notes: b.notes,
      })
      return applied ? written(c, o.id) : conflict(c)
    }))

    // Pay-at-pickup orders that still owe money need an owner's override with a reason; pay-after-pickup orders
    // (districts) are released unpaid. migration 0006's triggers hold the same rule and write the override's audit row.
    .post('/orders/:number/pickup/collect', withOrder(collectBody, async (c, o, b) => {
      const gate = await pickupGate(c, o)
      if (gate instanceof Response) return gate
      const user = c.get('user')
      const bal = await loadBalance(c.env.DB, o.id)
      const release = checkPickupRelease({ paymentTerms: o.payment_terms, outstandingCents: owed(bal.outstandingCents), override: b.override === true, role: user.role, reason: b.reason })
      if (!release.ok) {
        if (release.error === 'override_requires_owner') return refuse(c, 'override_requires_owner', 'Only an owner can release an unpaid order', 403)
        if (release.error === 'override_requires_reason') return refuse(c, 'override_requires_reason', 'Give a reason for releasing an unpaid order', 400)
        return refuse(c, 'payment_required', 'Payment is due at pickup; an owner can override with a reason')
      }
      const applied = await db.collectPickup(c.env.DB, {
        orderId: o.id, version: b.expectedVersion, actorId: user.id, readyOn: await readyOn(c.env.DB, o, gate.pickup),
        pickedUpOn: b.pickedUpOn ?? today(), collectedByName: b.collectedByName, notes: b.notes,
        override: release.overrideUsed ? { by: user.id, reason: b.reason!.trim() } : null,
      })
      return applied ? written(c, o.id) : conflict(c)
    }))
}
