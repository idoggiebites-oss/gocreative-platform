GoCreative backup bundles

These .gcbk files are encrypted backups holding customer details. Without the
passphrase they cannot be read. The passphrase is not on this drive and must
never be stored with it.

OFFSITE MACHINE (Windows), each time you bring the drive
  You need Node.js 22 or newer (nodejs.org). Open PowerShell in the folder.
  1. Copy the newest .gcbk file, unbundle.mjs and this file to a folder there.
  2. Check the copy on that machine:
       node unbundle.mjs --check "gocreative-backup-....gcbk"
     It must say OK. If not, keep the older copy and tell whoever made it.
  3. Delete every .gcbk whose delete-after date has passed, on the machine and
     on the drive. The date is in the file name. This is a promise made to
     customers about how long backup copies exist.

TO RECOVER (only when the main Mac or the account is lost)
  Restore looks in a folder named gocreative-backups in your home folder, so
  extract there. In PowerShell:

    node unbundle.mjs "gocreative-backup-....gcbk" "$HOME\gocreative-backups"

  It holds the backup, its files and the deletion journal, and is NOT
  encrypted: keep it private and delete it when finished.

  Then, with the project (github.com/idoggiebites-oss/gocreative-platform),
  follow notes/backup-restore.md, "Restoring for real". If the Cloudflare
  account itself is lost, add --accept-local-journal to the restore command so
  it uses the journal from this bundle.
