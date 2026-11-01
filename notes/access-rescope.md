# Access re-scope: rehearsal (S0c) and cut-over (S4)

Goal: the storefront is public while the dashboard stays private. Today the **whole** Worker is behind Access, which would lock customers out.

Sources: [Workers + Access](https://developers.cloudflare.com/workers/configuration/cloudflare-access/) and [application paths](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/), read 2026-11-01. Dashboard labels change, so trust the screen over this note.

## Facts

- **Hostnames:** `gocreative.idoggiebites.workers.dev` only. Preview URLs are off (`preview_urls: false`). No custom domain yet.
- Protecting "one Worker" covers every domain it has, so it can't stay on after the re-scope. A **self-hosted application** covers only the URL or path it names, and `workers.dev` is allowed. That settles the question access-setup.md left unverified.
- A wildcard doesn't include its parent, so `/app/*` leaves `/app` open. All four paths are needed: `/app`, `/app/*`, `/api/app`, `/api/app/*`.
- `/app` is a static shell, served without running the Worker, so only Access guards it. It holds no records or credentials. `/api/app/*` also re-verifies the JWT.

## S0c rehearsal (Arturo, about 10 minutes; nothing live changes)

Throwaway Worker: `https://gocreative-access-drill.idoggiebites.workers.dev`. No data, same routing as the real one.

1. Zero Trust → Access controls → Applications → create a **Self-hosted** application named `Access drill`.
2. Add four public hostnames, all on `gocreative-access-drill.idoggiebites.workers.dev`, with paths `app`, `app/*`, `api/app`, `api/app/*`.
3. Policy: the existing `GoCreative staff`. Session 24 hours. Create.
4. Tell Claude, who runs `node scripts/access-check.ts https://gocreative-access-drill.idoggiebites.workers.dev`.
5. Sign in on `/app` in a private window to confirm a staff email gets through.

**Reading the result:** every public path must be open, and `/app`, `/app/*`, `/api/app`, `/api/app/*` must be challenged. An odd spelling (`/APP`, `/%61pp`) that stays open is a finding to assess: acceptable only if it serves the empty shell or a Worker error, because the API re-verifies the JWT. It must be recorded either way.

Afterwards: delete the `Access drill` application, and Claude deletes the Worker.

## S4 cut-over (order matters)

The new application has a **new AUD**, and the Worker accepts exactly one (`ACCESS_AUD`). Doing this in the wrong order either locks staff out or leaves the dashboard open.

1. Backup first.
2. Create the real self-hosted application as above, on the live hostname. The old protection stays on.
3. Copy the new AUD, then `npx wrangler secret put ACCESS_AUD`. Staff may need to sign in again.
4. Remove "All traffic" protection from the Worker.
5. Immediately run `node scripts/access-check.ts https://gocreative.idoggiebites.workers.dev`, and sign in as staff.
6. **Rollback:** turn the Worker-wide protection back on and restore the old AUD.

This is an Access change, so it always needs Arturo's go. Any custom domain later needs the same four paths added, and the check run against it.
