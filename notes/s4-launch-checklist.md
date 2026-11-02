# S4 launch checklist

Present state only; update as items close. Intake, Access and customer prices change only on Arturo's explicit go.

## Rehearsal site

`https://gocreative-access-drill.idoggiebites.workers.dev`: the real code on its own database (`gocreative-drill`) and bucket (`gocreative-drill-files`), no cron, no customer data. Its pages are public but it can't accept requests: `intake_closed` is set and it has no `TURNSTILE_SECRET`. `/api/app/*` answers 500 because it has no Access settings, and holds nothing. Delete all three after S4: the Worker, the database, the bucket.

## Turnstile

Widget `GoCreative inquiry`, Managed, site key `0x4AAAAAAFv_TFYatdxiQDME`, hostnames: live and rehearsal. Remove the rehearsal hostname after S4. The first secret was exposed in a session screenshot and rotated the same day, without being used; the old one stopped working two hours later.

Set by a person, so the value never enters a session: `npx wrangler secret put TURNSTILE_SECRET --name gocreative-access-drill`, and at cut-over the same on `gocreative`. Production also needs `TURNSTILE_SITE_KEY` and a random `IP_HASH_SALT` at cut-over.

To test a real token on the rehearsal site: set the secret, remove its `intake_closed` row, send a request from a real browser and check the row, then add the row back.

## Access

**Blocked:** Zero Trust → Applications says "You need an active plan to continue", so the self-hosted application in notes/access-rescope.md can't be created. The Worker-wide protection and the `GoCreative staff` policy still work. Arturo chooses a plan; then the rehearsal, then the cut-over.

## Backup risk (offsite deferred by Arturo)

- **All backups are on one Mac, unencrypted there.** Losing it leaves only Cloudflare itself. Cloudflare's D1 Time Travel lasts 7 to 30 days depending on the plan, which is unverified, and doesn't cover R2 files or a lost account.
- **Runs by hand.** Weekly by intention, and before each migration; nothing reminds anyone. Today the database holds only test rows, so the risk starts when real requests arrive.
- **Restore is proven:** every pre-migration backup this session restored and verified, latest 2026-11-02T00-43-47-825Z. The encrypted USB tool exists; no offsite copy has been made.
- **The privacy page promises a backup period that isn't enforced.** Nothing deletes old backups on the Mac yet, so "[N weeks]" needs a number and a habit.
- Recommendation: one encrypted USB copy before the cut-over, which the backup note already suggests, then weekly backups once live. Arturo's call.
