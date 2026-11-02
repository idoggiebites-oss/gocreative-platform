# What is live

Update this whenever something deploys. History is in git and ROADMAP.md; this is only the present.

- **Dashboard:** gocreative.idoggiebites.workers.dev, behind Cloudflare Access (reusable policy "GoCreative staff").
- **Worker version:** 6dee1793 (E3; includes S2, S3 and E2, all behind Access).
- **Remote migrations applied:** 0001–0012. Never edit these.
- **Test data left in live on purpose:** customer "TEST – ignore" and cancelled order 2026-0001, so the next real order is 2026-0002.
- **Public intake API:** deployed, but closed twice over: the Worker is still all behind Access, and the `intake_closed` row in `settings` refuses every public write. `TURNSTILE_SECRET` and `IP_HASH_SALT` aren't set; without them no session can open.
- **Storefront UI:** approved by Arturo, deployed behind Access; not public.
- **S3 (inquiry review and conversion):** live for signed-in staff. Retention and abandoned-upload cleanup run in the daily cron.
- **Backups:** `~/gocreative-backups/` on Arturo's Mac only. Offsite: encrypted bundles by USB to Arturo's Windows machine (`npm run backup:bundle`); first copy not made yet. Latest: 2026-11-02T00-43-47-825Z (pre-migration). Run weekly by hand and before every remote migration.

- **Throwaway:** Worker `gocreative-access-drill` (no data), public until the S0c rehearsal finishes, then delete it.

- **Pricing Management:** live for owners at Settings → Pricing Management. **No prices are published**, and customers can't see prices: `customerEstimates` is false in `shared/business.ts`, so the storefront says "Manual review required" even once rates are published.

## Needed before opening intake (S4)

1. Create the Turnstile widget (action `inquiry`, the real hostname), and set `TURNSTILE_SECRET` and a random `IP_HASH_SALT` with `wrangler secret put`.
2. Access re-scope (notes/access-rescope.md).
3. `npm run check:launch` must pass.
4. Remove the row: `npx wrangler d1 execute gocreative --remote --command "DELETE FROM settings WHERE key = 'intake_closed'"`. Adding it back is the emergency off switch; no deploy needed.

## Open

- Signed-in smoke test after Arturo signs in again (the Access session expired).
- Suggested: Access cookie SameSite=Lax.
- Family read-through of the Spanish.
- Colour contrast: checked 2026-11-01 on rendered dashboard text (about 128 views per viewport, seed data). One failure, fixed: order filter counts, 4.15:1. Not covered: disabled controls, hover and focus states, the storefront, and dialogs beyond the first add/record button on each view.
- The contrast fix (`OrderList.tsx`) is committed but not deployed; it goes out with the next deploy.
