-- M6: payment terms lock at production complete (end of file), and artwork versions get the identity guards M3–M5 taught us (Codex, M3 review). Additive: triggers only.
-- artwork_version_fixed (0003) is `BEFORE UPDATE OF customer_id, lineage_id, version, file_id`, which an update through
-- a rowid alias never fires, so a version could be re-keyed; INSERT OR REPLACE on (lineage_id, version) or id would
-- silently delete a stored (possibly approved) version without any delete trigger firing; and nothing stopped a
-- DELETE. Quotes are already covered: quotes_frozen is an unconditional BEFORE UPDATE that refuses an id change, and
-- quotes_insert_draft_only refuses a REPLACE over a non-draft quote.

-- A version's id never changes, through id or any rowid alias.
CREATE TRIGGER artwork_id_fixed BEFORE UPDATE ON artwork
WHEN NEW.id IS NOT OLD.id
BEGIN SELECT RAISE(ABORT, 'artwork_version_fixed'); END;
-- A new version can't land on an existing id or (design, version): REPLACE would delete the stored one.
CREATE TRIGGER artwork_no_replace BEFORE INSERT ON artwork
WHEN EXISTS (SELECT 1 FROM artwork WHERE id = NEW.id OR (lineage_id = NEW.lineage_id AND version = NEW.version))
BEGIN SELECT RAISE(ABORT, 'artwork_version_exists'); END;
-- Versions are the approval history: never deleted.
CREATE TRIGGER artwork_no_delete BEFORE DELETE ON artwork
BEGIN SELECT RAISE(ABORT, 'artwork versions are never deleted'); END;

-- Payment terms are fixed once production is complete (Codex Phase 2 security review): otherwise switching an unpaid
-- pay-at-pickup order to pay-after-pickup would let it leave without the owner's audited release override. Before
-- that, relaxing the terms is owner-only (enforced by the route; the database can't see who is asking).
CREATE TRIGGER orders_payment_terms_fixed BEFORE UPDATE ON orders
WHEN NEW.payment_terms IS NOT OLD.payment_terms AND OLD.production_status = 'production_complete'
BEGIN SELECT RAISE(ABORT, 'payment_terms_locked'); END;
