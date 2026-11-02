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

### 2026-10-30 — Production changes need the page's version; notes and repeat don't (Codex re-review of M1c)
- **Production PATCH requires `expectedVersion`.** It is checked in the route and
  inside the UPDATE, and the new version is returned. An old page can no longer
  advance production after a colleague's change.
- **Adding a note does not take or bump the version** (declining that Codex
  finding). Notes are append-only comments and change no order state. Bumping
  the version would refuse every colleague's open form whenever someone left a
  comment, so there is no lost update to prevent.
- **Repeat order does not take the source's version** (declining that finding).
  The source isn't modified beyond an activity row. The new order has no quote,
  so its starting status is always `awaiting_quote`, whatever flags it copied.

### 2026-10-31 — Forms keep the version they started from; contacts get a version (Codex review of the M1 screens; Claude)
- **An edit form captures its field values and the version together when editing starts**
  (`useEditSession`) and sends that version. A background refetch can't change it. After a
  409 `conflict_retry` the stale values are replaced by the fresh ones, the translated notice shows,
  and Save stays disabled until they have been reloaded. Dialogs capture the version at open.
- **`customer_contacts.version`** (added inside 0002, which isn't applied remotely yet). PATCH, archive
  and unarchive require `expectedVersion`; the guard is in the UPDATE, including the primary-promotion
  demote. A stale version is 409 `conflict_retry` with nothing logged. Demoting the old primary does not
  bump that contact's version (its fields didn't change).
- **New order:** editing the customer text un-chooses the customer; Save is disabled until one is picked.
- **Quote rules in one place:** `quoteActionsOpen` and `acceptBlockCode` live in `worker/domain/quotes.ts`.
- **Copy:** authorization and quote-decision sentences are whole strings per method/status, typed so a missing key fails tsc.

### 2026-10-31 — M1 live (Arturo: "Yes migrate and deploy")
Re-checked first: the remote held only the 2 users. Migration 0002 was applied
remotely (quotes and quote_items present, estimates gone, 14 triggers, the new
order columns), then the Worker was deployed (version d163d17c). Anonymous and
forged-token requests to every page and API route still redirect to Access.
Signed in, the new Customers page renders. The database is empty, ready for real
customers and orders. From now on every migration must preserve data: 0002 may no
longer be edited, and changes go in 0003+.

### 2026-10-31 — M2 scope calls (Claude; Arturo can overturn)
- **Artwork previews are the browser's own:** PNG, JPEG and SVG (as `<img>`)
  inline, PDF in the browser viewer, TIFF in Safari only; elsewhere a file card
  with download. No thumbnail generation, no image libraries. The brief says
  previews "where supported"; thumbnails can be added if the family wants them.
- **M2 adds PO creation** (number and amount, editable) next to PO documents.
  Before this, the app could only change the status of a PO that already existed.
- From M2 on, schema changes are new additive migrations (0003+) that preserve
  the live data.

### 2026-10-31 — M2a: artwork, file and PO-document API (agent; Codex security review next)
- **Previews are native only:** PNG/JPEG, SVG as `<img>`, PDF in the browser's viewer, TIFF in Safari. No
  thumbnail generation, no new libraries (replaces ARCHITECTURE's utif2 / pdf.js plan). Files are write-once.
- **Uploads are the raw body**, not multipart: `Content-Type` = declared type, `X-Filename` = the URI-encoded
  name, other fields as query parameters. One copy of the file in memory instead of two, which matters at the
  50 MB cap under the Worker's 128 MB. Content-Length over the cap is refused before reading; without one, the
  read stops at the cap.
- **Type by magic bytes** (PNG, JPEG, TIFF, PDF; SVG = UTF-8 text whose first element after the prolog,
  comments and a plain DOCTYPE is `<svg>`). The declared type must match; the sniffed one is stored. PO
  documents refuse SVG.
- **R2 first, then one D1 batch** (files row + artwork / po_documents row + version bump + activity + re-derive).
  A batch that throws or applies nothing (stale version) deletes the R2 object, best effort. A failed delete
  leaves an object no row names, which nothing can serve.
- **Downloads** (`/api/app/files/:id`) serve only files an artwork version or PO document links to an order,
  with nosniff, a sandbox CSP and `private, max-age=0`; SVG always as an attachment (`<img>` still renders it).
- **A design's name** is `artwork.design_name`, copied to each new version (migration 0003, additive). A new
  version starts under review. Only a design's current version can be decided; a decision can be reversed
  (approved ⇄ changes requested), and changes requested clears the approval fields. Approval notes are stored
  on the version and never copied into the activity log.
- **Migration numbering:** M2a took 0003, so M3–M5's migrations become 0004–0006.

### 2026-10-31 — PO corrections and replacements; streamed uploads (Claude, from Codex's M2a security review; Arturo can overturn)
- **An approved PO is read-only.** Its number and amount can't be edited (409
  `po_approved_locked`). A correction is a new PO.
- **A new PO while the latest one is approved is refused** unless it is an
  explicit replacement with a reason (`replaceApproved` + `reason`), recorded as
  `po_replaced`. The order then needs the new PO approved before production. This
  is conservative; if GoCreative's districts routinely issue a second PO alongside
  an approved one, revisit it.
- **Uploads stream into R2** with an incremental SHA-256 instead of being held in
  memory. Content-Length is required (411 otherwise). The 50 MB cap is one constant
  and can rise, since memory no longer scales with file size.
- **A stored file is deleted only on a certain rollback.** On any uncertain outcome
  it is kept: an unreferenced object is harmless, a missing referenced one is not.

### 2026-10-31 — M2a after the security review (supersedes parts of the M2a entry)
- Uploads **stream**: Content-Length is required (411 `length_required` without
  it, 413 over the cap). Only the first 4 KB are held, for type sniffing. The
  body streams into R2 through a FixedLengthStream, with SHA-256 computed as it
  passes; a body that doesn't match its Content-Length is refused and nothing is
  stored. This replaces "raw body read into one buffer" and "without
  Content-Length the read stops at the cap".
- R2 keys are `orders/<orderId>/<uuid>`; the hash is stored on the files row. This
  replaces the content-hash key.
- An SVG must reach its `<svg>` element within the first 4 KB. Later ones are
  refused (415).
- The R2 object is deleted only when the batch changed 0 rows or threw a
  constraint error. On any other error it is kept, logged and rethrown, which
  replaces "a batch that throws deletes the R2 object". Unreferenced objects can
  build up harmlessly; there is no sweeper yet.
- `po_replaced` records the replaced PO and the reason. The old PO keeps its
  approved status as history.
- After the M2 deploy: check one real browser upload in production, to confirm
  Cloudflare passes Content-Length through (verified locally over HTTP/1.1 only).

### 2026-10-31 — M3 purchasing and prep (server), Claude; for Arturo to confirm
Business-rule choices made while building the M3 API. Each can be overturned.
- **Purchasing is allowed before authorization.** The brief says purchasing
  "normally" begins after authorization; that is a UI hint, not a server block.
  The family sometimes drafts a purchase early (seed order 10 shows one).
- **Purchases can be recorded on an order with "No purchasing needed".** Readiness
  ignores them while materials aren't required. This lets supplier costs be
  tracked without forcing the gate.
- **Materials are met** when at least one non-cancelled purchase exists and every
  non-cancelled one has received at least its quantity. A not-ordered purchase
  blocks. A cancelled purchase never counts, even with receipts recorded before
  it was cancelled. Cancelled-only reads as "not ordered".
- **Over-receiving is allowed** and reported (`overReceived`), never refused.
- **Edit lock:** a not-ordered purchase is fully editable. An ordered one changes
  only actual unit cost, expected date and notes (the invoice cost often comes
  later). A cancelled purchase is closed. No change to `ordered_on` after the fact.
- **Status moves:** not ordered → ordered (staff confirm the purchase; the app
  never buys), not ordered → cancelled, ordered → cancelled. No un-cancel and no
  back to not ordered: a mistake is a new purchase. A database trigger enforces this.
- **Receipts are write-once** (UPDATE, DELETE and REPLACE refused). A wrong receipt is
  corrected by recording what really arrived, not by editing history. Only an
  ordered purchase takes a receipt, both in the route and in a trigger.
- **Sizes must add up to the quantity** on purchases and receipts when a size
  breakdown is given, the same rule as order items.
- **Defaults:** `orderedOn` and `receivedOn` default to today in shop time. A missing
  `supplierId` means the default supplier (JDS).
- **Suppliers:** any signed-in user can add one (the brief says "employees").
  Names are unique case-insensitively. There is no edit, archive or delete yet.
- **The cancel reason** lives only in the activity row, like order cancel. Purchase
  notes' text is never copied into the activity log; only the fact that they changed is.
- **Prep status can be set to any value at any time** on an active order, including
  after production started. In that case it re-derives nothing, because the re-derive
  moves only pre-production orders.
- **`START_PRODUCTION_SQL` now re-asserts the full gate** (`GATE_OK`). This closes the M0
  carried-forward item for the start statement; the QC → in-production restart path is
  still M4's.

## 2026-10-31 — Purchases are never deleted; quantities capped (Codex review of 6c6b7b5)
- `order_purchases` refuses DELETE and id changes, so DELETE + INSERT can't undo a cancellation. A mistaken purchase is cancelled.
- Purchase and receipt quantities are capped at 1,000,000 in the schema (the route's limit), keeping SQL sums within JS safe integers so the SQL gate and readiness() can't disagree.

### 2026-10-31 — M4 production queue (server), Claude; for Arturo to confirm
Business-rule choices made while building the M4 API. Each can be overturned.
- **One job runs; an owner may run a second with a reason.** A start takes slot 1. While
  slot 1 is busy, a start is refused with the running job's number, unless an active owner
  overrides with a non-blank reason; that job takes slot 2. Two is the cap, override or not.
  Staff can't override (403). The database enforces every part of this (migration 0005).
- **The override flag is ignored when slot 1 is free.** The job simply takes slot 1 and no
  override is recorded.
- **A slot-2 job stays in slot 2** when the slot-1 job finishes. It is never promoted. The
  next normal start takes slot 1, so two jobs can run again without a new override. (From
  PHASE2_PLAN §4.3; re-stated because it is what the family will notice.)
- **Restart after quality control** (QC → in production) goes through the same start: full
  readiness re-checked and a free slot needed. Units completed are kept.
- **Pausing** (in production → pre-production) lands on whatever readiness says now, e.g.
  awaiting authorization if the PO was revoked mid-run. It frees the slot and keeps units
  completed.
- **Cancelling a running job** drops it to the derived pre-production status (M1 behaviour),
  and now also clears its slot, override and queue position in the same write. This is the
  one cancel path; the M0 `CANCEL_ORDER_SQL` (which dropped to a fixed `ready`) is deleted.
- **Units completed** can be recorded and corrected up or down while the job is in production
  or in quality control (QC finds miscounts), never before it starts or after production
  complete. The cap is the order's total product quantity (sum of product lines; charges and
  discounts don't count). Each change is an activity row.
- **Queue order:** Ready to start is sorted by the manual position, then due date (none last),
  then oldest first. A newly ready order has no position, so it lands after every placed
  order until someone reorders. Starting a job clears its position; a paused order that
  becomes ready again goes to the end.
- **Reorder is race-safe by snapshot, not by version.** The page sends the list it saw and
  the new order. The write applies only if the queue is still exactly what the page saw
  (nobody reordered, nothing became ready or left), else 409 and nothing is written. One
  activity row per reorder (not per order). Reordering bumps no order's version, so it never
  forces someone with an order page open to reload.
- **Dashboard Action required** lists only pre-production orders (awaiting_* or ready): quotes
  = awaiting quote (no accepted current quote, including declined or items changed); missing
  artwork = not received or changes requested (under review is the customer's move, so it
  isn't listed); pending POs = PO required and latest not approved (or none); materials =
  purchasing needed and an ordered purchase not fully received. Customers awaiting pickup and
  checks ready for collection are typed, always-empty lists until M5.
- **Upcoming** on the dashboard is the first five of Ready to start.
- **Existing live rows (migration 0005):** a cancelled or closed order still marked in
  production drops to `ready`, as cancelling does. One running active order gets slot 1. If
  two or more active orders are running, the migration fails on purpose and changes nothing:
  someone must decide which job is really running before it is applied.

## 2026-10-31 — Order identity and slot collisions are refused by the database (Codex review of fcdbb90)
- An order's id (through `id` or any rowid alias) and number can't change; an INSERT that collides with an existing order (id or number) or a held production slot is refused, so `INSERT/UPDATE OR REPLACE` can't promote a slot-2 job, rewrite an override or evict a running job.
- A start that loses the slot race now fails on the slot trigger (`production_slot_invalid`) before the unique index; the route maps both to 409 as before.

### 2026-10-31 — M5 pickup, payments and check collection (server), Claude; for Arturo to confirm
Migration 0006 (additive), `worker/db/{pickups,payments}.ts`, `worker/routes/{pickups,payments}.ts`.
- **Agreed total** = the highest-version *accepted* quote's total. No accepted quote = unknown: never
  paid, never a credit (domain `balance()`). If a new quote version supersedes the accepted one after
  pickup, the order has no agreed total until the new one is accepted. Overpayment = paid, with a credit.
- **Closing is automatic.** In the same batch as the write that makes an order both picked up and
  paid (the pickup, a payment, a check collection), `orders.state` becomes `closed`, with an
  `order_closed` activity row. A void that leaves a closed order unpaid makes it `active` again
  (`order_reopened`, reason `payment_voided`). Cancelled orders are never closed or reopened by this.
- **The pickup row** (one per order, decision 11) is created by the first notify or collect, not when
  production completes, so the production writer is untouched. Before then the order is
  `ready_for_pickup` (derived). `ready_on` = the shop date of the latest production_complete activity
  row (today if none). Only an active, production_complete order can be notified or picked up (route,
  SQL WHERE and trigger). Notifying again replaces the notification. Collecting without notifying first
  is allowed (walk-ins). **A recorded pickup is final**: no edit and no undo (a mistaken pickup needs a
  later correction workflow).
- **Unpaid release:** pay-at-pickup orders that still owe anything need an owner override with a
  reason (staff 403, blank reason 400), held by the route and by a trigger on `pickups`; the trigger
  also writes the `pickup_release_override` audit row, so an override can't exist without one. An
  unknown agreed total counts as owed. An override sent for an order that doesn't need it is ignored
  (nothing stored, no audit row). Districts (pay after pickup) are released unpaid.
- **Payments:** any user records them; amounts 1¢ … $10,000,000; `paidOn` defaults to today (shop time);
  not on cancelled orders, allowed on closed ones (extra money becomes a credit). A `requestId` already
  seen is resolved *before* the version check, so a retried submission returns the stored payment (200,
  `replayed: true`) even though the version moved; a different payload under it (or the same id on
  another order) is 409 `request_id_conflict`. An omitted `paidOn` on a retry matches what the first
  submission stored. The client makes one requestId per submission and starts a new one after a
  success or when the details change.
- **Voids are owner-only** (decision 10), need a reason, keep the row and its request_id, stop counting,
  and can't be undone or edited; the database enforces the owner and writes the `payment_voided` audit
  row. Payments are never deleted (also unlinked ones, which the M0 design still allowed). A check's
  payment can be voided (a bounced check); the check keeps its collected/deposited status.
- **Check collections** are for pay-after-pickup orders only (not tied to customer kind), any production
  stage, not cancelled. Several per order are allowed (partial checks). A new one starts at
  `awaiting_payment` (`availableOn` is when it's expected); **Ready** sets `available_on` (default today).
  Collect may skip Ready. The moves (ready, collect, deposit, clear) are guarded by the check's own
  status, not the order version (so a retried collect still answers), and each bumps the order version.
  Collect creates exactly one payment (method check, `paid_on` = the collected date) via
  `COLLECT_CHECK_SQL`; a retry with the same amount (and check number, if sent) is 200 with nothing
  written; a different amount is 409 `check_collect_conflict`, also after reading back a lost race.
  Deposited and cleared never touch payments; a double-click on deposit/clear is 409, not a no-op.
  Once collected, the amount, who, when, check number and available date are fixed; deposit and clear
  dates are fixed once set. Dates are not checked against each other or against today.
- **Payments page "outstanding"** = active orders whose production is complete and that are not paid
  (money in progress during production isn't listed). Days outstanding count from the pickup for
  pay-after-pickup orders (none until picked up) and from the ready date for pay-at-pickup orders.
  Collection status = the order's most recent check. Next action: a ready check → collect it; an
  awaited check → wait; pay at pickup → collect at pickup (or record the payment once released); pay
  after pickup with no open check → ask the district for one.
- **`orders.payment_due_on`** (new, optional) is set by hand through the ordinary order edit; nothing
  derives it.
- **Dashboard:** "Ready for pickup" (KPI, attention reason, Orders "Ready" view, Action required →
  Awaiting pickup) now excludes picked-up orders; Checks to collect lists `ready_for_collection`
  checks, one row per check; `outstandingPayments` sums the Payments page rows.

## 2026-10-31 — No payment on a cancelled order, ever; payments are born unvoided (Codex review of 5fba130)
- A BEFORE INSERT trigger on `payments` refuses a cancelled order, which also covers collecting a check whose order was cancelled after the check was created (the collect batch rolls back whole; the route answers 409 `order_not_active`).
- A payment can't be inserted with void fields set: every void is the owner-checked, audited UPDATE.

## 2026-10-31 — Money display stays on fmt.money (Codex nit, M5 UI review)
- Amounts are stored, sent and computed as integer cents everywhere (shared/money.ts parses). `fmt.money` divides by 100 only to format for display; for any amount below about $90 trillion that conversion is exact to the cent, so it is not moved into shared/money.ts. Revisit only if a sum is ever computed in dollars.

## 2026-10-31 — Phase 2 security review fixes (Codex)
- **Cross-site writes refused.** Every non-GET request to /api/app whose Origin is another site, or whose Sec-Fetch-Site is cross-site/same-site, gets 403 `cross_site_request` before auth. The Access cookie rides along on a cross-site request, so a valid JWT proves identity, not intent. Requests without either header (curl, tests) are not a browser riding a cookie. Also worth setting in Access: the application cookie's SameSite to Lax (a Cloudflare dashboard setting, not code).
- **Bodies capped at 256 KB** before they are read, by path (a JSON route parses whatever it is sent); the two upload routes stream under their own 50 MB limit.
- **Payment terms:** relaxing an order to pay-after-pickup is owner-only (403 `payment_terms_owner_only`), and once production is complete nobody can change the terms (409 `payment_terms_locked`, and the `orders_payment_terms_fixed` trigger in 0007). Otherwise a staff member could switch an unpaid pay-at-pickup order and release it without the owner's audited override.
- Not changed: a few handlers echo a recognised trigger message in `error` (always with a fixed `code` the UI translates); these name rules, not data, so they stay.
- **Pay after pickup is owner-only except where it's the customer kind's default** (follow-up review): staff can create districts and organizations (which default to pay after pickup) and their orders as usual, but can't give an individual customer, or a new order whose customer is on pay-at-pickup, pay-after-pickup terms (403 `payment_terms_owner_only`). Staff could still mislabel a person as an organization; the activity log shows who did.
- **Owner-set customer exceptions carry to that customer's orders; repeats don't copy one-off exceptions** (second follow-up): if an owner puts an individual customer on pay after pickup, staff orders for that customer inherit it (the owner decided it for that customer). A staff repeat of an order whose pay-after-pickup was a one-off owner grant (the customer is on pay at pickup) takes the customer's own terms; an owner's repeat keeps the source's.

## 2026-11-01 — Post-Phase 2 architecture review (Claude lead, Codex independent; awaiting Arturo's approval)
- The platform is unnamed; GoCreative is its first client, not its name (Arturo's brief). Infrastructure names stay.
- Keep **one deployment per business** (Worker + D1 + R2 + Access app from one codebase); no `tenant_id` columns now. The app must never be pointed at a multi-business database. Why: the code's global constraints and lookups are correct only under isolation, and whole-business export/deletion stays simple. Codex agrees.
- Generalisation (modules, per-business stages, generic line kinds) is deferred until a second real client defines it; the storefront only adds its own module switch and puts its content in business configuration.
- ARCHITECTURE.md corrected: backups, public rate limiting/Turnstile, app-wide CSP and the service worker were described but never built. Backups become a fix-now item before the storefront.
- Storefront intake design revised after Codex: Turnstile verified once per submission session (tokens are single-use, 5 min), session caps + an admission budget instead of strict per-IP limits (school networks share IPs), an off switch, idempotent conversion.

## 2026-11-01 — Storefront plan conditionally approved (Arturo): S0 only
- Approved: one codebase; separate deployment, D1, R2 and auth config per business; GoCreative first client; no workflow engine or shared multi-tenant DB; Phase 2 preserved.
- Required: backups implemented and tested before public launch; public routes separate from the dashboard; a Declined inquiry status with optional internal reason; optional district PO uploads at inquiry, unverified until staff approval; spam kept up to 30 days and unconverted up to 12 months, deletable earlier; offboarding 30-day export then deletion, backups gone by day 60, technical and legal constraints verified before promising; short-lived per-inquiry sessions with server-enforced count/size/type/aggregate limits; the kill switch also blocks already-issued sessions; atomic, idempotent conversion; domain and content settled during development.
- No public deployment or irreversible DB change until S1 is approved. The Declined status needs the (0-row) inquiries table rebuilt, listed for S1 approval.

## 2026-11-01 — Storefront mockups approved with one correction (Arturo)
- Taste Skill (design-taste-frontend) is the design skill Arturo wanted; the mockups are fine.
- Correction: only offer methods that fit the product ("you can't laser engrave or cut a shirt or cap"). A product → methods map goes in business config, enforced by the public schema; the size grid shows only for sized apparel. Draft map in STOREFRONT_PLAN §0c, to confirm with GoCreative.
- Arturo confirmed the product → method map, and added **trophies and awards**: ordered, built and personalized by the shop. They are a storefront product (personalized by laser engraving), and internally they use the existing purchasing (a trophy supplier), prep (assembly) and production steps.
- Storefront screens animate (Arturo): motion spec in DESIGN_SYSTEM.md, prototyped in the phone order flow and confirmation. CSS + View Transitions API, no motion library; reduced motion removes movement.
- Storefront uses Motion (motion/react, storefront bundle only) with components adapted from Motion Primitives and Watermelon UI (both MIT; copied and restyled, one icon set, no Next-only deps). Replaces the earlier "no motion library" line for the storefront only; the dashboard stays library-free. Why: Transition Panel gives step exits CSS can't, plus stagger reveals and the morphing submit. Arturo approved.

## 2026-10-31 — S0b as built differs from the plan (Claude; Arturo can overturn)
- The maintenance switch is a D1 row, not a Worker variable: it needs no new Worker version and reads strongly from the primary.
- Restore reads trigger text from the target's own schema instead of keeping the planned inventory, which could go stale.
- The storefront's migration becomes 0009.
- Deferred to S3, before the first deletion feature: deletion journal, its replay, and orphan detection. Wrangler has no `r2 object list`, and nothing deletes yet.

## 2026-11-01 — S1 public inquiry API (Arturo's go, including the inquiries rebuild; the rest Claude's, Arturo can overturn)
- **Order:** Arturo said go on S1 before the S0c rehearsal. Safe because the whole Worker stays behind Access until S4; S0c is still required before the S4 cut-over.
- **Ships closed:** migration 0009 inserts `intake_closed`. Opening is a deliberate step at launch.
- **Limits beyond the plan, for Arturo to change** (`worker/domain/intake.ts`): 300 sessions and 3 GB a day, 200 open sessions, 20 upload attempts per session, 10 minutes per upload. From the plan: 5 files, 60 MB per session, 20 MB per file, 20 sessions per IP per hour, 2 GB outstanding.
- **Differs from the plan:**
  - The session token goes in the Authorization header, so routes are `/submissions`, `/submissions/files`, `/submissions/submit`. A token in the path would land in Worker logs.
  - `inquiries.submission_id` replaces `request_id`: the session is the idempotency key.
  - The `files` row is created only at submit, so nothing unsubmitted can be served.
  - Added `DELETE /submissions/files/:id` for "remove this file" in the form, and `GET /status` for the off-switch message.
  - `orders.inquiry_id` moves to S3, where conversion uses it.
- **Daily byte budget** is charged only for stored bytes (Codex showed refused uploads could exhaust it). It is never refunded.
- **Known ceiling:** someone rotating IPs and passing Turnstile can use up the daily sessions or hold storage for 10 minutes at a time. That blocks new inquiries, never the dashboard or stored data. The off switch and phone or email remain.

## 2026-11-01 — S2 storefront as built (Claude; Arturo reviews the UI before S3 or S4)
- **Screens follow the approved mockups.** One `/services` page with anchors, as drawn, rather than the plan's `/services/:slug`.
- **Motion, per Emil Kowalski's rules (Arturo asked for them).** Press feedback, step transitions, upload rows, scroll reveals, the confirmation moment. Cut: hero Text Effect (the first thing read should not be delayed). Deferred: Morphing Dialog (no real photos to open). Motion Primitives pieces were adapted by hand; no Watermelon code was copied, since its MCP was not available here.
- **Light theme only,** as Arturo's direction and the mockups say.
- **Copy is in English in the components,** not i18n: Arturo said the storefront stays English, and shared/i18n requires every string in Spanish. Moving it later is mechanical.
- **Added `GET /submissions/files`:** the session lists its own stored files. Codex showed a lost upload reply could otherwise send an unseen file or a duplicate.
- **`GET /status` is open only when a session could open,** so missing secrets show the closed message, not a form that fails.
- **`DEV_TURNSTILE_PASS`** skips Turnstile on localhost only, the same pattern as `DEV_AUTH_EMAIL`, with a test that a real hostname still verifies.
- **The Worker is not deployed with S2.** Arturo asked to review the UI first.

## 2026-11-01 — S2 UI approved, without "Take a photo" (Arturo)
- Arturo reviewed the screens: everything looks good, and he does not want the Take a photo button. It is removed, and the mockup is superseded on that point. "Choose files" stays; a phone's own file picker can still offer its camera or photo library.

## 2026-11-01 — S2 revisions (Arturo's review; supersedes "S2 UI approved" above: approval is pending this round)
- **Multiple products in one request.** Needs no migration: the S1 schema already takes up to 10 lines, stored in `inquiries.payload`. `description` is a new optional field in the same JSON. **S3 dependency:** conversion must map each line to its own order item, show the description to staff, and show lines without a price until quoted.
- **Step 1 now takes several products (checkboxes).** The same product can repeat as a second line, such as a second shirt color.
- **No reply-time promise.** The response-time placeholder is gone from the confirmation and from `business.ts`.
- **"Needed by" became "Requested deadline",** stated as a request, not a guarantee.
- **Launch gate:** `npm run check:launch` fails while contact details, photos, privacy review or the shop's confirmation of services are missing. S4 must run it before the Access cut-over.

## 2026-11-01 — S2 approved; S3 as built (Arturo approved S2 and asked for S3 without production deployment)
- **Migration 0010 is additive.** New nullable columns, one unique index, new triggers and two replaced triggers. No table rebuilt, no row changed.
- **No `orders.inquiry_id`,** unlike the plan: with the existing `inquiries.order_id` it would make a foreign-key cycle, which restore refuses. `one_inquiry_per_order` on `inquiries.order_id` plus the batch guard give one order per inquiry.
- **Each inquiry line becomes one order item,** priced 0 until quoted. "Help me choose" becomes method `other` with a note. Personalization and material go in the item description. The project description becomes a note on the order; the original inquiry is frozen as sent.
- **A customer's PO arrives `received`, artwork `under_review`.** Each artwork file is its own design. Approval stays a staff action; artwork approval defaults to required.
- **Customer matching only suggests,** by email or phone. Existing customers keep their own PO and payment defaults; new ones take their kind's defaults, so no owner-only terms can be set this way.
- **The requested deadline prefills the due date,** editable, with a note that it is not a commitment.
- **Added beyond the plan:** "Move back to new", so a mistaken decline or spam mark is not final until retention or delete.
- **Deletion order:** claim, journal, objects, rows. Retention runs in the daily cron; spam from receipt after 30 days, unconverted after 12 months, converted never.

## 2026-11-01 — Offsite backups by USB to a Windows machine (Arturo)
- Arturo chose carrying encrypted bundles by hand over Tailscale or a cloud folder. Expiry on that machine is manual, helped by a delete-after date in each file name (56 days, the plan's 8 weeks).
- AES-256-GCM with scrypt, in plain Node with no dependencies, so recovery needs only Node and the passphrase. The passphrase is Arturo's and is never stored by the project or on the drive.

## 2026-11-01 — Automated estimating: confirmed requirements (Arturo); plan awaiting approval
- No LLMs or paid AI. Deterministic analysis and rules. Estimates are never binding; staff issue every final quote. Versioned pricing with Draft → Preview → Publish → Active. Full list: AUTOMATED_ESTIMATING_PLAN.md §1.
- E1 to E3 do not start without his go. Phase 3's S4 install work stays paused on branch `s4-install`.

### 2026-11-01 — E3: what shows customer prices, and what doesn't exist

- **Customer prices are a code flag, `customerEstimates` in `shared/business.ts`, default false.** Turning them on takes a code change and a deploy, so nothing in the dashboard can do it by accident. Published rates alone change nothing for customers. Claude's call, under Arturo's rule that dollar estimates stay disabled until rates are configured and validation passes.
- **While off, the browser doesn't analyse artwork or ask for a price.** Submit still stores an estimate row for staff, with what the customer was told (manual review) kept apart from what was calculated.
- **Customers can only reach a figure with screen printing or DTG, a print location and their own uploaded artwork.** Embroidery complexity and engraving machine time aren't things a customer can know, so those always go to a person.
- **Colours are never typed by a customer.** The server derives them from an analysis report (`defensibleColors`), which stays labelled `customer_reported`.
- **Staff review adds a row; it never edits one, and writes to no order, item or quote.** It reads the stored original, requires every stored artwork file to be re-analysed, and needs a reason for any change. One reason per review, stored on each changed field.
- **"Start draft quote from this estimate" not built.** Optional in the plan, not in Arturo's E3 list, and leaving it out keeps conversion and quotes untouched.
- **Staff see "needs an owner to review the price" rather than a margin refusal,** because whether a job clears the margin is owner-only.

