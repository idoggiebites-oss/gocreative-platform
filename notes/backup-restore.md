# Backup and restore

> **Status 2026-10-31: built and drilled (S0b).** `npm run backup [-- pre-migration]` and `npm run restore -- <dir>`.
> "How it works now" and the drill record are the present truth. The plan below them is kept for its reasoning; where it differs, this section wins.

## How it works now

- **Backup:** sets the `maintenance` row in `settings`, which makes every non-GET under `/api` answer 503 (`worker/index.ts`). Waits 30 s for in-flight requests, exports every table by keyset, mirrors and re-hashes R2 files, fails if rows arrived meanwhile, writes `manifest.json` last, lifts the pause, expires old backups. About 75 s.
- **Stuck pause** (only after a crash that couldn't clean up; signals and errors clear it): `npx wrangler d1 execute gocreative --remote --command "DELETE FROM settings WHERE key = 'maintenance'"`.
- **Restore:** refuses the database bound in `wrangler.jsonc` and any non-empty target. Applies migrations to the backup's version, drops triggers in that target only (text read from its own `sqlite_schema`, so there is no list to go stale), loads in foreign-key order, restores triggers, checks every table's checksum, `foreign_key_check`, `quick_check` and mirror hashes, then applies newer migrations.
- **New cloud database:** `npx wrangler d1 create <name>`, then `npm run restore -- <dir> --database-id <id> --database-name <name>`. Local (no flags) also loads the files into local R2; to boot on it, use the command it prints, setting any flag before boot. Delete the scratch folder afterwards, including after a failed run: it holds customer data.
- **Time Travel:** 30 days on Workers Paid, 7 on Free (Cloudflare docs, 2026-10-31). Which plan this account is on is unverified, so assume 7.

- **Deletion journal (S3):** every inquiry deletion first writes `_journal/deletions/<time>-inquiry-<id>.json` to R2, holding ids, keys and hashes, no personal data. Backup copies new entries to `~/gocreative-backups/journal/` (listing through Cloudflare's API with wrangler's login, read-only). Restore replays every entry newer than the backup into the isolated database, so a deleted request stays deleted, and never puts those objects back. If the journal can't be refreshed, restore **stops**; `--accept-local-journal` overrides it, for when the account itself is lost. Newer migrations apply before the replay, so an older backup works.

## Restoring for real: the procedure

1. `npx wrangler d1 create gocreative-restore-<date>`, then `npm run restore -- ~/gocreative-backups/<backup> --database-id <id> --database-name gocreative-restore-<date>`. It refuses the database bound in `wrangler.jsonc` and any non-empty target.
2. Read its last line: tables, rows, triggers, files, deletions replayed. Anything other than "Restored and verified" means stop.
3. **Cut-over needs Arturo's go.** Set writes to maintenance, point `database_id` in `wrangler.jsonc` at the new database, `npm run deploy`, check the dashboard, then clear maintenance. Rollback is the old `database_id` and a deploy.
4. Missing files: `npx wrangler r2 object put gocreative-files/<key> --file ~/gocreative-backups/files/<sha256> --remote`, taking key and hash from the backup's `files.json`.
5. A bad deploy with no data damage needs none of this: `npx wrangler rollback`. Migration 0010 only adds, so the previous Worker keeps working on the migrated database.

## Not built, on purpose

- **R2 orphan check in the backup:** the daily cron reconciles objects under `inquiries/`; other prefixes are only ever written with their rows.
- **Restoring files to a cloud bucket:** manual, per the runbook below.
- **Weekly schedule:** run by hand until the off-machine location is chosen.
- **Off-machine copy:** Arturo's choice is open. Until then, losing this Mac loses the backups.

## Drill record

**2026-10-31**, backup `2026-11-01T04-47-45-031Z` (16 rows, 1 file, 23 tables, 52 triggers; took 74 s):

| Drill | Result |
|---|---|
| Restore into fresh local D1 | Verified, about 70 s |
| Boot on it (real workerd) | Dashboard and order 200; file bytes match the recorded SHA-256 |
| Maintenance under workerd | Flag on: POST 503, no row written, GET 200. Flag off: POST 201 |
| Restore into a throwaway cloud D1 | Verified, then deleted |
| Refusals | Live database id refused; non-empty target refused |
| Time Travel on the throwaway | Row changed, restored to bookmark, value back |

**2026-11-01**, after migration 0009: backup `2026-11-01T13-27-48-870Z` restored into local D1 and verified (26 tables, 17 rows, 62 triggers, 1 file).

**2026-11-01**, pre-migration rehearsal for S3: backup `2026-11-01T17-35-37-200Z` (at 0009, 79 s, journal empty).

| Drill | Result |
|---|---|
| Restore into a throwaway cloud D1, then 0010 applied | Verified: 26 tables, 17 rows, 65 triggers after 0010, no foreign key problems. Deleted afterwards |
| S3 code booted on a local restore | Dashboard, orders, customers, production and payments answer; artwork bytes match their SHA-256 |
| The deployed Worker's code (fa375e1) on the schema with 0010 | Its 315 API tests pass, so rolling the Worker back is safe |

**Limits of this evidence:** live data is one test order, so the historical states the plan lists (voided payments, superseded quotes, deposited checks) were proven only against seed data through `restoreSql` in `tests/api/backup.test.ts`, not through a real D1. That test's control shows the load fails with triggers on. Repeat the drill once real orders exist. The live 503 itself couldn't be exercised from outside, because Access answers first.

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
