-- M3: suppliers, order purchases and partial receipts. Additive only: the live D1 holds real rows, so nothing is
-- rebuilt. orders.materials_required and orders.prep_status already exist (0002).
-- Business dates (ordered_on, expected_on, received_on) are YYYY-MM-DD in shop time (PHASE2_PLAN §4.5);
-- `date(x) IS x` refuses an impossible date such as 2026-02-30, which date() would roll over.

CREATE TABLE suppliers (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE CHECK (length(trim(name)) BETWEEN 1 AND 100 AND length(name) <= 100),
  is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
-- At most one default supplier.
CREATE UNIQUE INDEX one_default_supplier ON suppliers (is_default) WHERE is_default = 1;
INSERT INTO suppliers (name, is_default) VALUES ('JDS', 1);

-- One purchase = one line bought from a supplier for one order. Stored status is not_ordered / ordered / cancelled;
-- partially received and received are derived from the receipts (worker/domain/purchasing.ts purchaseStatus).
CREATE TABLE order_purchases (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders (id),
  supplier_id INTEGER NOT NULL REFERENCES suppliers (id),
  description TEXT NOT NULL CHECK (length(trim(description)) BETWEEN 1 AND 200 AND length(description) <= 200),
  quantity INTEGER NOT NULL CHECK (typeof(quantity) = 'integer' AND quantity >= 1),
  sizes TEXT CHECK (sizes IS NULL OR json_valid(sizes)),
  estimated_unit_cost_cents INTEGER CHECK (estimated_unit_cost_cents IS NULL OR (typeof(estimated_unit_cost_cents) = 'integer' AND estimated_unit_cost_cents >= 0)),
  actual_unit_cost_cents INTEGER CHECK (actual_unit_cost_cents IS NULL OR (typeof(actual_unit_cost_cents) = 'integer' AND actual_unit_cost_cents >= 0)),
  status TEXT NOT NULL DEFAULT 'not_ordered' CHECK (status IN ('not_ordered','ordered','cancelled')),
  ordered_on TEXT CHECK (ordered_on IS NULL OR date(ordered_on) IS ordered_on),
  expected_on TEXT CHECK (expected_on IS NULL OR date(expected_on) IS expected_on),
  notes TEXT,
  created_by INTEGER REFERENCES users (id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  -- An ordered purchase says when it was bought.
  CHECK (status <> 'ordered' OR ordered_on IS NOT NULL)
);
CREATE INDEX idx_order_purchases_order ON order_purchases (order_id);
CREATE INDEX idx_order_purchases_supplier ON order_purchases (supplier_id);

-- The only status moves: not_ordered -> ordered (staff confirm the purchase), and either of them -> cancelled.
CREATE TRIGGER order_purchases_status_move BEFORE UPDATE OF status ON order_purchases
WHEN NEW.status IS NOT OLD.status
  AND NOT ((OLD.status = 'not_ordered' AND NEW.status IN ('ordered','cancelled')) OR (OLD.status = 'ordered' AND NEW.status = 'cancelled'))
BEGIN SELECT RAISE(ABORT, 'purchase_transition_not_allowed'); END;
-- A purchase never moves to another order.
CREATE TRIGGER order_purchases_order_fixed BEFORE UPDATE OF order_id ON order_purchases
WHEN NEW.order_id IS NOT OLD.order_id
BEGIN SELECT RAISE(ABORT, 'purchase_order_fixed'); END;
-- REPLACE deletes then inserts without firing the UPDATE triggers; refuse it so the status rules can't be bypassed.
CREATE TRIGGER order_purchases_no_replace BEFORE INSERT ON order_purchases
WHEN EXISTS (SELECT 1 FROM order_purchases WHERE id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'purchase_order_fixed'); END;

-- One delivery against a purchase. Write-once: a wrong receipt is corrected by recording what really arrived
-- next to it, never by editing history.
CREATE TABLE purchase_receipts (
  id INTEGER PRIMARY KEY,
  purchase_id INTEGER NOT NULL REFERENCES order_purchases (id),
  quantity INTEGER NOT NULL CHECK (typeof(quantity) = 'integer' AND quantity >= 1),
  sizes TEXT CHECK (sizes IS NULL OR json_valid(sizes)),
  received_on TEXT NOT NULL CHECK (date(received_on) IS received_on),
  notes TEXT,
  recorded_by INTEGER REFERENCES users (id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_purchase_receipts_purchase ON purchase_receipts (purchase_id);
CREATE TRIGGER purchase_receipts_no_update BEFORE UPDATE ON purchase_receipts
BEGIN SELECT RAISE(ABORT, 'purchase_receipts are write-once'); END;
CREATE TRIGGER purchase_receipts_no_delete BEFORE DELETE ON purchase_receipts
BEGIN SELECT RAISE(ABORT, 'purchase_receipts are write-once'); END;
CREATE TRIGGER purchase_receipts_no_replace BEFORE INSERT ON purchase_receipts
WHEN EXISTS (SELECT 1 FROM purchase_receipts WHERE id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'purchase_receipts are write-once'); END;
-- Only an ordered purchase takes a new receipt (domain checkReceipt). Receipts recorded before a cancellation stay.
CREATE TRIGGER purchase_receipts_need_ordered BEFORE INSERT ON purchase_receipts
WHEN (SELECT status FROM order_purchases WHERE id = NEW.purchase_id) IS NOT 'ordered'
BEGIN SELECT RAISE(ABORT, 'purchase_not_ordered'); END;
