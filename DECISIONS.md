# Decisions

Append-only. Every entry is dated and says who decided and why. A later entry
supersedes an earlier one; don't edit old entries.

### 2026-10-30 — Architecture approved with the answers below (Arturo)
Proposal reviewed. Its content now lives in [ARCHITECTURE.md](ARCHITECTURE.md),
[DESIGN_SYSTEM.md](DESIGN_SYSTEM.md) and [ROADMAP.md](ROADMAP.md).

### 2026-10-30 — This is a base platform; GoCreative Designs is the first business (Arturo)
The app is meant to be adapted for other small businesses later. **How (Claude):**
one codebase with one deployment per business. Business-specific values live in
`shared/business.ts` plus brand tokens. Each business has its own Worker, D1 and
R2; there are no tenant IDs and nothing is shared. **Why:** customer data stays
isolated by construction, and fixes reach every business. This is cheaper than
SaaS multi-tenancy, which SPEC §11 excludes.

### 2026-10-30 — Employee login via Cloudflare Access (Arturo: "employee log in is fine")
Read as accepting the recommendation. Access is free for ≤50 users and uses an
email one-time code. The Worker still verifies the Access JWT and looks the email
up in `users` for the role. **Why:** no password storage, no reset flow, and MFA
and session expiry come for free.

### 2026-10-30 — Production tracked per order, not per item (Arturo)
One `production_status` on the order. There is no `production_steps` table; stage
history is in `activity_log`.

### 2026-10-30 — Two users for GoCreative (Arturo)
Both seeded with role `owner`. The `owner|staff` role split stays in the schema
because other businesses on the platform will need it.

### 2026-10-30 — Customer email updates are in v1 (Arturo)
Cloudflare Email Service sends two messages: inquiry received, and ready for
pickup/delivery. **Blocker:** sending needs a domain on Cloudflare, and GoCreative
has no website or domain. Phases 1–3 don't need one; the domain is needed by
Phase 4. The domain also becomes the storefront's address. Until then the app
runs on `*.workers.dev`.
