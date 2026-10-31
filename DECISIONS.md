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

### 2026-10-30 — Spanish is for the dashboard only; the storefront stays English for now (Arturo)
Narrows the previous entry. The storefront has no toggle, and customer emails go
out in English, so there is no `inquiries.language` column. The i18n
dictionaries live in `shared/` so the storefront can adopt them later without
moving anything.

### 2026-10-30 — Public GitHub repo for now (Arturo)
Under `idoggiebites-oss`. Nothing secret is committed: `.dev.vars` is ignored,
the seed data is fictional, and the D1 id is a placeholder until deploy (a D1 id
is not a credential anyway). Secrets only ever go in `wrangler secret`.

### 2026-10-30 — Phase 1 is live behind Access (Arturo verified the sign-in)
A reusable Access policy, `GoCreative staff`, lists the two staff emails. It is
applied to the whole Worker (all traffic, 24-hour sessions). `ACCESS_AUD` and
`ACCESS_TEAM_DOMAIN` are Worker secrets. The remote DB holds sample orders for
the family to evaluate; they get wiped before real use (see ROADMAP).

### 2026-10-30 — The Phase 2 brief is authoritative (Arturo)
[SPEC-phase2.md](SPEC-phase2.md) replaces SPEC.md's Phase 2 and the plan drafted
earlier. It folds artwork uploads, PO documents and the production queue into
Phase 2. The plan, with 14 points awaiting Arturo's answers, is
[PHASE2_PLAN.md](PHASE2_PLAN.md). Nothing is built until those are answered.

### 2026-10-30 — Phase 2 plan approved, with corrections (Arturo)
All 14 decisions are in [PHASE2_PLAN.md](PHASE2_PLAN.md) §4. In short: shop time zone
America/Chicago; editable order items with frozen quote versions; only Draft
quotes are editable; both duplicate-quote and repeat-order; Awaiting Quote and
Awaiting Artwork added; fulfilment and financial closure tracked separately; "No
purchasing needed" with confirmation; every design's current version approved; a
collected check counts as a payment, with deposited and cleared tracked
separately; owner overrides need a reason and an audit row; one pickup per order;
progress in units, correctable; design review before UI; Production and Payments
pages added.

His corrections and the designs that answer them (Claude):
- Only customer-facing item fields trigger quote reapproval (§4.1).
- Production, fulfilment and financial tracks are independent (§4.2).
- One-active-job: a slot model capped at two by the database, where slot 2 needs
  an owner override (§4.3). This replaces the index idea, which allowed unlimited
  overrides.
- Check collection can't duplicate payments: a UNIQUE link, a guarded transition,
  and request ids (§4.4).
- Business dates are in shop time; timestamps stay UTC (§4.5).
- No wipe without explicit approval, a backup, and evidence that no real records
  exist (§4.6).

Authorised now: M0 only (rules, tests, concurrency design, design review). Not
yet: the wipe, destructive migrations, deploys. Codex reviews the rules and the
concurrency design before M1.

### 2026-10-30 — Phase 2 screens approved (Arturo: "Mock ups are good")
The six screens are Dashboard v2, Order workspace, New order, Customer,
Production and Payments, plus a Payments item in the sidebar. Source is in
`design/mockup/phase2/` (also at https://claude.ai/artifact/SwwVcE6jJz2CSS37Hv9wnZ,
"Phase 2 — for review" row). M1–M5 UI is built to them. They are static drafts:
drag-to-reorder, toggles and live totals are shown in one state and get their
real behaviour in the build.

### 2026-10-30 — Remote sample data wiped (Arturo: "go ahead with the wipe")
Done per PHASE2_PLAN §4.6: backup and evidence first, counts re-checked, users
kept. Details are in [notes/remote-sample-wipe.md](notes/remote-sample-wipe.md).
The live dashboard is empty until M1 lets staff create customers and orders.

### 2026-10-30 — M0 complete: Codex re-review verdict "M0 ready for M1"
The first review found 9 issues; all were fixed in 4fad2f6 (248 unit + 22 e2e
tests). The re-review confirmed each one. Its residual risks are assigned to
M1, M3/M4 and M5 in PHASE2_PLAN.md ("Carried forward from the M0 review").

### 2026-10-30 — M1a: migration 0002 and the Phase 2 vocabulary (Claude/agent, reviewed by Codex next)
- `order_items.product` and `method` are nullable. A CHECK keeps them required on
  product lines; charge and discount lines don't have them.
- A design = an artwork lineage on the order. Its current version is the highest
  version attached to that order.
- Production starts re-check the full gate in the UPDATE. QC and production
  complete are not re-gated (the M0 rule). Every move requires an active order.
- The PO re-derive still moves only `awaiting_*` orders. A `ready` order whose PO is
  revoked stays `ready`, and the start guard refuses it.
- Extra DB guards: quote total = subtotal + charges − discounts; an approved
  artwork version must record when, how and by whom; at most one accepted quote
  per order.
- Until M3, materials can only be satisfied by `materials_required = 0`.
- 0002 drops `estimates`, the stored `artwork_status` and `estimated_total_cents`
  without converting them. That's safe on the wiped remote (users only). Re-check
  the counts before `db:migrate:remote`, and migrate before deploying.

### 2026-10-30 — M1c: order, quote and authorization writes (agent; Codex reviews next)
- **Re-derive now includes `ready`.** One helper (`rederive()`) runs after every
  write that applied. When a prerequisite is lost, the order drops from `ready` to
  the right `awaiting_*`. It never moves `in_production` or later. This replaces
  M1a's "a ready order with a revoked PO stays ready".
- **Cancel** moves an in-production order to the re-derived pre-production status
  (it counts as the re-derive writer, so there are still only two writers of
  `production_status`). Once migration 0004 exists it also clears the slot.
- **Order numbers:** the counter upsert and the order INSERT run in one batch. A
  failed batch uses up no number. The first use creates the year's row.
- **Repeat order** copies PO, payment terms, the artwork flag and the contact from
  the source order, not from the customer's current defaults.
- **Duplicate quote** restores lines by position; internal notes don't come back.
- New quote versions, duplicates and item edits are refused once production has
  started.
- Optimistic concurrency uses an integer `version` on orders and customers. An
  `updated_at` token can lose updates within a millisecond (Codex review of M1b).
- Business dates (overdue, due this week, "today") use America/Chicago.
- An archived contact can't be put on an order (added at the M1b/M1c merge).

### 2026-10-30 — M1c review fixes (Codex review of cce1dc9)
- Every guarded order write requires the client's `expectedVersion`. The server
  never substitutes its own fresh read, so a form opened before a colleague's
  change gets 409 instead of overwriting it.
- A PO status change is an order write: it requires and bumps the order version,
  even when production status doesn't move.
- Repeat order refuses (409 `contact_archived`) when the source's contact is
  archived, so staff pick the contact deliberately; it is never dropped silently.
- A refused create or repeat uses up no order number. The counter upsert carries
  the same prerequisite as the INSERT (proven on workerd D1).
- Item replacement updates retained lines in place and inserts new lines last, so
  ids can't collide.
