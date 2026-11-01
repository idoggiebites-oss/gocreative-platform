-- S1: public inquiries. Rebuilds inquiries, which widens its status CHECK (Arturo's go, 2026-11-01); nothing references it.
-- Intake ships closed: the row below makes every public write answer 503 until a person removes it at launch.
INSERT INTO settings (key, value) VALUES ('intake_closed', 'not launched');

-- One upload session, opened by a verified Turnstile token. The token itself is never stored.
CREATE TABLE inquiry_submissions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  ip_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','submitted','expiring')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_submissions_ip ON inquiry_submissions (ip_hash, created_at);
CREATE INDEX idx_submissions_status ON inquiry_submissions (status, expires_at);
CREATE TRIGGER submissions_identity_fixed BEFORE UPDATE ON inquiry_submissions
WHEN NEW.id IS NOT OLD.id OR NEW.token_hash IS NOT OLD.token_hash OR NEW.ip_hash IS NOT OLD.ip_hash OR NEW.expires_at IS NOT OLD.expires_at OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'submissions_identity_fixed'); END;
-- Only an open session moves: a submitted one never expires, and an expiring one can't be submitted.
CREATE TRIGGER submissions_status_move BEFORE UPDATE OF status ON inquiry_submissions
WHEN NEW.status IS NOT OLD.status AND OLD.status <> 'open'
BEGIN SELECT RAISE(ABORT, 'submissions_status_move'); END;
CREATE TRIGGER submissions_no_delete BEFORE DELETE ON inquiry_submissions
WHEN OLD.status <> 'expiring'
BEGIN SELECT RAISE(ABORT, 'submissions_no_delete'); END;
CREATE TRIGGER submissions_no_replace BEFORE INSERT ON inquiry_submissions
WHEN EXISTS (SELECT 1 FROM inquiry_submissions WHERE id = NEW.id OR token_hash = NEW.token_hash)
BEGIN SELECT RAISE(ABORT, 'submissions_no_replace'); END;

CREATE TABLE _m9_inquiries AS SELECT * FROM inquiries;
DROP TABLE inquiries;
CREATE TABLE inquiries (
  id INTEGER PRIMARY KEY,
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  contact_name TEXT,
  contact_email TEXT,
  contact_phone TEXT,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','converted','declined','spam')),
  order_id INTEGER REFERENCES orders (id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ref TEXT UNIQUE,
  submission_id TEXT UNIQUE REFERENCES inquiry_submissions (id),
  customer_kind TEXT CHECK (customer_kind IS NULL OR customer_kind IN ('district','organization','individual')),
  organization TEXT,
  preferred_contact TEXT CHECK (preferred_contact IS NULL OR preferred_contact IN ('email','phone')),
  due_date TEXT,
  ip_hash TEXT,
  decline_reason TEXT, -- internal; never shown publicly
  converted_at TEXT,
  converted_by INTEGER REFERENCES users (id),
  version INTEGER NOT NULL DEFAULT 1
);
INSERT INTO inquiries (id, payload, contact_name, contact_email, contact_phone, status, order_id, created_at)
SELECT id, payload, contact_name, contact_email, contact_phone, status, order_id, created_at FROM _m9_inquiries;
DROP TABLE _m9_inquiries;
CREATE INDEX idx_inquiries_status ON inquiries (status);
CREATE TRIGGER inquiries_identity_fixed BEFORE UPDATE ON inquiries
WHEN NEW.ref IS NOT OLD.ref OR NEW.submission_id IS NOT OLD.submission_id OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'inquiries_identity_fixed'); END;
CREATE TRIGGER inquiries_no_replace BEFORE INSERT ON inquiries
WHEN EXISTS (SELECT 1 FROM inquiries WHERE id = NEW.id OR ref = NEW.ref OR submission_id = NEW.submission_id)
BEGIN SELECT RAISE(ABORT, 'inquiries_no_replace'); END;

-- One upload. reserved -> stored -> linked, or failed (certainly no object) or deleting (an object may exist; cron retries).
-- The files row is created only at link, so nothing unsubmitted can ever be served.
CREATE TABLE inquiry_files (
  id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL REFERENCES inquiry_submissions (id),
  inquiry_id INTEGER REFERENCES inquiries (id),
  file_id INTEGER UNIQUE REFERENCES files (id),
  r2_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('artwork','po')),
  status TEXT NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved','stored','linked','failed','deleting')),
  bytes INTEGER NOT NULL CHECK (typeof(bytes) = 'integer' AND bytes > 0),
  mime TEXT,
  sha256 TEXT,
  filename TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_inquiry_files_submission ON inquiry_files (submission_id, status);
CREATE INDEX idx_inquiry_files_status ON inquiry_files (status);
CREATE TRIGGER inquiry_files_identity_fixed BEFORE UPDATE ON inquiry_files
WHEN NEW.id IS NOT OLD.id OR NEW.submission_id IS NOT OLD.submission_id OR NEW.r2_key IS NOT OLD.r2_key OR NEW.kind IS NOT OLD.kind OR NEW.bytes IS NOT OLD.bytes OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'inquiry_files_identity_fixed'); END;
-- A linked file belongs to a real inquiry: cleanup can't touch it, whatever a bug asks for. S3 adds its own way out for retention.
CREATE TRIGGER inquiry_files_linked_fixed BEFORE UPDATE ON inquiry_files
WHEN OLD.status = 'linked'
BEGIN SELECT RAISE(ABORT, 'inquiry_files_linked_fixed'); END;
CREATE TRIGGER inquiry_files_linked_no_delete BEFORE DELETE ON inquiry_files
WHEN OLD.status = 'linked'
BEGIN SELECT RAISE(ABORT, 'inquiry_files_linked_no_delete'); END;
CREATE TRIGGER inquiry_files_no_replace BEFORE INSERT ON inquiry_files
WHEN EXISTS (SELECT 1 FROM inquiry_files WHERE id = NEW.id OR r2_key = NEW.r2_key OR file_id = NEW.file_id)
BEGIN SELECT RAISE(ABORT, 'inquiry_files_no_replace'); END;

-- What each UTC day has admitted. Never refunded: it limits abuse, not storage (the outstanding-storage cap does that).
CREATE TABLE intake_usage (
  day TEXT PRIMARY KEY,
  sessions INTEGER NOT NULL DEFAULT 0,
  bytes INTEGER NOT NULL DEFAULT 0
);
