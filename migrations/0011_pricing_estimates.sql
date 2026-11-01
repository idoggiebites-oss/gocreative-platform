-- E1: versioned pricing rules and preliminary estimates. Additive: three new tables, nothing existing changes. No rows, so no prices exist until the owner publishes real ones.
-- A preliminary estimate is never a quote: quotes keep their own tables and workflow, and nothing here touches them.
CREATE TABLE pricing_versions (
  id INTEGER PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','retired')),
  config TEXT NOT NULL CHECK (json_valid(config)),
  config_hash TEXT NOT NULL,
  rollback_of INTEGER REFERENCES pricing_versions (id),
  note TEXT,
  created_by INTEGER NOT NULL REFERENCES users (id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  published_by INTEGER REFERENCES users (id),
  published_at TEXT,
  CHECK (status = 'draft' OR (published_by IS NOT NULL AND published_at IS NOT NULL))
);
CREATE UNIQUE INDEX one_active_pricing ON pricing_versions (status) WHERE status = 'active';
CREATE UNIQUE INDEX one_draft_pricing ON pricing_versions (status) WHERE status = 'draft';
-- What was published stays exactly as published. Only active -> retired can happen afterwards.
CREATE TRIGGER pricing_published_fixed BEFORE UPDATE ON pricing_versions
WHEN OLD.status <> 'draft' AND (
  NEW.config IS NOT OLD.config OR NEW.config_hash IS NOT OLD.config_hash OR NEW.rollback_of IS NOT OLD.rollback_of OR NEW.created_by IS NOT OLD.created_by
  OR NEW.created_at IS NOT OLD.created_at OR NEW.published_by IS NOT OLD.published_by OR NEW.published_at IS NOT OLD.published_at OR NEW.note IS NOT OLD.note
  OR NOT (NEW.status = OLD.status OR (OLD.status = 'active' AND NEW.status = 'retired')))
BEGIN SELECT RAISE(ABORT, 'pricing_published_fixed'); END;
CREATE TRIGGER pricing_published_no_delete BEFORE DELETE ON pricing_versions
WHEN OLD.status <> 'draft'
BEGIN SELECT RAISE(ABORT, 'pricing_published_no_delete'); END;

CREATE TRIGGER pricing_no_replace BEFORE INSERT ON pricing_versions
WHEN EXISTS (SELECT 1 FROM pricing_versions WHERE id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'pricing_no_replace'); END;

-- One calculation, kept exactly as made. A later price change or a staff review adds a new row and never edits this one.
CREATE TABLE inquiry_estimates (
  id INTEGER PRIMARY KEY,
  inquiry_id INTEGER NOT NULL REFERENCES inquiries (id),
  pricing_version_id INTEGER REFERENCES pricing_versions (id), -- null: no pricing was active, so manual review
  engine_version INTEGER NOT NULL,
  analyzer_version INTEGER,
  status TEXT NOT NULL CHECK (status IN ('available','assumption_based','manual_review_required')),
  -- Who stands behind the artwork facts. The customer's browser is never trusted; only staff can make this 'staff_reviewed'.
  facts_source TEXT NOT NULL CHECK (facts_source IN ('none','customer_reported','staff_reviewed')),
  inputs TEXT NOT NULL CHECK (json_valid(inputs)),
  customer_result TEXT NOT NULL CHECK (json_valid(customer_result)),
  internal_result TEXT NOT NULL CHECK (json_valid(internal_result)), -- costs and margin: owner only
  created_by INTEGER REFERENCES users (id), -- null: the customer's own submission
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_estimates_inquiry ON inquiry_estimates (inquiry_id, id);
CREATE TRIGGER estimates_no_update BEFORE UPDATE ON inquiry_estimates
BEGIN SELECT RAISE(ABORT, 'estimates_no_update'); END;
CREATE TRIGGER estimates_no_replace BEFORE INSERT ON inquiry_estimates
WHEN EXISTS (SELECT 1 FROM inquiry_estimates WHERE id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'estimates_no_replace'); END;
CREATE TRIGGER estimates_only_with_claim BEFORE DELETE ON inquiry_estimates
WHEN NOT EXISTS (SELECT 1 FROM inquiries i WHERE i.id = OLD.inquiry_id AND i.deleting_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'estimates_only_with_claim'); END;

-- Staff corrections to an estimate's facts: what it was, what it became, why, who, when. A quote's own price changes through the quote workflow, not here.
CREATE TABLE estimate_overrides (
  id INTEGER PRIMARY KEY,
  estimate_id INTEGER NOT NULL REFERENCES inquiry_estimates (id),
  field TEXT NOT NULL,
  original TEXT,
  replacement TEXT,
  reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  actor_id INTEGER NOT NULL REFERENCES users (id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_estimate_overrides_estimate ON estimate_overrides (estimate_id);
CREATE TRIGGER estimate_overrides_no_replace BEFORE INSERT ON estimate_overrides
WHEN EXISTS (SELECT 1 FROM estimate_overrides WHERE id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'estimate_overrides_no_replace'); END;
CREATE TRIGGER estimate_overrides_no_update BEFORE UPDATE ON estimate_overrides
BEGIN SELECT RAISE(ABORT, 'estimate_overrides_no_update'); END;
CREATE TRIGGER estimate_overrides_only_with_claim BEFORE DELETE ON estimate_overrides
WHEN NOT EXISTS (SELECT 1 FROM inquiry_estimates e JOIN inquiries i ON i.id = e.inquiry_id WHERE e.id = OLD.estimate_id AND i.deleting_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'estimate_overrides_only_with_claim'); END;
