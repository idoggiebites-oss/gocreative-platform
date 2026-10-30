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

### 2026-10-30 — Models assigned per task by Claude; Codex writes and reviews (Arturo)
"Assign models for efficiency and use codex as well." Sonnet does the mechanical,
fully specified tasks. Opus is used for trust boundaries. Codex writes pure,
testable logic (task 1.3) and does a read-only review of every merged task. The
assignment is recorded in [ROADMAP.md](ROADMAP.md).

### 2026-10-30 — Orders, quotes and POs are never deleted; users are never deleted (Claude, from Codex review)
Orders end as `cancelled` or `completed`. Estimates, POs and PO documents are
`ON DELETE RESTRICT`. Users are deactivated with `active = 0`, because the
write-once `files` and `activity_log` rows reference them.

### 2026-10-30 — Phase 1 runs on workers.dev with the whole hostname behind Access (Claude)
There is no storefront until Phase 4, so nothing public is lost. Path-level
Access (only `/app` and `/api/app`) moves to the custom domain when the
storefront ships. See [notes/access-setup.md](notes/access-setup.md).

### 2026-10-30 — Phase 1 mockup approved (Arturo: "Mockups are good")
Source in `design/mockup/*.dc.html` (also at
https://claude.ai/artifact/SwwVcE6jJz2CSS37Hv9wnZ). The screens are built to it.

### 2026-10-30 — English/Spanish language toggle (Arturo)
Applies to the dashboard and the storefront. **How (Claude):** no i18n library.
`shared/i18n/en.ts` is the source of truth; `es.ts` is typed to the same shape,
so a missing translation fails `tsc`. Each enum gets a typed label record. Dates
and money go through `Intl`. The choice is stored per device (localStorage); a
first visit follows `navigator.language`; `<html lang>` follows the choice.
User-entered content is never translated. Customer emails (Phase 4) go out in
the language the inquiry was submitted in. The Spanish copy is written by Claude
and needs a read-through by a native speaker in the family.
