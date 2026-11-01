# Backup and restore (plan; S0b builds and tests it)

> Status 2026-11-01: **plan only.** Arturo: backup and restore must be implemented **and tested** before the
> storefront goes public (STOREFRONT_PLAN §0.2). Nothing here exists yet. ARCHITECTURE.md said otherwise; that
> claim was corrected in the architecture review.

## What must be recoverable

| Asset | Where | Loss scenario |
|---|---|---|
| Business records (customers, orders, quotes, payments, activity…) | D1 `gocreative` | bad migration, operator error (a wrong `wrangler d1 execute`), app bug writing bad data, account problem |
| Uploaded files (artwork, PO documents, later inquiry uploads) | R2 `gocreative-files` | accidental delete, bucket misconfiguration, account problem |
| Configuration | git (code, migrations, `business.ts`), wrangler secrets, the Access application and policy | lost secrets, someone changing the Access policy in the dashboard |

## Three lines of defence

1. **D1 Time Travel** (built into D1, no cost). It gives point-in-time restore to any minute within the
   retention window. The window depends on the plan; the exact figure isn't verified for our account and
   must be checked in the dashboard (S0b). It is the first tool for "undo the last hour". Note: a restore
   rewinds the **whole** database.
2. **Scripted logical export** (`npm run backup`, to build):
   - For every table, in migration order, it reads all rows through `wrangler d1 execute --remote --json`
     (`SELECT *`, paged with `LIMIT`/`OFFSET` by primary key). It writes `backups/<UTC timestamp>/<table>.json`
     plus a `manifest.json` with row counts, the migration list from `d1_migrations`, the git commit and the
     Time Travel bookmark taken at the start (`wrangler d1 time-travel info`).
   - **Why not `wrangler d1 export --remote`:** on this account it failed with auth error 10000 (LEARNINGS,
     2026-10-31). The JSON route is the one that has worked here. If `export` starts working, it becomes an
     extra SQL dump, not a replacement.
   - **Where backups live:** **outside the public repository**: `~/gocreative-backups/` on Arturo's Mac (the
     directory already used for the pre-wipe backups), plus one copy somewhere off the machine (Arturo's
     choice: a private cloud drive or an external disk). They contain customer contact details, so they never go
     in git or in the public repo's CI.
   - **Schedule:** before every remote migration (the migration checklist already re-checks counts, and gains
     this step), and weekly. Cron automation on the Mac is optional; the Workers cron can't reach a private
     disk.
3. **R2 files**:
   - **Inventory.** `npm run backup` also writes `files.json`: every `files` row with key, size and SHA-256.
     The backup is checked against `wrangler r2 object list`, so a missing object or an orphan is visible.
   - **Copies.** `npm run backup:files` downloads any object not already in the local mirror,
     `~/gocreative-backups/files/<sha256>` (content-addressed, so each file is copied once). Files are
     write-once, so the mirror only ever grows.
   - **Cost.** R2 egress is free, so there are no costs beyond the operations.

## Restore drill (S0b must pass it before launch)

1. Take a backup of the live D1 and mirror R2.
2. Create a **scratch local D1** (`--local --persist-to <tmp>`), apply migrations 0001–00NN, and **load the
   JSON** in foreign-key order. The triggers that refuse deletes and updates don't block INSERTs. A load
   script, `scripts/restore.ts`, does this with the same order the seed uses.
3. **Verify:**
   - row counts match the manifest;
   - `tests/api/seed.test.ts`-style invariants hold (gate parity, payment balances, check statuses);
   - every `files` row's object exists in the mirror with a matching SHA-256.
4. Boot the app on the restored local D1 and the mirror (wrangler dev with a local R2 seeded from the mirror).
   Open the dashboard and an order with artwork.
5. Record the drill (date, backup used, counts, time taken) in this file.
6. **Time Travel drill:** on a throwaway remote D1 (created for the drill, deleted after), write rows, note a
   timestamp, change them, restore to the timestamp and verify. Never drill on the live database.

## Restoring for real (runbook outline)

- **Undo recent damage:** D1 Time Travel restore to just before the event, after taking a fresh backup first.
  Anything written after that point is lost, so check the activity log for what to re-enter.
- **Database gone or unusable:** create a new D1, apply migrations, load the latest JSON backup, point
  `wrangler.jsonc` at it, then deploy.
- **Files missing:** re-upload them from the mirror to the same keys (`wrangler r2 object put`).
- **Secrets or Access lost:** re-create them from `notes/access-setup.md`. Secrets are re-issued, not restored.

## Open points

- Time Travel retention on our plan: check in the dashboard.
- Arturo picks the off-machine copy location.
- Per business, when there are more: the same scripts take the deployment's names from the registry
  (SAAS_READINESS §2).
