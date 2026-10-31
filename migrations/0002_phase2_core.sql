-- Phase 2 core (M1a): the Phase 2 vocabulary, quotes replacing estimates, readiness columns.
-- Enum CHECK lists mirror shared/enums.ts exactly (shared/schema.test.ts parses the final schema).
--
-- How the rebuilds stay safe. SQLite can't change a CHECK list in place, so orders, order_items and
-- artwork are rebuilt. With foreign keys on (D1 enforces them), DROP TABLE orders runs an implicit
-- DELETE that fires ON DELETE CASCADE / SET NULL in every table referencing it, and those actions are
-- not deferred. So every table that references orders (directly, or via purchase_orders) is first
-- copied to a plain _m2_* table and dropped, children before parents; orders is dropped only once
-- nothing references it; then everything is recreated and refilled parent-first. Rows keep their ids,
-- so links (inquiries.order_id, artwork.order_id, po_documents.po_id) survive.
-- defer_foreign_keys (D1's recommendation for rebuilds) postpones the remaining checks to commit.
PRAGMA defer_foreign_keys = ON;

-- ---- customers: additive, no rebuild ----
ALTER TABLE customers ADD COLUMN default_po_required INTEGER NOT NULL DEFAULT 0 CHECK (default_po_required IN (0,1));
ALTER TABLE customers ADD COLUMN default_payment_terms TEXT NOT NULL DEFAULT 'due_at_pickup' CHECK (default_payment_terms IN ('due_at_pickup','due_after_pickup'));

-- Integer version for the lost-update guard: every write to the customer row bumps it.
ALTER TABLE customers ADD COLUMN version INTEGER NOT NULL DEFAULT 0;

-- Contacts are never deleted (orders reference them); archiving hides them instead.
ALTER TABLE customer_contacts ADD COLUMN archived_at TEXT;

-- ---- set aside everything that references orders ----
CREATE TABLE _m2_orders AS SELECT * FROM orders;
CREATE TABLE _m2_order_items AS SELECT * FROM order_items;
CREATE TABLE _m2_artwork AS SELECT * FROM artwork;
CREATE TABLE _m2_purchase_orders AS SELECT * FROM purchase_orders;
CREATE TABLE _m2_po_documents AS SELECT * FROM po_documents;
CREATE TABLE _m2_inquiries AS SELECT * FROM inquiries;

DROP TABLE po_documents;
DROP TABLE purchase_orders;
DROP TABLE inquiries;
DROP TABLE artwork;
DROP TABLE order_items;
-- estimates are replaced by quotes. Their lines were free-form JSON labels, not convertible to
-- quote_items; the remote DB holds none (wiped before 0002), and the dev seed is re-run.
DROP TABLE estimates;
DROP TABLE orders;

-- ---- orders ----
-- Artwork status is derived from the designs' current versions (readiness.orderArtworkStatus), never stored.
-- The agreed total is the accepted quote's total, so estimated_total_cents is gone.
CREATE TABLE orders (
  id INTEGER PRIMARY KEY,
  number TEXT NOT NULL UNIQUE,
  customer_id INTEGER NOT NULL REFERENCES customers (id) ON DELETE RESTRICT,
  contact_id INTEGER REFERENCES customer_contacts (id) ON DELETE SET NULL,
  source TEXT NOT NULL CHECK (source IN ('phone','email','portal')),
  title TEXT NOT NULL,
  due_date TEXT, -- business date in shop time, YYYY-MM-DD
  artwork_required INTEGER NOT NULL DEFAULT 1 CHECK (artwork_required IN (0,1)),
  po_required INTEGER NOT NULL DEFAULT 0 CHECK (po_required IN (0,1)),
  -- Direct authorization (non-PO orders); history lives in activity_log.
  authorized_at TEXT CHECK (authorized_at IS NULL OR length(trim(authorized_at)) > 0),
  authorized_by INTEGER REFERENCES users (id) ON DELETE SET NULL,
  authorization_method TEXT CHECK (authorization_method IS NULL OR authorization_method IN ('phone','email','in_person','signed_form','other')),
  authorization_notes TEXT,
  -- Bumped by every customer-facing item change (quotes.CUSTOMER_FACING_ITEM_FIELDS); an accepted quote counts only at the same revision.
  items_revision INTEGER NOT NULL DEFAULT 0 CHECK (typeof(items_revision) = 'integer' AND items_revision >= 0),
  payment_terms TEXT NOT NULL DEFAULT 'due_at_pickup' CHECK (payment_terms IN ('due_at_pickup','due_after_pickup')),
  materials_required INTEGER NOT NULL DEFAULT 1 CHECK (materials_required IN (0,1)),
  prep_status TEXT NOT NULL DEFAULT 'not_started' CHECK (prep_status IN ('not_started','in_progress','ready','not_required')),
  production_status TEXT NOT NULL DEFAULT 'awaiting_quote' CHECK (production_status IN ('awaiting_quote','awaiting_authorization','awaiting_artwork','awaiting_materials','awaiting_preparation','ready','in_production','quality_control','production_complete')),
  assignee_id INTEGER REFERENCES users (id) ON DELETE SET NULL,
  invoice_ref TEXT,
  payment_ref TEXT,
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','cancelled','closed')),
  created_by INTEGER REFERENCES users (id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
-- Phase 1 values map onto Phase 2: no quote exists after this migration, so every pre-production order
-- is awaiting_quote (what readiness derives); pickup is no longer a production status.
INSERT INTO orders (id, number, customer_id, contact_id, source, title, due_date, po_required, authorized_at, authorized_by,
  production_status, assignee_id, invoice_ref, payment_ref, state, created_by, created_at, updated_at)
SELECT id, number, customer_id, contact_id, source, title, due_date, po_required, authorized_at, authorized_by,
  CASE production_status
    WHEN 'in_production' THEN 'in_production'
    WHEN 'quality_control' THEN 'quality_control'
    WHEN 'ready_for_pickup' THEN 'production_complete'
    WHEN 'completed' THEN 'production_complete'
    ELSE 'awaiting_quote' END,
  assignee_id, invoice_ref, payment_ref,
  CASE state WHEN 'completed' THEN 'closed' ELSE state END,
  created_by, created_at, updated_at
FROM _m2_orders;
CREATE INDEX idx_orders_state_prod_due ON orders (state, production_status, due_date);
CREATE INDEX idx_orders_state_due ON orders (state, due_date);
CREATE INDEX idx_orders_customer ON orders (customer_id);
CREATE INDEX idx_orders_due ON orders (due_date);

-- ---- order_items: the working list; charge and discount lines have no product or method ----
CREATE TABLE order_items (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'product' CHECK (kind IN ('product','charge','discount')),
  description TEXT,
  product TEXT,
  garment_color TEXT,
  method TEXT CHECK (method IS NULL OR method IN ('screen','embroidery','dtg','laser_engrave','laser_cut','other')),
  sizes TEXT CHECK (sizes IS NULL OR json_valid(sizes)),
  quantity INTEGER NOT NULL CHECK (typeof(quantity) = 'integer' AND quantity >= 0),
  unit_price_cents INTEGER NOT NULL CHECK (typeof(unit_price_cents) = 'integer' AND unit_price_cents >= 0),
  notes TEXT, -- internal; never bumps items_revision
  CHECK (kind <> 'product' OR (product IS NOT NULL AND method IS NOT NULL))
);
INSERT INTO order_items (id, order_id, kind, product, garment_color, method, sizes, quantity, unit_price_cents, notes)
SELECT id, order_id, 'product', product, garment_color, method, sizes, quantity, unit_price_cents, notes FROM _m2_order_items;
CREATE INDEX idx_order_items_order ON order_items (order_id);

-- ---- artwork: lineage = one design, version = one file; approval belongs to a version ----
CREATE TABLE artwork (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers (id) ON DELETE RESTRICT,
  order_id INTEGER REFERENCES orders (id) ON DELETE SET NULL,
  lineage_id INTEGER NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  file_id INTEGER NOT NULL REFERENCES files (id) ON DELETE RESTRICT,
  approval_status TEXT NOT NULL DEFAULT 'under_review' CHECK (approval_status IN ('under_review','changes_requested','approved')),
  approved_at TEXT,
  approved_via TEXT CHECK (approved_via IS NULL OR approved_via IN ('phone','email','in_person','signed_form','other')),
  approval_recorded_by INTEGER REFERENCES users (id) ON DELETE RESTRICT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (lineage_id, version),
  CHECK (approval_status <> 'approved' OR (approved_at IS NOT NULL AND approved_via IS NOT NULL AND approval_recorded_by IS NOT NULL))
);
-- Phase 1 never recorded who approved or how, so an approved version comes back under review.
INSERT INTO artwork (id, customer_id, order_id, lineage_id, version, file_id, approval_status, notes, created_at)
SELECT id, customer_id, order_id, lineage_id, version, file_id,
  CASE approval_status WHEN 'changes_requested' THEN 'changes_requested' ELSE 'under_review' END, notes, created_at
FROM _m2_artwork;
CREATE INDEX idx_artwork_order ON artwork (order_id);
CREATE INDEX idx_artwork_customer ON artwork (customer_id);

-- ---- unchanged tables, recreated as in 0001 ----
CREATE TABLE inquiries (
  id INTEGER PRIMARY KEY,
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  contact_name TEXT,
  contact_email TEXT,
  contact_phone TEXT,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','converted','spam')),
  order_id INTEGER REFERENCES orders (id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
INSERT INTO inquiries SELECT id, payload, contact_name, contact_email, contact_phone, status, order_id, created_at FROM _m2_inquiries;
CREATE INDEX idx_inquiries_status ON inquiries (status);

CREATE TABLE purchase_orders (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders (id) ON DELETE RESTRICT,
  po_number TEXT,
  amount_cents INTEGER CHECK (amount_cents IS NULL OR typeof(amount_cents) = 'integer'),
  status TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','received','under_review','approved','rejected','correction_required')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
INSERT INTO purchase_orders SELECT id, order_id, po_number, amount_cents, status, created_at, updated_at FROM _m2_purchase_orders;
CREATE INDEX idx_purchase_orders_order ON purchase_orders (order_id);

CREATE TABLE po_documents (
  id INTEGER PRIMARY KEY,
  po_id INTEGER NOT NULL REFERENCES purchase_orders (id) ON DELETE RESTRICT,
  file_id INTEGER NOT NULL REFERENCES files (id) ON DELETE RESTRICT
);
INSERT INTO po_documents SELECT id, po_id, file_id FROM _m2_po_documents;
CREATE INDEX idx_po_documents_po ON po_documents (po_id);

DROP TABLE _m2_po_documents;
DROP TABLE _m2_purchase_orders;
DROP TABLE _m2_inquiries;
DROP TABLE _m2_artwork;
DROP TABLE _m2_order_items;
DROP TABLE _m2_orders;

-- ---- quotes: versioned snapshots of the items and their prices ----
CREATE TABLE quotes (
  id INTEGER PRIMARY KEY,
  -- RESTRICT: orders are cancelled via state, never deleted; history must not cascade away.
  order_id INTEGER NOT NULL REFERENCES orders (id) ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK (typeof(version) = 'integer' AND version >= 1),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent','accepted','declined','superseded')),
  -- orders.items_revision when this snapshot was taken.
  items_revision INTEGER NOT NULL CHECK (typeof(items_revision) = 'integer' AND items_revision >= 0),
  subtotal_cents INTEGER NOT NULL DEFAULT 0 CHECK (typeof(subtotal_cents) = 'integer' AND subtotal_cents >= 0),
  charges_cents INTEGER NOT NULL DEFAULT 0 CHECK (typeof(charges_cents) = 'integer' AND charges_cents >= 0),
  discounts_cents INTEGER NOT NULL DEFAULT 0 CHECK (typeof(discounts_cents) = 'integer' AND discounts_cents >= 0),
  total_cents INTEGER NOT NULL DEFAULT 0 CHECK (typeof(total_cents) = 'integer' AND total_cents >= 0),
  -- RESTRICT, not SET NULL: SET NULL is an UPDATE the freeze trigger rejects. Users are deactivated, never deleted.
  created_by INTEGER NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  sent_at TEXT,
  decided_at TEXT,
  UNIQUE (order_id, version),
  CHECK (total_cents = subtotal_cents + charges_cents - discounts_cents)
);
-- planNewVersion supersedes the previous accepted quote, so an order never has two.
CREATE UNIQUE INDEX one_accepted_quote_per_order ON quotes (order_id) WHERE status = 'accepted';

CREATE TABLE quote_items (
  id INTEGER PRIMARY KEY,
  quote_id INTEGER NOT NULL REFERENCES quotes (id) ON DELETE RESTRICT,
  position INTEGER NOT NULL CHECK (typeof(position) = 'integer' AND position >= 0),
  kind TEXT NOT NULL CHECK (kind IN ('product','charge','discount')),
  description TEXT,
  product TEXT,
  garment_color TEXT,
  method TEXT CHECK (method IS NULL OR method IN ('screen','embroidery','dtg','laser_engrave','laser_cut','other')),
  sizes TEXT CHECK (sizes IS NULL OR json_valid(sizes)),
  quantity INTEGER NOT NULL CHECK (typeof(quantity) = 'integer' AND quantity >= 0),
  unit_price_cents INTEGER NOT NULL CHECK (typeof(unit_price_cents) = 'integer' AND unit_price_cents >= 0),
  -- Signed: a discount line is negative (quotes.lineTotalCents).
  line_total_cents INTEGER NOT NULL CHECK (typeof(line_total_cents) = 'integer'),
  UNIQUE (quote_id, position),
  CHECK (kind <> 'product' OR (product IS NOT NULL AND method IS NOT NULL))
);
CREATE INDEX idx_quotes_order ON quotes (order_id);

-- Only a draft's lines can change. Every write path is covered: INSERT (including a REPLACE that would
-- silently delete a frozen line, which fires no DELETE trigger), UPDATE (including moving a line between
-- quotes or changing its id) and DELETE.
CREATE TRIGGER quote_items_insert_draft_only BEFORE INSERT ON quote_items
WHEN (SELECT status FROM quotes WHERE id = NEW.quote_id) IS NOT 'draft'
  OR EXISTS (SELECT 1 FROM quote_items qi JOIN quotes q ON q.id = qi.quote_id
             WHERE (qi.id = NEW.id OR (qi.quote_id = NEW.quote_id AND qi.position = NEW.position)) AND q.status <> 'draft')
BEGIN SELECT RAISE(ABORT, 'quote_not_draft'); END;
CREATE TRIGGER quote_items_update_draft_only BEFORE UPDATE ON quote_items
WHEN NEW.id IS NOT OLD.id
  OR (SELECT status FROM quotes WHERE id = OLD.quote_id) IS NOT 'draft'
  OR (SELECT status FROM quotes WHERE id = NEW.quote_id) IS NOT 'draft'
BEGIN SELECT RAISE(ABORT, 'quote_not_draft'); END;
CREATE TRIGGER quote_items_delete_draft_only BEFORE DELETE ON quote_items
WHEN (SELECT status FROM quotes WHERE id = OLD.quote_id) IS NOT 'draft'
BEGIN SELECT RAISE(ABORT, 'quote_not_draft'); END;

-- A quote starts as a draft (its lines can only be added while it is one), and a REPLACE can't
-- swap out a quote that has left draft.
CREATE TRIGGER quotes_insert_draft_only BEFORE INSERT ON quotes
WHEN NEW.status IS NOT 'draft'
  OR EXISTS (SELECT 1 FROM quotes WHERE (id = NEW.id OR (order_id = NEW.order_id AND version = NEW.version)) AND status <> 'draft')
BEGIN SELECT RAISE(ABORT, 'quote_not_draft'); END;
-- Once a quote leaves draft only its status and the sent/decided timestamps may change.
CREATE TRIGGER quotes_frozen BEFORE UPDATE ON quotes
WHEN NEW.id IS NOT OLD.id OR (OLD.status <> 'draft' AND (
  NEW.order_id IS NOT OLD.order_id OR NEW.version IS NOT OLD.version OR NEW.items_revision IS NOT OLD.items_revision
  OR NEW.subtotal_cents IS NOT OLD.subtotal_cents OR NEW.charges_cents IS NOT OLD.charges_cents
  OR NEW.discounts_cents IS NOT OLD.discounts_cents OR NEW.total_cents IS NOT OLD.total_cents
  OR NEW.created_by IS NOT OLD.created_by OR NEW.created_at IS NOT OLD.created_at))
BEGIN SELECT RAISE(ABORT, 'quote_frozen'); END;
-- A quote's order and version never change, draft or not: UPDATE OR REPLACE onto another
-- version's (order_id, version) would otherwise silently delete that (possibly frozen) quote.
CREATE TRIGGER quotes_identity_fixed BEFORE UPDATE OF order_id, version ON quotes
WHEN NEW.order_id IS NOT OLD.order_id OR NEW.version IS NOT OLD.version
BEGIN SELECT RAISE(ABORT, 'quote_frozen'); END;
-- The union of checkQuoteTransition (draft -> sent/accepted/declined, sent -> accepted/declined) and
-- planNewVersion (draft/sent/accepted -> superseded). Declined and superseded are final.
CREATE TRIGGER quotes_status_transition BEFORE UPDATE OF status ON quotes
WHEN NEW.status IS NOT OLD.status AND NOT (
  (OLD.status = 'draft' AND NEW.status IN ('sent','accepted','declined','superseded'))
  OR (OLD.status = 'sent' AND NEW.status IN ('accepted','declined','superseded'))
  OR (OLD.status = 'accepted' AND NEW.status = 'superseded'))
BEGIN SELECT RAISE(ABORT, 'invalid_quote_transition'); END;
-- checkQuoteAcceptable's first rule, held by the database too: a charge-only or empty quote is never accepted.
CREATE TRIGGER quotes_accept_needs_product BEFORE UPDATE OF status ON quotes
WHEN NEW.status = 'accepted' AND OLD.status IS NOT 'accepted'
  AND NOT EXISTS (SELECT 1 FROM quote_items WHERE quote_id = NEW.id AND kind = 'product')
BEGIN SELECT RAISE(ABORT, 'no_product_line'); END;
-- History is kept: only a draft can be deleted (and only once its lines are gone, via the FK).
CREATE TRIGGER quotes_delete_draft_only BEFORE DELETE ON quotes
WHEN OLD.status <> 'draft'
BEGIN SELECT RAISE(ABORT, 'quote_not_draft'); END;
