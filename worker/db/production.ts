// SQL for the production queue (M4). production_status itself is written only by orders.ts applyProductionChange and
// rederive (AGENTS.md); this file reads the queue, writes units completed (an orderWrite batch) and the ready-queue order.
// Values are bound; the interpolated fragments are constants from this file.
import { METHODS } from '../../shared/enums'
import type { Method, ProductionStatus } from '../../shared/enums'
import type { ProductionJob, ProductionResponse } from '../../shared/api'
import { orderWriteResults, PRE_PRODUCTION } from './orders'

const READY = `orders.state = 'active' AND orders.production_status = 'ready'`
/** The Ready to start order: manual position (unplaced last), then due date (none last), then oldest first. */
const READY_ORDER = `orders.queue_position IS NULL, orders.queue_position, orders.due_date IS NULL, orders.due_date, orders.created_at, orders.id`
const PRODUCT = `order_items i WHERE i.order_id = orders.id AND i.kind = 'product'`
const NOTE = `notes n WHERE n.entity_type = 'order' AND n.entity_id = orders.id`

type JobRow = {
  number: string; customer_name: string; title: string; production_status: ProductionStatus; due_date: string | null; version: number
  first_product: string | null; product_lines: number; total_qty: number; methods: string | null; units_completed: number
  notes_count: number; latest_note: string | null; latest_note_at: string | null; queue_position: number | null
  pre_production_status: ProductionStatus; started_at: string | null
  production_slot: 1 | 2 | null; override_by: string | null; production_override_reason: string | null
}
const toJob = (r: JobRow): ProductionJob => ({
  number: r.number, customerName: r.customer_name, title: r.title, productionStatus: r.production_status, dueDate: r.due_date, version: r.version,
  product: { first: r.first_product, lines: r.product_lines }, totalQuantity: r.total_qty,
  methods: ((r.methods ?? '').split(',').filter(Boolean) as Method[]).sort((a, b) => METHODS.indexOf(a) - METHODS.indexOf(b)),
  unitsCompleted: r.units_completed, notesCount: r.notes_count,
  latestNote: r.latest_note === null ? null : { body: r.latest_note, createdAt: r.latest_note_at! },
  preProductionStatus: r.pre_production_status, startedAt: r.started_at,
  queuePosition: r.queue_position, slot: r.production_slot,
  override: r.production_slot === 2 ? { by: r.override_by ?? '', reason: r.production_override_reason ?? '' } : null,
})

/** The Production page: running jobs by slot, the ready queue in order, and the 20 most recently changed finished jobs. */
export async function listProduction(db: D1Database): Promise<ProductionResponse> {
  const { results } = await db.prepare(`SELECT orders.number, c.name AS customer_name, orders.title, orders.production_status, orders.due_date, orders.version,
      (SELECT i.product FROM ${PRODUCT} ORDER BY i.id LIMIT 1) AS first_product, (SELECT COUNT(*) FROM ${PRODUCT}) AS product_lines,
      (SELECT COALESCE(SUM(i.quantity), 0) FROM ${PRODUCT}) AS total_qty, (SELECT group_concat(DISTINCT i.method) FROM ${PRODUCT}) AS methods,
      orders.units_completed, (SELECT COUNT(*) FROM ${NOTE}) AS notes_count,
      (SELECT n.body FROM ${NOTE} ORDER BY n.id DESC LIMIT 1) AS latest_note, (SELECT n.created_at FROM ${NOTE} ORDER BY n.id DESC LIMIT 1) AS latest_note_at,
      ${PRE_PRODUCTION} AS pre_production_status,
      (SELECT a.at FROM activity_log a WHERE a.entity_type = 'order' AND a.entity_id = orders.id AND a.action = 'production_started' ORDER BY a.id DESC LIMIT 1) AS started_at,
      orders.queue_position, orders.production_slot, u.name AS override_by, orders.production_override_reason, orders.updated_at
    FROM orders JOIN customers c ON c.id = orders.customer_id LEFT JOIN users u ON u.id = orders.production_override_by
    WHERE orders.state = 'active' AND orders.production_status IN ('ready','in_production','quality_control','production_complete')
    ORDER BY orders.production_slot, ${READY_ORDER}`).all<JobRow & { updated_at: string }>()
  const of = (...s: ProductionStatus[]) => results.filter((r) => s.includes(r.production_status))
  return {
    current: of('in_production').map(toJob),
    readyToStart: of('ready').map(toJob),
    completed: of('quality_control', 'production_complete').sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, 20).map(toJob),
  }
}

/** Who holds each slot now (chooseSlot's `occupied`, and the running job a production_busy names). */
export async function runningJobs(db: D1Database) {
  const { results } = await db.prepare('SELECT production_slot AS slot, number FROM orders WHERE production_slot IS NOT NULL ORDER BY production_slot')
    .all<{ slot: 1 | 2; number: string }>()
  return results
}

/** The order's total product quantity: what units completed is measured against. */
export const totalQuantity = async (db: D1Database, orderId: number) =>
  (await db.prepare(`SELECT COALESCE(SUM(quantity), 0) AS n FROM order_items WHERE order_id = ? AND kind = 'product'`).bind(orderId).first<{ n: number }>())!.n

/**
 * Units completed, corrected up or down. Re-asserted in the UPDATE: the job is in_production or quality_control and the
 * count is within the order's product quantity. Returns null on a stale version or when either no longer holds.
 */
export async function setUnitsCompleted(db: D1Database, p: { orderId: number; version: number; actorId: number; from: number; to: number }) {
  const { state } = await orderWriteResults(db, {
    ...p, action: 'units_completed_changed', set: [['units_completed = ?', p.to]],
    where: [`orders.production_status IN ('in_production','quality_control') AND ? <= (SELECT COALESCE(SUM(i.quantity), 0) FROM ${PRODUCT})`, p.to],
    before: { units_completed: p.from }, after: { units_completed: p.to },
  })
  return state
}

/** The Ready to start list's order numbers, in queue order. */
export async function readyQueue(db: D1Database) {
  const { results } = await db.prepare(`SELECT number FROM orders WHERE ${READY} ORDER BY ${READY_ORDER}`).all<{ number: string }>()
  return results.map((r) => r.number)
}

// The queue is still exactly `seen` (bound as a JSON array at ?1): same length as the ready list, and every number at
// the same rank. Evaluated before the UPDATE writes anything (it is the log INSERT's condition; the UPDATE runs only if
// that inserted its row).
const QUEUE_IS = `json_array_length(?1) = (SELECT COUNT(*) FROM orders WHERE ${READY})
  AND json_array_length(?1) = (SELECT COUNT(*) FROM (SELECT orders.number, ROW_NUMBER() OVER (ORDER BY ${READY_ORDER}) - 1 AS rk FROM orders WHERE ${READY}) cur
    JOIN json_each(?1) j ON j.value = cur.number AND j.key = cur.rk)`

/**
 * Writes queue_position 1..n in `next` order, in one batch with one activity row, only if the queue is still `seen`
 * (the caller checked next is a permutation of seen). Returns false and writes nothing when someone else changed it.
 * Not an order write: no version bump, so reordering never invalidates an open order page.
 */
export async function reorderQueue(db: D1Database, p: { actorId: number; seen: string[]; next: string[] }) {
  const [log] = await db.batch([
    db.prepare(`INSERT INTO activity_log (actor_kind, actor_id, entity_type, entity_id, action, before, after)
        SELECT 'user', ?2, 'production_queue', 0, 'queue_reordered', json_object('order_numbers', json(?1)), json_object('order_numbers', json(?3)) WHERE ${QUEUE_IS}`)
      .bind(JSON.stringify(p.seen), p.actorId, JSON.stringify(p.next)),
    db.prepare(`UPDATE orders SET queue_position = (SELECT j.key + 1 FROM json_each(?) j WHERE j.value = orders.number) WHERE ${READY} AND changes() > 0`)
      .bind(JSON.stringify(p.next)),
  ])
  return (log?.meta.changes ?? 0) > 0
}
