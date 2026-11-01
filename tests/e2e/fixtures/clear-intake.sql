-- e2e only: empties public intake and opens it, on the throwaway local database. The guards are put back as they were.
DROP TRIGGER IF EXISTS inquiry_files_linked_no_delete;
DROP TRIGGER IF EXISTS submissions_no_delete;
DROP TRIGGER IF EXISTS inquiries_claimed_only_delete;
DROP TRIGGER IF EXISTS inquiries_converted_frozen;
DELETE FROM inquiry_files;
UPDATE inquiries SET converted_customer_id = NULL, converted_contact_id = NULL;
DELETE FROM inquiries;
DELETE FROM inquiry_submissions;
DELETE FROM intake_usage;
DELETE FROM settings WHERE key = 'intake_closed';
CREATE TRIGGER inquiry_files_linked_no_delete BEFORE DELETE ON inquiry_files
WHEN OLD.status = 'linked'
BEGIN SELECT RAISE(ABORT, 'inquiry_files_linked_no_delete'); END;
CREATE TRIGGER submissions_no_delete BEFORE DELETE ON inquiry_submissions
WHEN OLD.status <> 'expiring' AND EXISTS (SELECT 1 FROM inquiries i WHERE i.submission_id = OLD.id)
BEGIN SELECT RAISE(ABORT, 'submissions_no_delete'); END;
CREATE TRIGGER inquiries_converted_frozen BEFORE UPDATE ON inquiries
WHEN OLD.status = 'converted'
BEGIN SELECT RAISE(ABORT, 'inquiries_converted_frozen'); END;
CREATE TRIGGER inquiries_claimed_only_delete BEFORE DELETE ON inquiries
WHEN OLD.deleting_at IS NULL OR OLD.status = 'converted'
BEGIN SELECT RAISE(ABORT, 'inquiries_claimed_only_delete'); END;
