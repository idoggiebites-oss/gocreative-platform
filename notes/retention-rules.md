# Retention rules (draft for Arturo's approval before launch)

Two separate things: how long the **business keeps a customer's data**, and how long **backup copies** of it survive.

| Data | Rule | State |
|---|---|---|
| Spam requests | Up to 30 days from receipt | Enforced by the daily cron |
| Requests that don't become an order | Up to 12 months from receipt | Enforced by the daily cron |
| Requests that become an order | Kept with the order's records | Decided; no end date set |
| Estimates and overrides | Go with their inquiry; kept with it after conversion | Enforced |
| Abandoned uploads | Removed after the session ends | Enforced by the daily cron |
| Audit trail | Counts and field names, no personal data; outlives the above | Enforced by what is written |
| **Backups** | **Eight weeks, provisional operational target (Arturo, 2026-11-02)** | **Not enforced: nothing deletes old backups on the Mac** |

## Before the privacy page can state a backup period
Eight weeks must be real first: a deletion step for `~/gocreative-backups/`, and bundles expiring in the same period. Until then the privacy page keeps its unconfirmed placeholder, and `npm run check:launch` keeps blocking on it. A restore can bring back a request deleted since that backup; the deletion journal replays those deletions (notes/backup-restore.md).

Open question for Arturo: whether order records ever expire.
