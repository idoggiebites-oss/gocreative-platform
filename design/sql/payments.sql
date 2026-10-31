-- Minimal M0 proof tables, applied on top of migration 0001 (orders, users, activity_log);
-- they move into migration 0005. Collect/record statements: worker/db/paymentSql.ts.
CREATE TABLE check_collections (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders (id) ON DELETE RESTRICT,
  expected_cents INTEGER NOT NULL CHECK (typeof(expected_cents) = 'integer' AND expected_cents > 0),
  -- Positivity is enforced on the payment the collect creates, in the same batch.
  amount_received_cents INTEGER CHECK (amount_received_cents IS NULL OR typeof(amount_received_cents) = 'integer'),
  check_number TEXT,
  status TEXT NOT NULL DEFAULT 'awaiting_payment' CHECK (status IN ('awaiting_payment', 'ready_for_collection', 'collected', 'deposited', 'cleared')),
  available_on TEXT, -- business date, shop time
  collected_at TEXT,
  collected_by INTEGER REFERENCES users (id) ON DELETE RESTRICT,
  deposited_on TEXT,
  cleared_on TEXT,
  notes TEXT
);

CREATE TABLE payments (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders (id) ON DELETE RESTRICT,
  amount_cents INTEGER NOT NULL CHECK (typeof(amount_cents) = 'integer' AND amount_cents > 0),
  method TEXT NOT NULL CHECK (method IN ('check', 'ach', 'cash', 'card', 'other')),
  paid_on TEXT NOT NULL, -- business date, shop time
  notes TEXT,
  recorded_by INTEGER NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  -- Client-generated per form submission; a resubmitted form hits UNIQUE.
  request_id TEXT UNIQUE,
  -- A check collection produces at most one payment.
  check_collection_id INTEGER UNIQUE REFERENCES check_collections (id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  -- Every payment is de-duplicated by one of the two keys.
  CHECK (check_collection_id IS NOT NULL OR (request_id IS NOT NULL AND length(trim(request_id)) > 0))
);
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
