-- M2a: artwork uploads, approvals and PO documents. Additive only: the live D1 holds real rows, so no table is
-- rebuilt. ADD COLUMN fires no trigger, so files stays write-once (files_write_once still refuses every UPDATE).

-- The uploader's file name, sanitised (worker/files.ts sanitizeFilename). Shown in the UI and used for
-- Content-Disposition only; the R2 key is never derived from it. NULL for rows from before 0003.
ALTER TABLE files ADD COLUMN filename TEXT CHECK (filename IS NULL OR length(filename) BETWEEN 1 AND 200);

-- A design's name, copied onto each of its versions (a new version takes the previous one's). Optional.
ALTER TABLE artwork ADD COLUMN design_name TEXT CHECK (design_name IS NULL OR length(design_name) BETWEEN 1 AND 200);

-- A version is one file: once inserted, which design, version, file and customer it is never changes. Only the
-- approval columns, notes and (via ON DELETE SET NULL, which never happens: orders aren't deleted) order_id move.
CREATE TRIGGER artwork_version_fixed BEFORE UPDATE OF customer_id, lineage_id, version, file_id ON artwork
WHEN NEW.customer_id IS NOT OLD.customer_id OR NEW.lineage_id IS NOT OLD.lineage_id OR NEW.version IS NOT OLD.version OR NEW.file_id IS NOT OLD.file_id
BEGIN SELECT RAISE(ABORT, 'artwork_version_fixed'); END;

-- A corrected PO document is a new document, never a replacement.
CREATE TRIGGER po_documents_write_once BEFORE UPDATE ON po_documents
BEGIN SELECT RAISE(ABORT, 'po_documents are write-once'); END;

-- GET /api/app/files/:id serves a file only when an artwork version or a PO document links it to an order.
CREATE INDEX idx_artwork_file ON artwork (file_id);
CREATE INDEX idx_po_documents_file ON po_documents (file_id);
