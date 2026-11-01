# Cloudflare Access setup

## What is live (verified 2026-10-30)

Phase 1 runs on `gocreative.idoggiebites.workers.dev` with the WHOLE hostname
behind Access (no storefront until Phase 4). It was set up like this, and it works:

1. Zero Trust → Access controls → **Policies** → Add a policy: name
   `GoCreative staff`, action Allow, Include → **Emails** → the two staff emails.
   (The Worker's own Access dialog only offers "Cloudflare account" and "Email
   domain" presets; "Email domain" on gmail.com would admit every Gmail user, so
   a reusable policy listing exact emails is required.)
2. Workers & Pages → gocreative → **Access** tab → Protect this Worker behind
   Access → Scope **All traffic** → policy `GoCreative staff` → session 24 hours
   → Apply. This also covers preview URLs.
3. That page then shows the **AUD tag** and the JWKS URL
   (`https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`). Set both on the
   Worker as secrets: `wrangler secret put ACCESS_AUD` and
   `wrangler secret put ACCESS_TEAM_DOMAIN` (value `<team>.cloudflareaccess.com`).
   No redeploy needed.
4. Check: anonymous `curl -I` on `/`, `/app` and `/api/app/me` gives a 302 to
   the Access login page; signing in with an allowed email reaches the dashboard.

Login is email one-time PIN (the default when no other identity provider is
configured). The login page header shows the Zero Trust team name, set under
Zero Trust → Settings.

Adding or removing staff means editing the `GoCreative staff` policy AND the
`users` table (the Worker takes the role from `users`; Access alone is not enough).

---

## Reference: path-level setup for when the storefront ships (Phase 4)

> Superseded for `workers.dev` by [access-rescope.md](access-rescope.md): Cloudflare's docs now confirm a path works there too.


Employees log in through Cloudflare Access (email one-time PIN). Access guards
`/app/*` (the dashboard) and `/api/app/*` (the employee API). The Worker does not
trust Access blindly: `worker/auth.ts` re-verifies the `Cf-Access-Jwt-Assertion`
JWT (RS256, `aud`, `iss`, `exp`) and then looks the email up in `users` for the
role. A misconfigured Access policy therefore cannot open the API.

**Must stay public (never behind Access):** `/`, the storefront (`/services/*`,
`/inquire`), static assets, `/api/public/*` and `/api/health`. Covering the whole
hostname with one Access application would lock customers out.

Facts checked against Cloudflare docs on 2026-10-30 are unmarked. Anything marked
**(unverified)** was not confirmed in the docs; check it in the dashboard.

## 1. Turn on One-time PIN

Zero Trust → **Integrations** → **Identity providers** → add new → **One-time PIN**.
Access only emails a PIN to an address that some Access policy allows.

## 2. Create the self-hosted Access application

1. Zero Trust → **Access controls** → **Applications** → **Create new application**
   → **Self-hosted and private**.
2. Name it after the business's dashboard. **(unverified: the name field's position)**
3. **Add public hostname** four times, on the same hostname:
   - path `app` and path `app/*`
   - path `api/app` and path `api/app/*`

   A wildcard path does NOT cover its parent: `app/*` leaves `/app` itself open
   (Cloudflare app-paths docs; found by Codex review, 2026-10-30). After setup,
   open `/app`, `/app/orders`, `/api/app` and `/api/app/me` in a private window and
   confirm each one asks for a PIN.

   **(unverified: the docs page mentions hostnames and wildcards but not the path
   field or several destinations per app.)** Keep both paths in ONE application:
   the Worker checks a single `ACCESS_AUD`, and two apps would issue tokens with
   two different AUD tags.
4. Hostname choice:
   - **Custom domain (recommended).** The domain picker only lists active zones in
     the account, so this needs the business domain on Cloudflare (DECISIONS: the
     domain is needed by Phase 4 anyway). Route the Worker to it first.
   - **`*.workers.dev`.** Cloudflare can protect a Worker's `workers.dev` URL from
     the Worker's settings, but the docs don't say whether that can be limited to
     paths. **(unverified)** If it can only cover the whole hostname, do NOT use it:
     it would put the storefront behind Access. **For Phase 1–3 that is fine:**
     there is no storefront until Phase 4, so the whole workers.dev hostname can
     sit behind Access and only the family can open anything. Switch to path-level
     protection on the custom domain when the storefront ships.
5. **Identity providers:** select One-time PIN only. Optionally turn on
   **Apply instant authentication**, since it is the only IdP.
6. **Session duration:** pick one (for example 24 hours). Not decided in DECISIONS.
7. **Access policies:** create a policy, action **Allow**, include **Emails**: the
   staff emails. Applications deny by default, so anyone not matched is refused.
   **(unverified: exact field labels for the Emails selector)**
8. **Create**.

## 3. Give the Worker the AUD tag and team domain

- **AUD:** Access controls → Applications → your app → **Configure** →
  **Additional settings** → copy **Application Audience (AUD) Tag**.
- **Team domain:** `<team-name>.cloudflareaccess.com`. The JWT issuer is
  `https://<team-name>.cloudflareaccess.com` and the keys are at
  `https://<team-name>.cloudflareaccess.com/cdn-cgi/access/certs`. The team name is
  shown under Zero Trust → **Settings** **(unverified: exact location)**.

Set them on the Worker (neither is secret, but secrets keep them out of the repo,
which matters because each business has its own deployment):

```sh
npx wrangler secret put ACCESS_AUD           # paste the AUD tag
npx wrangler secret put ACCESS_TEAM_DOMAIN   # e.g. myteam.cloudflareaccess.com, no https://
```

Until both are set, every `/api/app/*` request returns
`500 {"error":"auth_not_configured"}`. That is deliberate: missing config fails
closed.

**Never set `DEV_AUTH_EMAIL` in production.** It is honoured only when the request
host is `localhost`/`127.0.0.1`, but it belongs in `.dev.vars` alone.

## 4. Add the people to `users`

Access says who someone is; `users` says what they may do. Each allowed email
needs an active row (`role` `owner` or `staff`). Email matching is
case-insensitive. Someone allowed by Access but missing from `users`, or with
`active = 0`, gets `403 {"error":"forbidden"}`.

## 5. Check it

1. Open `/` in a private window: the storefront loads with no login.
2. Open `/app`: Access asks for an email and sends a PIN.
3. After login, `/api/app/me` returns your `{id, email, name, role}`.
4. `curl https://<host>/api/app/me` with no cookie: Access blocks it before the
   Worker. If it ever reaches the Worker, the Worker answers 401.

## Key rotation

Access rotates its signing key every 6 weeks by default and keeps the previous key
valid for 7 days. The Worker caches the keys for 5 minutes and refetches once when
a token carries an unknown `kid`, so rotation needs no action.

## Local dev

Copy `.dev.vars.example` to `.dev.vars`. It sets
`DEV_AUTH_EMAIL=owner1@example.com`, which stands in for Access on localhost; the
email must exist in local D1 (`npm run db:migrate && npm run db:seed`).
