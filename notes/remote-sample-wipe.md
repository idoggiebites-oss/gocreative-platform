# Wiping the remote sample data (PHASE2_PLAN §4.6)

**Status:** wiped 2026-10-30 after Arturo's explicit go ("go ahead with the wipe").

## Backup taken (2026-10-30, 19:56 CT)

- **D1 Time Travel bookmark:** `00000003-00000000-00005115-a5803576333a3c50bde665de1e649e5b`.
  Restore with `npx wrangler d1 time-travel restore gocreative --bookmark=<that>`.
  Free-plan retention is 7 days.
- **Row dump:** one JSON file per table in `~/gocreative-backups/remote-20261030-195627/`
  (outside the repo, because it contains the staff emails). `wrangler d1 export --remote`
  fails with "Authentication error [code: 10000]": the wrangler OAuth login lacks the
  export permission. The per-table `SELECT *` dump is the fallback; the schema itself is
  in `migrations/`.

## Evidence that nothing real is in it

| Table | Rows | Check |
|---|---|---|
| users | 2 | ids 1 and 2 = the two staff emails (keep both) |
| customers | 8 | 8 of 8 names appear in `scripts/seed.sql` |
| orders | 24 | 24 of 24 numbers appear in the seed |
| activity_log | 40 | only `created` (24) + `production_status` (16) rows from the seed; newest is the seed run itself (2026-10-30 23:46 UTC); nothing written by a user since |
| inquiries, files, artwork, po_documents | 0 | — |

## The wipe, when approved

Re-check the counts first (a row created after this note means real use began), then
delete every table except `users`, children before parents, in one `--file` run, with
the `activity_log_no_delete` trigger dropped and recreated around its delete (as
`scripts/seed.sql` does). Then reset `counters`.

## Done (2026-10-30)

Counts were re-checked just before the wipe and were identical to the evidence (2/8/24/40,
newest row = the seed run). One `--file` run, 15 statements, `success: true`. After:
users 2, every other table 0, `counters` empty. All three `activity_log` triggers are present
(`no_update`, `no_replace`, `no_delete`). Live `/app` still redirects anonymous visitors to
Access.

`counters` is empty on purpose: the M1 order-creation write must create the year's
row on first use (INSERT … ON CONFLICT DO UPDATE … RETURNING), not assume it exists.
