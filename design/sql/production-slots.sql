-- Minimal M0 proof table; the slot constraints, override columns and triggers move into
-- migration 0004 (orders already has state; users and activity_log come from 0001).
CREATE TABLE orders (
  id INTEGER PRIMARY KEY,
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'cancelled', 'closed')),
  production_status TEXT NOT NULL CHECK (production_status IN (
    'awaiting_quote', 'awaiting_authorization', 'awaiting_artwork',
    'awaiting_materials', 'awaiting_preparation', 'ready', 'in_production',
    'quality_control', 'production_complete'
  )),
  production_slot INTEGER NULL CHECK (production_slot IN (1, 2)),
  production_override_by INTEGER REFERENCES users (id),
  production_override_reason TEXT,
  CHECK ((production_status = 'in_production') = (production_slot IS NOT NULL)),
  -- Only an active order can hold a slot; cancelling releases it in the same UPDATE.
  CHECK (production_slot IS NULL OR state = 'active'),
  -- Slot 2 exists only as an owner override with a reason ...
  CHECK (production_slot IS NOT 2 OR (production_override_by IS NOT NULL
    AND length(trim(coalesce(production_override_reason, ''))) > 0)),
  -- ... and the override columns describe only a slot-2 job. (IS, not =: a NULL CHECK passes.)
  CHECK (production_slot IS 2 OR (production_override_by IS NULL AND production_override_reason IS NULL))
);
CREATE UNIQUE INDEX one_job_per_slot ON orders (production_slot) WHERE production_slot IS NOT NULL;

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
    NOT EXISTS (SELECT 1 FROM orders WHERE production_slot = 1 AND id IS NOT NEW.id)
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
