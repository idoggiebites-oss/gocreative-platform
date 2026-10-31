-- M4: the production slot model (PHASE2_PLAN §4.3), units completed and the ready-queue order.
-- Additive only: the live orders table has real rows and many foreign keys point at it, so it is not rebuilt.
-- The cross-column rules design/sql/production-slots.sql wrote as table CHECKs can't be added to an existing table,
-- so the orders_production_slot_* triggers below enforce them, on INSERT and on EVERY UPDATE (an `UPDATE OF col`
-- trigger misses updates through a rowid alias; Codex, M3 review). Bodies of the slot-2 triggers, the unique index
-- and the audit triggers are verbatim from design/sql/production-slots.sql.

ALTER TABLE orders ADD COLUMN production_slot INTEGER CHECK (production_slot IS NULL OR production_slot IN (1, 2));
ALTER TABLE orders ADD COLUMN production_override_by INTEGER REFERENCES users (id);
ALTER TABLE orders ADD COLUMN production_override_reason TEXT;
-- Manual position in the Ready to start list (1 = next); NULL sorts after every positioned order, then by due date.
ALTER TABLE orders ADD COLUMN queue_position INTEGER CHECK (queue_position IS NULL OR (typeof(queue_position) = 'integer' AND queue_position >= 1));
-- Progress = units completed (decision 12), correctable up or down; the app caps it at the order's product quantity.
ALTER TABLE orders ADD COLUMN units_completed INTEGER NOT NULL DEFAULT 0 CHECK (typeof(units_completed) = 'integer' AND units_completed >= 0);

-- Existing rows. A cancelled or closed order can't hold a slot: one left in_production drops to 'ready', as cancelling
-- does (reopening re-derives it). At most one active order can be running without an override; it takes slot 1.
-- More than one means a person must decide which job is really running: the guard table's CHECK then fails the
-- whole migration (D1 applies it in one transaction) instead of guessing.
UPDATE orders SET production_status = 'ready' WHERE production_status = 'in_production' AND state <> 'active';
CREATE TABLE _m0005_guard (running_jobs INTEGER CHECK (running_jobs <= 1));
INSERT INTO _m0005_guard SELECT COUNT(*) FROM orders WHERE production_status = 'in_production';
DROP TABLE _m0005_guard;
UPDATE orders SET production_slot = 1 WHERE production_status = 'in_production';

CREATE UNIQUE INDEX one_job_per_slot ON orders (production_slot) WHERE production_slot IS NOT NULL;

-- The table-CHECK rules of §4.3: a slot exactly while in_production; only an active order holds one; slot 2 has an
-- overrider and a non-blank reason; the override columns describe only a slot-2 job; and a slot-2 job never moves
-- into slot 1 (it leaves production and the next normal start takes slot 1).
CREATE TRIGGER orders_production_slot_insert BEFORE INSERT ON orders
BEGIN
  -- INSERT OR REPLACE would delete a conflicting row without firing the UPDATE rules (promoting a slot-2 job,
  -- rewriting an override, evicting a running job): refuse any insert that collides with an existing order or a
  -- held slot (Codex review of fcdbb90).
  SELECT RAISE(ABORT, 'order_exists')
  WHERE EXISTS (SELECT 1 FROM orders WHERE id = NEW.id OR number = NEW.number);
  SELECT RAISE(ABORT, 'production_slot_invalid')
  WHERE NEW.production_slot IS NOT NULL AND EXISTS (SELECT 1 FROM orders WHERE production_slot = NEW.production_slot);
  SELECT RAISE(ABORT, 'production_slot_invalid')
  WHERE (NEW.production_status = 'in_production') <> (NEW.production_slot IS NOT NULL)
     OR (NEW.production_slot IS NOT NULL AND NEW.state IS NOT 'active')
     OR (NEW.production_slot IS NOT 2 AND (NEW.production_override_by IS NOT NULL OR NEW.production_override_reason IS NOT NULL));
  SELECT RAISE(ABORT, 'production_override_invalid')
  WHERE NEW.production_slot IS 2 AND (NEW.production_override_by IS NULL OR length(trim(coalesce(NEW.production_override_reason, ''))) = 0);
END;
CREATE TRIGGER orders_production_slot_update BEFORE UPDATE ON orders
BEGIN
  -- An order's identity is fixed (through id or any rowid alias); otherwise an order could count itself as the
  -- running slot-1 job (Codex review of fcdbb90). UPDATE OR REPLACE into a held slot would evict its job: refuse.
  SELECT RAISE(ABORT, 'order_id_fixed') WHERE NEW.id IS NOT OLD.id;
  SELECT RAISE(ABORT, 'production_slot_invalid')
  WHERE NEW.production_slot IS NOT NULL AND NEW.production_slot IS NOT OLD.production_slot
    AND EXISTS (SELECT 1 FROM orders WHERE production_slot = NEW.production_slot AND id IS NOT OLD.id);
  SELECT RAISE(ABORT, 'production_slot_invalid')
  WHERE (NEW.production_status = 'in_production') <> (NEW.production_slot IS NOT NULL)
     OR (NEW.production_slot IS NOT NULL AND NEW.state IS NOT 'active')
     OR (NEW.production_slot IS NOT 2 AND (NEW.production_override_by IS NOT NULL OR NEW.production_override_reason IS NOT NULL))
     OR (OLD.production_slot IS 2 AND NEW.production_slot IS 1);
  SELECT RAISE(ABORT, 'production_override_invalid')
  WHERE NEW.production_slot IS 2 AND (NEW.production_override_by IS NULL OR length(trim(coalesce(NEW.production_override_reason, ''))) = 0);
END;

-- Entering slot 2 needs another order already in slot 1 and an active owner as the overrider.
-- The CHECKs above can't see other rows, so these triggers do; no SQL path can bypass them.
CREATE TRIGGER production_slot2_insert BEFORE INSERT ON orders
WHEN NEW.production_slot IS 2
BEGIN
  SELECT RAISE(ABORT, 'production_override_invalid')
  WHERE NOT EXISTS (SELECT 1 FROM orders WHERE production_slot = 1 AND id IS NOT NEW.id)
     OR NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.production_override_by AND active = 1 AND role = 'owner');
END;
CREATE TRIGGER production_slot2_update BEFORE UPDATE ON orders
WHEN NEW.production_slot IS 2
BEGIN
  -- Who and why are fixed once the job holds slot 2.
  SELECT RAISE(ABORT, 'production_override_immutable')
  WHERE OLD.production_slot IS 2 AND (NEW.production_override_by IS NOT OLD.production_override_by
    OR NEW.production_override_reason IS NOT OLD.production_override_reason);
  SELECT RAISE(ABORT, 'production_override_invalid')
  WHERE OLD.production_slot IS NOT 2 AND (
    NOT EXISTS (SELECT 1 FROM orders WHERE production_slot = 1 AND id IS NOT NEW.id AND id IS NOT OLD.id)
    OR NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.production_override_by AND active = 1 AND role = 'owner'));
END;

-- The audit row is written by the database, so an override can't happen without one.
CREATE TRIGGER production_slot2_log_insert AFTER INSERT ON orders
WHEN NEW.production_slot IS 2
BEGIN
  INSERT INTO activity_log (actor_kind, actor_id, entity_type, entity_id, action, after)
  VALUES ('user', NEW.production_override_by, 'order', NEW.id, 'production_override', json_object(
    'reason', NEW.production_override_reason,
    'running_order_id', (SELECT id FROM orders WHERE production_slot = 1)));
END;
CREATE TRIGGER production_slot2_log_update AFTER UPDATE ON orders
WHEN NEW.production_slot IS 2 AND OLD.production_slot IS NOT 2
BEGIN
  INSERT INTO activity_log (actor_kind, actor_id, entity_type, entity_id, action, after)
  VALUES ('user', NEW.production_override_by, 'order', NEW.id, 'production_override', json_object(
    'reason', NEW.production_override_reason,
    'running_order_id', (SELECT id FROM orders WHERE production_slot = 1)));
END;
