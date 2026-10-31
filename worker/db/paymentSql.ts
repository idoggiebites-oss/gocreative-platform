// M0 design statements for design/sql/payments.sql; M5 (migration 0006, worker/db/payments.ts) runs COLLECT_CHECK_SQL verbatim.

// Collect a check: one batch, these three statements in this order, adjacent.
// Bind [0] (amountReceivedCents, collectedAt, collectedBy, checkCollectionId),
//      [1] (paidOn, recordedBy, checkCollectionId), [2] (checkCollectionId).
// [0] is guarded by status, so a retry or a competing collect changes nothing. [1] inserts only when [0]
// changed a row (changes() still refers to [0]). [2] logs only for a payment that exists AND was just
// inserted by [1] (changes() now refers to [1]), so a retry never logs twice. A failing payment insert
// (e.g. amount 0) rolls back [0]: the check stays uncollected. A retry with a different amount changes
// nothing; the route compares the stored row and answers 409 if it differs.
export const COLLECT_CHECK_SQL = [
  `UPDATE check_collections SET status = 'collected', amount_received_cents = ?, collected_at = ?, collected_by = ?
   WHERE id = ? AND status IN ('awaiting_payment', 'ready_for_collection')`,
  `INSERT INTO payments (order_id, amount_cents, method, paid_on, recorded_by, check_collection_id)
   SELECT order_id, amount_received_cents, 'check', ?, ?, id FROM check_collections WHERE id = ? AND changes() = 1`,
  `INSERT INTO activity_log (actor_kind, actor_id, entity_type, entity_id, action, after)
   SELECT 'user', recorded_by, 'order', order_id, 'check_collected',
     json_object('payment_id', id, 'check_collection_id', check_collection_id, 'amount_cents', amount_cents)
   FROM payments WHERE check_collection_id = ? AND changes() = 1`,
] as const

// Manual payment. Bind (orderId, amountCents, method, paidOn, notes, recordedBy, requestId, orderId, expectedVersion).
// M5: inserts only while the order is still at the version the client saw and not cancelled (a stale write inserts
// nothing), returning the new id. A request_id that already exists aborts (payment_request_id_exists, migration 0006's
// REPLACE guard): the route loads the stored payment and calls matchRetry (domain/payments.ts): identical payload ->
// return the stored payment; different payload -> 409 request_id_conflict.
export const RECORD_PAYMENT_SQL = `INSERT INTO payments (order_id, amount_cents, method, paid_on, notes, recorded_by, request_id)
  SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM orders g WHERE g.id = ? AND g.version = ? AND g.state <> 'cancelled') RETURNING id`
