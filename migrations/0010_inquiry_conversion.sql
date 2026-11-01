-- S3: converting and deleting inquiries. Additive: new columns, one index and replaced guards. No table is rebuilt and no row changes.
-- One order per inquiry, enforced by the database. orders gets no inquiry_id: inquiries.order_id already links them, and a second
-- foreign key the other way would make a cycle that a restore can't order.
CREATE UNIQUE INDEX one_inquiry_per_order ON inquiries (order_id) WHERE order_id IS NOT NULL;

-- Where the conversion batch keeps the customer and contact it chose or created, for its later statements to read.
ALTER TABLE inquiries ADD COLUMN converted_customer_id INTEGER REFERENCES customers (id);
ALTER TABLE inquiries ADD COLUMN converted_contact_id INTEGER REFERENCES customer_contacts (id);
-- Set when a deletion claims the inquiry: from then on it can't be converted, and it leaves the queue.
ALTER TABLE inquiries ADD COLUMN deleting_at TEXT;

-- A converted inquiry is the record of what the customer sent: it never changes and is never deleted.
CREATE TRIGGER inquiries_converted_frozen BEFORE UPDATE ON inquiries
WHEN OLD.status = 'converted'
BEGIN SELECT RAISE(ABORT, 'inquiries_converted_frozen'); END;
CREATE TRIGGER inquiries_claimed_only_delete BEFORE DELETE ON inquiries
WHEN OLD.deleting_at IS NULL OR OLD.status = 'converted'
BEGIN SELECT RAISE(ABORT, 'inquiries_claimed_only_delete'); END;
CREATE TRIGGER inquiries_claim_is_final BEFORE UPDATE ON inquiries
WHEN OLD.deleting_at IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'inquiries_claim_is_final'); END;

-- A linked file moves only for its claimed, unconverted inquiry. Everything else about it stays fixed.
DROP TRIGGER inquiry_files_linked_fixed;
CREATE TRIGGER inquiry_files_linked_fixed BEFORE UPDATE ON inquiry_files
WHEN OLD.status = 'linked' AND NOT (
  NEW.status = 'deleting' AND NEW.inquiry_id IS OLD.inquiry_id AND NEW.file_id IS OLD.file_id
  AND EXISTS (SELECT 1 FROM inquiries i WHERE i.id = OLD.inquiry_id AND i.deleting_at IS NOT NULL AND i.status <> 'converted')
)
BEGIN SELECT RAISE(ABORT, 'inquiry_files_linked_fixed'); END;

-- A submitted session goes only after its inquiry has.
DROP TRIGGER submissions_no_delete;
CREATE TRIGGER submissions_no_delete BEFORE DELETE ON inquiry_submissions
WHEN OLD.status <> 'expiring' AND EXISTS (SELECT 1 FROM inquiries i WHERE i.submission_id = OLD.id)
BEGIN SELECT RAISE(ABORT, 'submissions_no_delete'); END;
