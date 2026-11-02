# S4 launch checklist

Present state only; update as items close. Intake, Access and customer prices change only on Arturo's explicit go.

## Rehearsal site

`https://gocreative-access-drill.idoggiebites.workers.dev`: the real code on its own database (`gocreative-drill`) and bucket (`gocreative-drill-files`), no cron, no customer data. Its pages are public but it can't accept requests: `intake_closed` is set and it has no `TURNSTILE_SECRET`. `/app` and `/api/app` are behind the `Access drill` application, with the same staff emails as production. Delete all three after S4: the Worker, the database, the bucket.

## Rehearsal result (2026-11-02, closed again)

Real Turnstile tokens passed on Arturo's real phone and Mac; a fake token was refused. Upload, submit, staff re-analysis, audited override, conversion and the verified and unverified labels all worked on real Cloudflare. Automated Chrome could not pass Turnstile, by design, and wasn't pushed. A submit retry on the live network was not run: tests on real local D1 cover it. Rehearsal orders 2026-0001 and 2026-0002 and their files are test data, gone when the rehearsal site is deleted.

## Turnstile

Widget `GoCreative inquiry`, Managed, site key `0x4AAAAAAFv_TFYatdxiQDME`, hostnames: live and rehearsal. Remove the rehearsal hostname after S4. The first secret was exposed in a session screenshot and rotated the same day, without being used; the old one stopped working two hours later.

Set by a person in a separate Terminal, not with the `!` prefix, which saves an empty value: done on the rehearsal site; at cut-over the same on `gocreative`. Production also needs `TURNSTILE_SITE_KEY` and a random `IP_HASH_SALT` at cut-over.

Reopening the rehearsal site needs only its `intake_closed` row removed; put it back afterwards. Its config isn't in the repo: pass `-c` with a config naming `gocreative-drill`.

## Access

Zero Trust Free activated by Arturo 2026-11-02. Rehearsal application `Access drill` created with the four paths and `GoCreative staff`; `scripts/access-check.ts` passed all 27 paths. Signing in on the rehearsal site still to be proved. The production cut-over needs Arturo's explicit go.

## Access: plan steps

Done: Zero Trust Free, $0 per seat, 50-seat limit, activated by Arturo. Checkout authorizes charging the card on file for usage beyond the free limits.

## Content blockers (`npm run check:launch`, 9)

Address; phone; email; hours; placeholder photos; photo component labels; privacy draft notice; privacy backup period; services confirmation.

- The rehearsal site still runs the older form and analyzer; redeploy before any further device test (config is not in the repo).

## Before the first real customer submission

- A verified encrypted off-machine backup and a recovery procedure (Arturo, 2026-11-02; not interrupting S4 testing).
- Backup deletion that makes the eight-week target real, and retention rules approved: notes/retention-rules.md.
- Wording reviewed: notes/disclosures-for-review.md.

## Backup risk (offsite deferred by Arturo)

- **All backups are on one Mac, unencrypted there.** Losing it leaves only Cloudflare itself. Cloudflare's D1 Time Travel lasts 7 to 30 days depending on the plan, which is unverified, and doesn't cover R2 files or a lost account.
- **Runs by hand.** Weekly by intention, and before each migration; nothing reminds anyone. Today the database holds only test rows, so the risk starts when real requests arrive.
- **Restore is proven:** every pre-migration backup this session restored and verified, latest 2026-11-02T00-43-47-825Z. The encrypted USB tool exists; no offsite copy has been made.
- **Eight weeks is a provisional target, not yet enforced or published.** Nothing deletes old backups on the Mac yet.
