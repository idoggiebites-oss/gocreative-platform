// SQL for the pickup (M5, the fulfilment track): one row per order (decision 11), created by the first notify or collect.
// Writes are m5Write batches (db/payments.ts): the pickup row is created if missing and changed only while the order is
// still at the client's version, active and production_complete (re-asserted here and by migration 0006's triggers);
// recording the pickup also settles the order (closed when it is now picked up and paid).
import type { NotificationMethod } from '../../shared/enums'
import { NOW } from './orders'
import { m5Write } from './payments'

export type PickupRow = {
  order_id: number; ready_on: string; notified_on: string | null; notification_method: NotificationMethod | null; picked_up_on: string | null
  collected_by_name: string | null; completed_by_name: string | null; release_override_by: number | null; override_by_name: string | null
  release_override_reason: string | null; notes: string | null
}
export const getPickup = (db: D1Database, orderId: number) =>
  db.prepare(`SELECT p.order_id, p.ready_on, p.notified_on, p.notification_method, p.picked_up_on, p.collected_by_name, u.name AS completed_by_name,
      p.release_override_by, o.name AS override_by_name, p.release_override_reason, p.notes
    FROM pickups p LEFT JOIN users u ON u.id = p.completed_by LEFT JOIN users o ON o.id = p.release_override_by WHERE p.order_id = ?`)
    .bind(orderId).first<PickupRow>()

/** When the order last reached production_complete (UTC timestamp from the activity log), or null. */
export async function completedAt(db: D1Database, orderId: number) {
  const r = await db.prepare(`SELECT MAX(at) AS at FROM activity_log WHERE entity_type = 'order' AND entity_id = ?
      AND json_extract(after, '$.production_status') = 'production_complete'`).bind(orderId).first<{ at: string | null }>()
  return r?.at ?? null
}

type Guarded = { orderId: number; version: number; actorId: number; readyOn: string }
// The order is still what the route checked: same version, active, production complete. Binds (orderId, version).
const READY = `EXISTS (SELECT 1 FROM orders g WHERE g.id = ? AND g.version = ? AND g.state = 'active' AND g.production_status = 'production_complete')`
const ensurePickup = (db: D1Database, p: Guarded) =>
  db.prepare(`INSERT INTO pickups (order_id, ready_on) SELECT ?, ? WHERE ${READY} AND NOT EXISTS (SELECT 1 FROM pickups WHERE order_id = ?)`)
    .bind(p.orderId, p.readyOn, p.orderId, p.version, p.orderId)

/** Records (or replaces) the customer notification while the order is not picked up. Returns false on a stale version. */
export async function notifyPickup(db: D1Database, p: Guarded & { notifiedOn: string; method: NotificationMethod; notes: string | null }) {
  const { applied } = await m5Write(db, {
    ...p,
    data: [
      ensurePickup(db, p),
      db.prepare(`UPDATE pickups SET notified_on = ?, notification_method = ?, notes = COALESCE(?, notes), updated_at = ${NOW}
          WHERE order_id = ? AND picked_up_on IS NULL AND ${READY}`).bind(p.notifiedOn, p.method, p.notes, p.orderId, p.orderId, p.version),
    ],
    log: { action: 'pickup_notified', after: { notified_on: p.notifiedOn, notification_method: p.method } },
  })
  return applied
}

/**
 * Records the pickup (final). The route checked the release with checkPickupRelease; the pickups_release_update trigger
 * re-checks it (payment_required) and the owner (release_override_invalid), and pickups_override_log_update writes the
 * override's audit row. Returns false on a stale version or an order no longer ready.
 */
export async function collectPickup(db: D1Database, p: Guarded & {
  pickedUpOn: string; collectedByName: string; notes: string | null; override: { by: number; reason: string } | null
}) {
  const { applied } = await m5Write(db, {
    ...p, settle: 'picked_up',
    data: [
      ensurePickup(db, p),
      db.prepare(`UPDATE pickups SET picked_up_on = ?, collected_by_name = ?, completed_by = ?, release_override_by = ?, release_override_reason = ?,
          notes = COALESCE(?, notes), updated_at = ${NOW} WHERE order_id = ? AND picked_up_on IS NULL AND ${READY}`)
        .bind(p.pickedUpOn, p.collectedByName, p.actorId, p.override?.by ?? null, p.override?.reason ?? null, p.notes, p.orderId, p.orderId, p.version),
    ],
    log: { action: 'pickup_collected', after: { picked_up_on: p.pickedUpOn, collected_by_name: p.collectedByName, override: p.override !== null } },
  })
  return applied
}
