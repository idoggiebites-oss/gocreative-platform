-- M5: pickups (the fulfilment track), payments and school-district check collections (the financial track),
-- PHASE2_PLAN §4.2 and §4.4. Additive only: orders is not rebuilt. Money is integer cents (typeof CHECKs); business
-- dates are YYYY-MM-DD in shop time, and `date(x) IS x` refuses an impossible date such as 2026-02-30 (as in 0004).
-- check_collections and payments are design/sql/payments.sql's tables (its columns, CHECKs and two triggers verbatim)
-- plus the void columns, the status dates and the guards below. Every identity/immutability trigger is an unconditional
-- BEFORE UPDATE (an `UPDATE OF col` trigger misses rowid-alias updates), and every UNIQUE column has a BEFORE INSERT
-- refusal, because INSERT OR REPLACE / UPDATE OR REPLACE delete the conflicting row without firing delete triggers.
--
-- The agreed total is the highest-version ACCEPTED quote's total_cents (none: unknown, never paid). "Paid" below is
-- that total covered by the sum of the order's non-voided payments: the SQL twin of domain/payments.ts balance().

-- Known when the customer and the shop agree a date (optional; shown on the Payments page as the due date).
ALTER TABLE orders ADD COLUMN payment_due_on TEXT CHECK (payment_due_on IS NULL OR date(payment_due_on) IS payment_due_on);

-- ---- pickups: one per order (decision 11), created when staff first notify or record the pickup ----
CREATE TABLE pickups (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL UNIQUE REFERENCES orders (id),
  -- When production completed, in shop time (the day the order became ready for pickup).
  ready_on TEXT NOT NULL CHECK (date(ready_on) IS ready_on),
  notified_on TEXT CHECK (notified_on IS NULL OR date(notified_on) IS notified_on),
  notification_method TEXT CHECK (notification_method IS NULL OR notification_method IN ('phone','email','text','in_person','other')),
  picked_up_on TEXT CHECK (picked_up_on IS NULL OR date(picked_up_on) IS picked_up_on),
  collected_by_name TEXT CHECK (collected_by_name IS NULL OR (length(trim(collected_by_name)) BETWEEN 1 AND 200 AND length(collected_by_name) <= 200)),
  completed_by INTEGER REFERENCES users (id),
  -- Owner override releasing an unpaid due-at-pickup order (decision 10): both or neither, only on a pickup.
  release_override_by INTEGER REFERENCES users (id),
  release_override_reason TEXT,
  notes TEXT CHECK (notes IS NULL OR length(notes) <= 2000),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK ((notified_on IS NULL) = (notification_method IS NULL)),
  CHECK ((picked_up_on IS NULL) = (collected_by_name IS NULL) AND (picked_up_on IS NULL) = (completed_by IS NULL)),
  CHECK ((release_override_by IS NULL) = (release_override_reason IS NULL)),
  CHECK (release_override_reason IS NULL OR length(trim(release_override_reason)) BETWEEN 1 AND 500),
  CHECK (release_override_by IS NULL OR picked_up_on IS NOT NULL)
);

-- INSERT OR REPLACE would delete an existing pickup (a recorded release, its override) without any delete trigger.
CREATE TRIGGER pickups_no_replace BEFORE INSERT ON pickups
WHEN EXISTS (SELECT 1 FROM pickups WHERE id = NEW.id OR order_id = NEW.order_id)
BEGIN SELECT RAISE(ABORT, 'pickup_exists'); END;
-- Only an active order whose production is complete has a pickup to notify or record (domain fulfilmentStatus).
CREATE TRIGGER pickups_need_complete BEFORE INSERT ON pickups
WHEN (SELECT production_status = 'production_complete' AND state = 'active' FROM orders WHERE id = NEW.order_id) IS NOT 1
BEGIN SELECT RAISE(ABORT, 'pickup_not_ready'); END;
-- Identity fixed (every alias of id, the order, the ready date); a recorded pickup is final.
CREATE TRIGGER pickups_update BEFORE UPDATE ON pickups
BEGIN
  SELECT RAISE(ABORT, 'pickup_fixed')
  WHERE NEW.id IS NOT OLD.id OR NEW.order_id IS NOT OLD.order_id OR NEW.ready_on IS NOT OLD.ready_on OR NEW.created_at IS NOT OLD.created_at;
  SELECT RAISE(ABORT, 'pickup_recorded') WHERE OLD.picked_up_on IS NOT NULL;
  SELECT RAISE(ABORT, 'pickup_not_ready')
  WHERE (SELECT production_status = 'production_complete' AND state = 'active' FROM orders WHERE id = NEW.order_id) IS NOT 1;
END;
CREATE TRIGGER pickups_no_delete BEFORE DELETE ON pickups
BEGIN SELECT RAISE(ABORT, 'pickups are never deleted'); END;

-- domain/fulfilment.ts checkPickupRelease, held by the database: an unpaid due-at-pickup order is released only with an
-- override, and the overrider is an active owner. Fires on INSERT and UPDATE, so no SQL path can skip it.
CREATE TRIGGER pickups_release_insert BEFORE INSERT ON pickups
WHEN NEW.picked_up_on IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'payment_required')
  WHERE NEW.release_override_by IS NULL AND (SELECT payment_terms FROM orders WHERE id = NEW.order_id) = 'due_at_pickup'
    AND NOT COALESCE((SELECT (SELECT COALESCE(SUM(p.amount_cents), 0) FROM payments p WHERE p.order_id = NEW.order_id AND p.voided_at IS NULL) >= q.total_cents
      FROM quotes q WHERE q.order_id = NEW.order_id AND q.status = 'accepted' ORDER BY q.version DESC LIMIT 1), 0);
  SELECT RAISE(ABORT, 'release_override_invalid')
  WHERE NEW.release_override_by IS NOT NULL AND NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.release_override_by AND active = 1 AND role = 'owner');
END;
CREATE TRIGGER pickups_release_update BEFORE UPDATE ON pickups
WHEN NEW.picked_up_on IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'payment_required')
  WHERE NEW.release_override_by IS NULL AND (SELECT payment_terms FROM orders WHERE id = NEW.order_id) = 'due_at_pickup'
    AND NOT COALESCE((SELECT (SELECT COALESCE(SUM(p.amount_cents), 0) FROM payments p WHERE p.order_id = NEW.order_id AND p.voided_at IS NULL) >= q.total_cents
      FROM quotes q WHERE q.order_id = NEW.order_id AND q.status = 'accepted' ORDER BY q.version DESC LIMIT 1), 0);
  SELECT RAISE(ABORT, 'release_override_invalid')
  WHERE NEW.release_override_by IS NOT NULL AND NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.release_override_by AND active = 1 AND role = 'owner');
END;
-- The audit row is written by the database, so an override can't happen without one (a recorded pickup is final, so
-- each fires at most once per order).
CREATE TRIGGER pickups_override_log_insert AFTER INSERT ON pickups
WHEN NEW.release_override_by IS NOT NULL
BEGIN
  INSERT INTO activity_log (actor_kind, actor_id, entity_type, entity_id, action, after)
  VALUES ('user', NEW.release_override_by, 'order', NEW.order_id, 'pickup_release_override', json_object('reason', NEW.release_override_reason));
END;
CREATE TRIGGER pickups_override_log_update AFTER UPDATE ON pickups
WHEN NEW.release_override_by IS NOT NULL AND OLD.release_override_by IS NULL
BEGIN
  INSERT INTO activity_log (actor_kind, actor_id, entity_type, entity_id, action, after)
  VALUES ('user', NEW.release_override_by, 'order', NEW.order_id, 'pickup_release_override', json_object('reason', NEW.release_override_reason));
END;

-- ---- check collections (design/sql/payments.sql, plus who/when created and the status-date CHECKs) ----
CREATE TABLE check_collections (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders (id) ON DELETE RESTRICT,
  expected_cents INTEGER NOT NULL CHECK (typeof(expected_cents) = 'integer' AND expected_cents > 0),
  -- Positivity is enforced on the payment the collect creates, in the same batch.
  amount_received_cents INTEGER CHECK (amount_received_cents IS NULL OR typeof(amount_received_cents) = 'integer'),
  check_number TEXT CHECK (check_number IS NULL OR length(check_number) <= 50),
  status TEXT NOT NULL DEFAULT 'awaiting_payment' CHECK (status IN ('awaiting_payment','ready_for_collection','collected','deposited','cleared')),
  available_on TEXT CHECK (available_on IS NULL OR date(available_on) IS available_on), -- business date, shop time
  collected_at TEXT,
  collected_by INTEGER REFERENCES users (id) ON DELETE RESTRICT,
  deposited_on TEXT CHECK (deposited_on IS NULL OR date(deposited_on) IS deposited_on),
  cleared_on TEXT CHECK (cleared_on IS NULL OR date(cleared_on) IS cleared_on),
  notes TEXT CHECK (notes IS NULL OR length(notes) <= 2000),
  created_by INTEGER REFERENCES users (id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  -- Each status carries its own facts: collected (who, when, how much), deposited (when), cleared (when).
  CHECK ((status IN ('collected','deposited','cleared')) = (amount_received_cents IS NOT NULL AND collected_at IS NOT NULL AND collected_by IS NOT NULL)),
  CHECK ((status IN ('collected','deposited','cleared')) OR (amount_received_cents IS NULL AND collected_at IS NULL AND collected_by IS NULL)),
  CHECK ((status IN ('deposited','cleared')) = (deposited_on IS NOT NULL)),
  CHECK ((status = 'cleared') = (cleared_on IS NOT NULL))
);
CREATE INDEX idx_check_collections_order ON check_collections (order_id);
CREATE INDEX idx_check_collections_status ON check_collections (status);

CREATE TRIGGER check_collections_no_replace BEFORE INSERT ON check_collections
WHEN EXISTS (SELECT 1 FROM check_collections WHERE id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'check_exists'); END;
-- A new collection starts at the beginning (domain checkCheckTransition is the only way forward).
CREATE TRIGGER check_collections_insert_start BEFORE INSERT ON check_collections
WHEN NEW.status NOT IN ('awaiting_payment','ready_for_collection')
BEGIN SELECT RAISE(ABORT, 'invalid_check_transition'); END;
CREATE TRIGGER check_collections_update BEFORE UPDATE ON check_collections
BEGIN
  SELECT RAISE(ABORT, 'check_fixed')
  WHERE NEW.id IS NOT OLD.id OR NEW.order_id IS NOT OLD.order_id OR NEW.expected_cents IS NOT OLD.expected_cents
     OR NEW.created_by IS NOT OLD.created_by OR NEW.created_at IS NOT OLD.created_at;
  -- checkCheckTransition: awaiting -> ready / collected, ready -> collected, collected -> deposited, deposited -> cleared.
  SELECT RAISE(ABORT, 'invalid_check_transition')
  WHERE NEW.status IS NOT OLD.status AND NOT (
    (OLD.status = 'awaiting_payment' AND NEW.status IN ('ready_for_collection','collected'))
    OR (OLD.status = 'ready_for_collection' AND NEW.status = 'collected')
    OR (OLD.status = 'collected' AND NEW.status = 'deposited')
    OR (OLD.status = 'deposited' AND NEW.status = 'cleared'));
  -- What was collected (and the payment made from it) never changes afterwards; nor do the deposit and clearance dates.
  SELECT RAISE(ABORT, 'check_fixed')
  WHERE OLD.status IN ('collected','deposited','cleared') AND (NEW.amount_received_cents IS NOT OLD.amount_received_cents
    OR NEW.collected_at IS NOT OLD.collected_at OR NEW.collected_by IS NOT OLD.collected_by OR NEW.check_number IS NOT OLD.check_number
    OR NEW.available_on IS NOT OLD.available_on);
  SELECT RAISE(ABORT, 'check_fixed')
  WHERE (OLD.status IN ('deposited','cleared') AND NEW.deposited_on IS NOT OLD.deposited_on) OR (OLD.status = 'cleared' AND NEW.cleared_on IS NOT OLD.cleared_on);
END;
CREATE TRIGGER check_collections_no_delete BEFORE DELETE ON check_collections
BEGIN SELECT RAISE(ABORT, 'check collections are never deleted'); END;

-- ---- payments (design/sql/payments.sql, plus the void columns) ----
CREATE TABLE payments (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders (id) ON DELETE RESTRICT,
  amount_cents INTEGER NOT NULL CHECK (typeof(amount_cents) = 'integer' AND amount_cents > 0),
  method TEXT NOT NULL CHECK (method IN ('check','ach','cash','card','other')),
  paid_on TEXT NOT NULL CHECK (date(paid_on) IS paid_on), -- business date, shop time
  notes TEXT CHECK (notes IS NULL OR length(notes) <= 2000),
  recorded_by INTEGER NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  -- Client-generated per form submission; a resubmitted form hits UNIQUE.
  request_id TEXT UNIQUE CHECK (request_id IS NULL OR length(request_id) <= 100),
  -- A check collection produces at most one payment.
  check_collection_id INTEGER UNIQUE REFERENCES check_collections (id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  -- A correction is a void: the row, its request_id and its check link stay; a voided payment doesn't count.
  voided_at TEXT,
  voided_by INTEGER REFERENCES users (id),
  void_reason TEXT,
  -- Every payment is de-duplicated by one of the two keys.
  CHECK (check_collection_id IS NOT NULL OR (request_id IS NOT NULL AND length(trim(request_id)) > 0)),
  CHECK ((voided_at IS NULL) = (voided_by IS NULL) AND (voided_at IS NULL) = (void_reason IS NULL)),
  CHECK (void_reason IS NULL OR length(trim(void_reason)) BETWEEN 1 AND 500)
);
CREATE INDEX idx_payments_order ON payments (order_id);
CREATE TRIGGER payments_check_link_immutable BEFORE UPDATE OF check_collection_id ON payments
WHEN NEW.check_collection_id IS NOT OLD.check_collection_id
BEGIN
  SELECT RAISE(ABORT, 'payment_check_link_immutable');
END;
CREATE TRIGGER payments_linked_no_delete BEFORE DELETE ON payments
WHEN OLD.check_collection_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'payment_linked_to_check');
END;
-- Corrections are voids (PHASE2_PLAN, carried forward to M5): no payment is ever deleted.
CREATE TRIGGER payments_no_delete BEFORE DELETE ON payments
WHEN OLD.check_collection_id IS NULL
BEGIN SELECT RAISE(ABORT, 'payments are never deleted'); END;
-- REPLACE on id, request_id or check_collection_id would delete the stored payment silently. The request_id message
-- is what the route maps to a retry (matchRetry); the check one can't happen through COLLECT_CHECK_SQL.
CREATE TRIGGER payments_no_replace BEFORE INSERT ON payments
BEGIN
  -- A payment is born unvoided (a void is the guarded, owner-checked, audited UPDATE below), and never on a cancelled
  -- order, which also refuses collecting a check whose order was cancelled: the whole collect batch rolls back
  -- (Codex review of 5fba130).
  SELECT RAISE(ABORT, 'payment_void_on_insert') WHERE NEW.voided_at IS NOT NULL OR NEW.voided_by IS NOT NULL OR NEW.void_reason IS NOT NULL;
  SELECT RAISE(ABORT, 'payment_order_cancelled') WHERE (SELECT state FROM orders WHERE id = NEW.order_id) IS 'cancelled';
  SELECT RAISE(ABORT, 'payment_exists') WHERE EXISTS (SELECT 1 FROM payments WHERE id = NEW.id);
  SELECT RAISE(ABORT, 'payment_request_id_exists') WHERE NEW.request_id IS NOT NULL AND EXISTS (SELECT 1 FROM payments WHERE request_id = NEW.request_id);
  SELECT RAISE(ABORT, 'payment_check_exists')
  WHERE NEW.check_collection_id IS NOT NULL AND EXISTS (SELECT 1 FROM payments WHERE check_collection_id = NEW.check_collection_id);
END;
-- A payment never changes except to be voided once, by an active owner; a void is never undone.
CREATE TRIGGER payments_update BEFORE UPDATE ON payments
BEGIN
  SELECT RAISE(ABORT, 'payment_immutable')
  WHERE NEW.id IS NOT OLD.id OR NEW.order_id IS NOT OLD.order_id OR NEW.amount_cents IS NOT OLD.amount_cents OR NEW.method IS NOT OLD.method
     OR NEW.paid_on IS NOT OLD.paid_on OR NEW.notes IS NOT OLD.notes OR NEW.recorded_by IS NOT OLD.recorded_by
     OR NEW.request_id IS NOT OLD.request_id OR NEW.check_collection_id IS NOT OLD.check_collection_id OR NEW.created_at IS NOT OLD.created_at;
  SELECT RAISE(ABORT, 'payment_voided') WHERE OLD.voided_at IS NOT NULL;
  SELECT RAISE(ABORT, 'void_requires_owner')
  WHERE NEW.voided_by IS NOT NULL AND NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.voided_by AND active = 1 AND role = 'owner');
END;
-- The void's audit row is written by the database, so a payment can't be voided without one.
CREATE TRIGGER payments_void_log AFTER UPDATE ON payments
WHEN NEW.voided_at IS NOT NULL AND OLD.voided_at IS NULL
BEGIN
  INSERT INTO activity_log (actor_kind, actor_id, entity_type, entity_id, action, after)
  VALUES ('user', NEW.voided_by, 'order', NEW.order_id, 'payment_voided', json_object(
    'payment_id', NEW.id, 'amount_cents', NEW.amount_cents, 'method', NEW.method, 'reason', NEW.void_reason));
END;
