// M0 design statements; the M4 start/cancel routes run them verbatim against the slot migration's schema.
// The start re-asserts the full five-item gate (orders.ts GATE_OK) in its WHERE, as applyProductionChange does,
// so a stale 'ready' (readiness changed since it was derived) can never start (M0 review, carried to M3).
import { GATE_OK } from './orders'

// Start: one batch, [UPDATE, log]. Bind [0] (slot, overrideBy|null, overrideReason|null, orderId) and
// [1] (actorId, orderId). A losing start either matches no row (changes() = 0, nothing logged) or
// hits one_job_per_slot / the slot-2 triggers and rolls the whole batch back. The route maps both to 409.
export const START_PRODUCTION_SQL = [
  `UPDATE orders SET production_status = 'in_production', production_slot = ?, production_override_by = ?, production_override_reason = ?
   WHERE id = ? AND state = 'active' AND production_status = 'ready' AND production_slot IS NULL AND ${GATE_OK}`,
  `INSERT INTO activity_log (actor_kind, actor_id, entity_type, entity_id, action, after)
   SELECT 'user', ?, 'order', id, 'production_started', json_object('slot', production_slot) FROM orders WHERE id = ? AND changes() = 1`,
] as const

// Cancel: releases the slot in the same UPDATE. A running job drops back to 'ready'; reopening the order
// must re-derive readiness (and write the awaiting_* status) before any start. Bind (orderId).
export const CANCEL_ORDER_SQL = `UPDATE orders SET state = 'cancelled',
  production_status = CASE WHEN production_status = 'in_production' THEN 'ready' ELSE production_status END,
  production_slot = NULL, production_override_by = NULL, production_override_reason = NULL
  WHERE id = ? AND state = 'active'`
