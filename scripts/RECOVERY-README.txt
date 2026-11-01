GoCreative backup bundles

These .gcbk files are encrypted backups holding customer details. Without the
passphrase they cannot be read. The passphrase is not on this drive and must
never be stored with it.

OFFSITE MACHINE (Windows)
  1. Copy the newest .gcbk file, unbundle.mjs and this file to a folder there.
  2. Delete every .gcbk whose delete-after date has passed, on the machine and
     on the drive. The date is in the file name. This is a promise made to
     customers about how long backup copies exist.

TO RECOVER (only when the main Mac or the account is lost)
  You need Node.js 22 or newer (nodejs.org) and the passphrase.

  node unbundle.mjs gocreative-backup-....gcbk C:\gocreative-recovery

  That folder then holds the backup, its files and the deletion journal. It is
  not encrypted, so keep it private and delete it when finished. On a machine
  with the project (github.com/idoggiebites-oss/gocreative-platform), follow
  notes/backup-restore.md, "Restoring for real".
