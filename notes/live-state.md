# What is live

Update this whenever something deploys. History is in git and ROADMAP.md; this is only the present.

- **Dashboard:** gocreative.idoggiebites.workers.dev, behind Cloudflare Access (reusable policy "GoCreative staff").
- **Worker version:** 93660340 (S0b).
- **Remote migrations applied:** 0001–0008. Never edit these.
- **Test data left in live on purpose:** customer "TEST – ignore" and cancelled order 2026-0001, so the next real order is 2026-0002.
- **Storefront:** not built. Mockups: https://claude.ai/artifact/CV2TZQvJGPwzhCVK4EwT4X
- **Backups:** `~/gocreative-backups/` on Arturo's Mac only. No off-machine copy yet. Latest: 2026-11-01T04-47-45-031Z. Run weekly by hand and before every remote migration.

## Open

- Signed-in smoke test after Arturo signs in again (the Access session expired).
- Suggested: Access cookie SameSite=Lax.
- Family read-through of the Spanish.
- Colour-contrast check not done.
