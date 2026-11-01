-- e2e only: empties public intake and opens it, on the throwaway local database. The guards are put back as they were.
DROP TRIGGER IF EXISTS inquiry_files_linked_no_delete;
DROP TRIGGER IF EXISTS submissions_no_delete;
DELETE FROM inquiry_files;
DELETE FROM inquiries;
DELETE FROM inquiry_submissions;
DELETE FROM intake_usage;
DELETE FROM settings WHERE key = 'intake_closed';
CREATE TRIGGER inquiry_files_linked_no_delete BEFORE DELETE ON inquiry_files
WHEN OLD.status = 'linked'
BEGIN SELECT RAISE(ABORT, 'inquiry_files_linked_no_delete'); END;
CREATE TRIGGER submissions_no_delete BEFORE DELETE ON inquiry_submissions
WHEN OLD.status <> 'expiring'
BEGIN SELECT RAISE(ABORT, 'submissions_no_delete'); END;
