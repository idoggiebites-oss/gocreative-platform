-- Initial schema. Enum CHECK lists mirror shared/enums.ts exactly (shared/schema.test.ts guards drift).
-- IDs are integers, money is integer cents, timestamps are ISO UTC text.

CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner','staff')),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE customers (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('district','organization','individual')),
  name TEXT NOT NULL,
  organization TEXT,
  email TEXT,
  phone TEXT,
  internal_notes TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_customers_name ON customers (name COLLATE NOCASE);
CREATE INDEX idx_customers_email ON customers (email);

CREATE TABLE customer_contacts (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  title TEXT,
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0,1))
);
CREATE INDEX idx_customer_contacts_customer ON customer_contacts (customer_id);

-- Public input lands here only; staff converts it into a customer + order.
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
CREATE INDEX idx_inquiries_status ON inquiries (status);

CREATE TABLE orders (
  id INTEGER PRIMARY KEY,
  number TEXT NOT NULL UNIQUE,
  customer_id INTEGER NOT NULL REFERENCES customers (id) ON DELETE RESTRICT,
  contact_id INTEGER REFERENCES customer_contacts (id) ON DELETE SET NULL,
  source TEXT NOT NULL CHECK (source IN ('phone','email','portal')),
  title TEXT NOT NULL,
  due_date TEXT, -- date only, YYYY-MM-DD
  artwork_status TEXT NOT NULL DEFAULT 'none' CHECK (artwork_status IN ('none','pending','approved','changes_requested')),
  po_required INTEGER NOT NULL DEFAULT 0 CHECK (po_required IN (0,1)),
  authorized_at TEXT,
  authorized_by INTEGER REFERENCES users (id) ON DELETE SET NULL,
  production_status TEXT NOT NULL DEFAULT 'awaiting_authorization' CHECK (production_status IN ('awaiting_authorization','awaiting_artwork','ready','in_production','quality_control','ready_for_pickup','completed')),
  assignee_id INTEGER REFERENCES users (id) ON DELETE SET NULL,
  estimated_total_cents INTEGER,
  invoice_ref TEXT,
  payment_ref TEXT,
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','completed','cancelled')),
  created_by INTEGER REFERENCES users (id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_orders_prod_due ON orders (production_status, due_date);
CREATE INDEX idx_orders_customer ON orders (customer_id);
CREATE INDEX idx_orders_due ON orders (due_date);
CREATE INDEX idx_orders_state ON orders (state);

CREATE TABLE order_items (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  product TEXT NOT NULL,
  garment_color TEXT,
  method TEXT NOT NULL CHECK (method IN ('screen','embroidery','dtg','laser_engrave','laser_cut','other')),
  sizes TEXT CHECK (sizes IS NULL OR json_valid(sizes)),
  quantity INTEGER NOT NULL CHECK (quantity >= 0),
  unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0),
  notes TEXT
);
CREATE INDEX idx_order_items_order ON order_items (order_id);

CREATE TABLE files (
  id INTEGER PRIMARY KEY,
  r2_key TEXT NOT NULL UNIQUE,
  mime TEXT NOT NULL,
  bytes INTEGER NOT NULL CHECK (bytes >= 0),
  sha256 TEXT NOT NULL,
  preview_key TEXT,
  uploaded_by INTEGER REFERENCES users (id) ON DELETE SET NULL,
  via_portal INTEGER NOT NULL DEFAULT 0 CHECK (via_portal IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
-- Uploaded files are write-once: a new upload is a new row.
CREATE TRIGGER files_write_once BEFORE UPDATE ON files
BEGIN SELECT RAISE(ABORT, 'files are write-once'); END;

CREATE TABLE artwork (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers (id) ON DELETE RESTRICT,
  order_id INTEGER REFERENCES orders (id) ON DELETE SET NULL,
  lineage_id INTEGER NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  file_id INTEGER NOT NULL REFERENCES files (id) ON DELETE RESTRICT,
  approval_status TEXT NOT NULL DEFAULT 'pending' CHECK (approval_status IN ('pending','approved','changes_requested')),
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (lineage_id, version)
);
CREATE INDEX idx_artwork_order ON artwork (order_id);
CREATE INDEX idx_artwork_customer ON artwork (customer_id);

CREATE TABLE estimates (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version >= 1),
  inputs TEXT NOT NULL CHECK (json_valid(inputs)),
  lines TEXT NOT NULL CHECK (json_valid(lines)),
  total_cents INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent','accepted','declined')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (order_id, version)
);

CREATE TABLE purchase_orders (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  po_number TEXT,
  amount_cents INTEGER,
  status TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','received','under_review','approved','rejected','correction_required')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_purchase_orders_order ON purchase_orders (order_id);

CREATE TABLE po_documents (
  id INTEGER PRIMARY KEY,
  po_id INTEGER NOT NULL REFERENCES purchase_orders (id) ON DELETE CASCADE,
  file_id INTEGER NOT NULL REFERENCES files (id) ON DELETE RESTRICT
);
CREATE INDEX idx_po_documents_po ON po_documents (po_id);

-- Internal only, never served on a public route.
CREATE TABLE notes (
  id INTEGER PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  author_id INTEGER REFERENCES users (id) ON DELETE SET NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_notes_entity ON notes (entity_type, entity_id);

CREATE TABLE activity_log (
  id INTEGER PRIMARY KEY,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('user','portal','system')),
  actor_id INTEGER REFERENCES users (id) ON DELETE SET NULL,
  entity_type TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  before TEXT CHECK (before IS NULL OR json_valid(before)),
  after TEXT CHECK (after IS NULL OR json_valid(after)),
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_activity_entity ON activity_log (entity_type, entity_id);
-- Append-only audit trail.
CREATE TRIGGER activity_log_no_update BEFORE UPDATE ON activity_log
BEGIN SELECT RAISE(ABORT, 'activity_log is append-only'); END;
CREATE TRIGGER activity_log_no_delete BEFORE DELETE ON activity_log
BEGIN SELECT RAISE(ABORT, 'activity_log is append-only'); END;

CREATE TABLE counters (
  name TEXT NOT NULL,
  year INTEGER NOT NULL,
  next INTEGER NOT NULL,
  PRIMARY KEY (name, year)
);
