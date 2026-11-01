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

## Revisions after Codex's review (2026-11-01). These override the sections above where they differ.

1. **A consistent snapshot, not a moving read.** Backups run in a **maintenance window**. A `maintenance` setting
   (checked by every write route, public and staff, plus the cron) makes writes return 503 "back in a few
   minutes". The script switches it on, waits for in-flight requests to finish, exports, mirrors the files,
   verifies, and switches it off. It runs after hours (a family shop with two staff can take a 2-minute pause).
   Pagination is by **primary key (keyset), never OFFSET**. Each table file carries its row count and SHA-256,
   and `manifest.json` is written last as the completion marker; no manifest means an incomplete backup. A Time
   Travel restore rewinds the live database itself, so it is not a way to get a snapshot copy. (A point-in-time
   copy to a separate database isn't a verified workflow on this account.)
2. **Restores never fight the triggers, and never touch the live database.** Restore always goes into a **new,
   isolated D1**:
   1. apply migrations **up to the backup's recorded version**;
   2. **drop the inventoried triggers in that target only** (`scripts/restore.ts` keeps the list: quotes and
      quote items, payments, checks, production slots, pickups, artwork, activity, purchases);
   3. load rows in foreign-key order;
   4. recreate the triggers from the same migration text;
   5. run `PRAGMA foreign_key_check` and `integrity_check`, and compare row counts and checksums and the audit
      row count;
   6. apply any newer migrations.

   Live triggers are never weakened. The drill covers historical states: an inactive override owner, voided
   payments, accepted and superseded quotes, cancelled orders, and collected, deposited and cleared checks.
3. **Backups expire, so deletion promises hold.**
   - Keep the last **8 weekly** backups plus the pre-migration ones from the last 90 days; older ones are
     deleted, including the off-machine copy.
   - The file mirror is garbage-collected: an object referenced by no retained backup's `files.json` is
     deleted.
   - Every retention or owner deletion writes a **deletion journal entry** (record ids, file SHA-256 and the
     time; no personal data). The journal lives **outside D1**, so restoring an older database can't lose it.
     Each event is its own write-once R2 object under `_journal/deletions/<UTC time>-<uuid>.json`, written
     before the D1 rows are removed. The backup script copies the journal to the off-machine location too, so
     it survives losing the account. **Restore replays every journal entry newer than the backup into the
     isolated database before cut-over**, then re-validates.
   - The privacy text states active-system retention, plus "backup copies expire within [N] weeks". N is to
     be confirmed with the legal check (STOREFRONT_PLAN §0.7).
4. **Recovery inventory.**
   - `files.json` holds key, size, SHA-256 and content type for every object. A backup is "complete" only
     after every mirrored file's hash is verified.
   - Restores go to the **original keys**, then a test confirms the bucket is still private.
   - Secrets (Access AUD and team, the future Turnstile secret and IP-hash salt) are listed in a private
     recovery sheet kept **outside the Cloudflare account**, with steps to recreate or rotate each one.
   - Cut-over: restore into a replacement D1, validate, then switch the binding under maintenance. Rollback
     means switching back.
   - Targets to agree with Arturo: how much data could be lost (proposal: at most 1 week, or 1 day once
     daily backups run) and how long recovery may take (proposal: same business day).

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
