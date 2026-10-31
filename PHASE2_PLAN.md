# Phase 2 Implementation Plan

**Status:** approved 2026-10-30 with decisions and corrections (§4). M0 is authorised:
pure business rules, tests, the concurrency design and the design review. **Not yet
authorised:** wiping the remote DB, destructive migrations, production deploys (they wait
for the M0 review, including Codex's review of the rules and concurrency design).
**Answers:** §19 of [SPEC-phase2.md](SPEC-phase2.md), the authoritative Phase 2 brief.
**Repo state reviewed:** `main` at the Phase 1 close (live behind Cloudflare Access, 137
unit + 22 e2e tests).

The brief absorbs two pieces of the old roadmap: artwork uploads and PO documents (old
Phase 3), and the production queue (old Phase 5). After Phase 2, the storefront is Phase 3
and the artwork estimator is Phase 4.

---

## 1. Already satisfied (keep, extend, don't rebuild)

| Area | What exists | Where |
|---|---|---|
| Auth | Cloudflare Access (2 emails) + Worker re-verifies the JWT; owner/staff roles from `users`; fail-closed | `worker/auth.ts` |
| Separate status tracks | Artwork, PO, production, invoice/payment refs are separate columns, not one status | `migrations/0001_init.sql` |
| Production gate | `canEnterProduction` (artwork + PO-or-authorization), re-asserted inside the SQL write, plus a parity test across all 336 combinations | `worker/domain/production.ts`, `worker/db/orders.ts` |
| PO workflow | Requested → Received → Under review → Approved / Rejected / Correction required, with transition rules; an approved PO can be revoked | `worker/domain/purchaseOrder.ts` |
| Single write paths | One function writes `production_status` (plus the PO auto-sync); status change + activity row in one batch; stale-read guards | `worker/db/orders.ts` |
| Audit | `activity_log` is write-once (UPDATE/DELETE/REPLACE all blocked by triggers) | migration 0001 |
| Files | `files` table is write-once with sha256; `artwork` has lineage + version + approval status; `po_documents` links POs to files | migration 0001 (no upload code yet) |
| Money | Integer cents enforced by `typeof(...) = 'integer'` CHECKs | migration 0001 |
| Screens | Dashboard, order list (views, search), order detail workspace (status strip, gate banner, tabs), EN/ES, phone layouts, ⌘K | `src/app/` |
| Order numbers | `counters` table + `formatOrderNumber` | `worker/domain/orderNumber.ts` |

## 2. Missing functionality (gaps against the brief)

1. **Customer and order creation/editing.** Today everything is read-only except the PO and
   production status. There are no customer screens at all.
2. **Line items with discounts and charges**, totals, and a size breakdown editor.
3. **Quotes**: versions, the five statuses (incl. Superseded), immutability once accepted,
   and duplication. The current `estimates` table has no Superseded status and stores lines as JSON.
4. **Direct authorization recording** (method, notes, who, when). The columns exist but
   nothing writes them, so a non-PO order can never reach production today.
5. **Artwork uploads** to R2: previews, versions, approval tied to a version, and Not Required.
   Today nothing can set artwork to approved, so no order can reach production.
6. **PO document upload.**
7. **Suppliers (JDS default), order purchases, partial receipts.**
8. **Production preparation status.**
9. **The five-item readiness checklist.** The gate today checks only two of the five.
10. **The production queue**: one active job enforced in the database, manual ordering,
    progress, and an owner override.
11. **Pickup**: notification, collection, and the unpaid-release override.
12. **Payments** (multiple per order, derived balance/status) and **check collection**.
13. **The dashboard rework** the brief describes: current job, upcoming queue, action required,
    ready for pickup, outstanding payments. Plus Production and Payments pages.
14. **Shop time zone.** "Today" and overdue are currently computed in UTC.

## 3. Database: proposed design and migrations

The remote database only holds the Phase 1 sample orders. **Proposal: wipe it (keeping the 2
users) before migration 0002.** The migrations can then rebuild tables to change CHECK
lists, which SQLite requires, without carrying sample rows through. Real data starts at the
end of Phase 2, and every migration from then on must preserve data.

The brief's entity list, mapped onto the existing schema ("adapt, don't duplicate"):

| Brief entity | Plan |
|---|---|
| Customers | **extend**: `default_po_required`, `default_payment_terms` (`due_at_pickup` / `due_after_pickup`). Customer type and PO requirement stay independent, as the brief asks |
| Orders | **extend**: `po_required` and `payment_terms` copied from the customer at creation and editable per order; `artwork_required`; `materials_required`; `prep_status`; `authorization_method` / `authorization_notes` (next to the existing `authorized_at` / `authorized_by`); `items_revision`; `queue_position`; `units_completed`; `production_slot` (§4.3); `payment_due_on`; `state` becomes `active / cancelled / closed` (§4.2) |
| OrderItems | **keep `order_items`** as the working list of what will be made (sizes drive purchasing). Add `kind` (`product` / `charge` / `discount`) and `description` |
| Quotes + QuoteItems | **replace `estimates`** with `quotes` (version, status incl. `superseded`, `items_revision` snapshot, totals) + `quote_items` (a frozen copy of the lines and prices). Triggers make accepted quotes and their items immutable |
| Artwork | **keep** `artwork` (lineage = one design, version = one file). Add `approved_at`, `approved_via`, `approval_recorded_by`. The order's artwork status is **derived**, not stored |
| Authorizations | **no new table**: the direct-authorization columns on `orders` + `purchase_orders` + `activity_log` history cover it (one current authorization per order; the history is in the log) |
| PurchaseOrders | **keep** as is; uploads fill `po_documents` |
| Suppliers | **new**, seeded with JDS (`is_default = 1`) |
| OrderPurchases | **new** `order_purchases` (supplier, description, qty, sizes JSON, estimated/actual unit cost in cents, ordered/expected dates, status `not_ordered / ordered / cancelled`; received and partially received are **derived** from receipts) + **new** `purchase_receipts` (qty + sizes per delivery), which covers partial shipments |
| ProductionPreparation | **columns on orders** (`prep_status`, notes go in `notes`); production is per order (Phase 1 decision) |
| ProductionJobs | **columns on orders** (`queue_position`, `units_completed`, `production_slot`) with the slot CHECK + unique index of §4.3: the database itself caps running jobs at one, or two with an owner override |
| PickupRecords | **new** `pickups`, the fulfilment track of §4.2 (1 per order: ready/notified dates, notification method, picked-up date, collected-by name, employee, notes, release override + reason) |
| Payments | **new** `payments` (`check_collection_id` UNIQUE, `request_id` UNIQUE per §4.4, amount cents, method `check / ach / cash / card / other`, date, notes, recorded_by). Balance and status are **derived** from the accepted quote total minus payments. No card or bank numbers anywhere |
| CheckCollections | **new** `check_collections` (order, expected/received cents, check number, available/collected/deposited/cleared dates, collected_by, status, notes, optional `payment_id` link) |
| ActivityLogs | **keep**; every new write logs, in the same batch as the change |

**Adjusted 2026-10-30:** with the remote DB empty after the wipe, 0002 switches the *whole*
vocabulary at once (production statuses, order states, artwork, quotes), so no milestone needs
code that translates between old and new names. The feature tables still arrive per milestone.

Migrations, one per milestone, each with its own schema test like `shared/schema.test.ts`:

- **0002** (M1): customer defaults; order columns for quotes and authorization; `order_items.kind`;
  `quotes` + `quote_items` replacing `estimates`; immutability triggers; artwork status rename
  (`none` → `not_received`, `pending` → `under_review`, + `not_required`); time zone in `business.ts` (not SQL)
- **0003 is M2a's** `0003_artwork_po.sql` (added 2026-10-31: `files.filename`, `artwork.design_name`, artwork-version and
  PO-document write-once triggers, file-link indexes). The M3, M4 and M5 migrations below each move up one number
  (0004, 0005, 0006); the references further down still use the old numbers.
- **0003** (M3): `suppliers` (+ JDS), `order_purchases`, `purchase_receipts`, `materials_required`, `prep_status`
- **0004** (M4): `queue_position`, `units_completed`, the §4.3 slot DDL. (The production status set moved into 0002, see below.)
- **0005** (M5): `pickups`, `payments`, `check_collections`, `payment_terms`, `payment_due_on`

## 4. Decisions (Arturo, 2026-10-30) and the designs they fix

| # | Decision |
|---|---|
| 1 | Shop time zone **America/Chicago**, DST included |
| 2 | Editable order items + immutable quote-version snapshots |
| 3 | Only Draft quotes are editable; history is kept |
| 4 | Both: duplicate a quote within an order, and a repeat order from a previous order |
| 5 | Awaiting Quote and Awaiting Artwork join the readiness workflow |
| 6 | Fulfilment and financial closure are tracked separately; picked up = fulfilled, even if unpaid |
| 7 | "No purchasing needed" is allowed, with employee confirmation |
| 8 | Every applicable design's current version must be approved |
| 9 | A collected check is recorded as a received payment; deposited and cleared are tracked separately |
| 10 | Owner-only overrides require a reason and an audit entry |
| 11 | One pickup per order |
| 12 | Progress = units completed, and staff can correct it |
| 13 | Design review before any UI is built |
| 14 | Production and Payments pages; purchasing stays in the order workspace |

### 4.1 What triggers quote reapproval (correction)

Only changes to **customer-approved scope or pricing** bump `orders.items_revision`, and
so require a new accepted quote. Those are the customer-facing fields of an order item:
`kind`, `description`, `product`, `garment_color`, `method`, `sizes`, `quantity`, and
`unit_price_cents`, plus adding or removing a line. Internal fields never bump it: item
notes, supplier choice, estimated and actual costs, purchases, receipts, prep, assignee,
and order notes. The list is one exported constant in the domain (`CUSTOMER_FACING_ITEM_FIELDS`),
and a test fails if an internal edit bumps the revision.

### 4.2 Three independent tracks (correction)

- **Production** (`orders.production_status`): `awaiting_quote`, `awaiting_authorization`,
  `awaiting_artwork`, `awaiting_materials`, `awaiting_preparation` (derived from the first
  unmet readiness item, never picked by hand) → `ready` → `in_production` →
  `quality_control` → `production_complete`. Production ends there; pickup is not a
  production status.
- **Fulfilment** (from the `pickups` row): `not_ready` → `ready_for_pickup` (set when
  production completes) → `customer_notified` → `picked_up`. Picked up = fulfilled (decision 6).
- **Financial** (derived from `payments` vs the accepted quote total): `unpaid` / `partially_paid` / `paid`.
- `orders.state` keeps only `active` / `cancelled` / `closed`. **Closed** = fulfilled AND
  paid, computed and set in the same batch as the write that completes the second
  condition. No track ever writes another track's status.

### 4.3 One active production job, and the override (correction)

A **slot** model, with every rule enforced by the database so no SQL path can bypass it.
DDL: [design/sql/production-slots.sql](design/sql/production-slots.sql); statements:
`worker/db/productionSql.ts`. Both move verbatim into migration 0004 / the M3 routes. *(M4, 2026-10-31: they landed in migration 0005 as triggers, since the live orders table can't be rebuilt for CHECKs; the start and cancel live in `applyProductionChange` and `cancelOrder` in `worker/db/orders.ts`, and `productionSql.ts` is gone.)*

- `orders.production_slot INTEGER NULL CHECK (production_slot IN (1, 2))`, plus
  `production_override_by INTEGER REFERENCES users(id)` and `production_override_reason TEXT`.
- CHECKs: `(production_status = 'in_production') = (production_slot IS NOT NULL)`;
  `production_slot IS NULL OR state = 'active'`; slot 2 requires a non-null overrider and a
  non-blank reason; the override columns are NULL whenever the slot is not 2.
- `CREATE UNIQUE INDEX one_job_per_slot ON orders (production_slot) WHERE production_slot IS NOT NULL`,
  so at most two jobs ever run.
- BEFORE INSERT/UPDATE triggers abort entering slot 2 (`production_override_invalid`) unless another
  order holds slot 1 and the overrider is an existing, active `owner`; once in slot 2, who and why
  can't be edited (`production_override_immutable`). An AFTER trigger writes the
  `production_override` activity row (owner, reason, the order running in slot 1), so an override
  can't happen without its audit entry.
- **Start** = one batch: `UPDATE orders SET production_status='in_production', production_slot=?,
  production_override_by=?, production_override_reason=? WHERE id=? AND state='active' AND
  production_status='ready' AND production_slot IS NULL`, then the `production_started` activity
  INSERT with `WHERE changes() = 1`. A losing start either matches no row (nothing logged) or hits
  the unique index / triggers and the batch rolls back; both return 409 (`production_busy` names the
  running job). `chooseSlot` picks the slot and explains refusals; the database is the enforcement.
  Full readiness is not re-checked in SQL yet (M1/M3 add it); the guard trusts the readiness-derived `ready`.
- Leaving `in_production` clears the slot (and override columns) in the same UPDATE. A slot-2 job
  is never moved into slot 1; the next normal start uses the free slot 1.
- **Pause and cancel:** pausing (`in_production` → pre-production) goes to readiness's current
  `preProductionStatus` (e.g. `awaiting_authorization` if the PO was revoked), never a fixed `ready`.
  Cancelling is `SET state='cancelled', production_status = CASE WHEN 'in_production' THEN 'ready' …,
  production_slot=NULL, override columns NULL WHERE id=? AND state='active'`; reopening re-derives
  readiness before any start.

Proven in `tests/api/production-slots.test.ts` (via the D1 adapter's transactional `batch()`):
concurrent starts, the two-slot cap, direct-SQL bypasses (staff, inactive owner, blank reason,
slot 2 with slot 1 empty), the single audit row, slot release, and cancelling a slot-1 or slot-2 job.

### 4.4 Payments can't be duplicated by check collection (correction)

DDL: [design/sql/payments.sql](design/sql/payments.sql) (into migration 0005); statements:
`COLLECT_CHECK_SQL` / `RECORD_PAYMENT_SQL` in `worker/db/paymentSql.ts`, reused verbatim by M5.

- `payments.check_collection_id INTEGER UNIQUE REFERENCES check_collections(id)`: one payment per
  collection. Triggers block changing a payment's `check_collection_id` and deleting a linked payment.
- `payments.request_id TEXT UNIQUE`, and `CHECK (check_collection_id IS NOT NULL OR (request_id IS NOT
  NULL AND length(trim(request_id)) > 0))`: every manual payment carries a client-generated request id.
  `amount_cents` is a positive integer; `method` is one of `PAYMENT_METHODS`.
- **Collect** = one batch of three adjacent statements: (1) `UPDATE check_collections SET
  status='collected', amount_received_cents=? … WHERE id=? AND status IN
  ('awaiting_payment','ready_for_collection')`; (2) `INSERT INTO payments (…) SELECT … FROM
  check_collections WHERE id=? AND changes() = 1`; (3) the `check_collected` activity INSERT
  `SELECT … FROM payments WHERE check_collection_id=? AND changes() = 1`, i.e. only for a payment that
  exists and was inserted by (2). A retry or competing collect changes nothing; a failing payment
  INSERT (e.g. amount 0) rolls the collection status back.
- **Manual payment:** on a `request_id` UNIQUE failure the route loads the stored payment and calls
  `matchRetry` (`worker/domain/payments.ts`): an identical resubmission returns the stored payment, a
  different payload under the same id is 409 `request_id_conflict`.
- Deposited and cleared are statuses on the collection only and never touch `payments`.

Proven in `tests/api/payments-dedup.test.ts`.

### 4.5 Dates and time zones (correction)

- **Timestamps** (`created_at`, `authorized_at`, `collected_at` …) are stored as UTC ISO-8601, as today.
- **Business dates** (`due_date`, `payment_due_on`, expected arrival, pickup date, check
  available/deposit dates) are stored as `YYYY-MM-DD` in **shop time**.
- "Today", overdue, "due this week" and days outstanding come from
  `businessToday(now)`, using `Intl` with `business.timeZone = 'America/Chicago'` (in
  `shared/business.ts`). Never from the UTC date.
- Tests pin the edges: 23:30 Chicago on a date that is already tomorrow in UTC, and both DST transitions.

### 4.6 Deleting the live sample data (correction)

Not done until you approve it explicitly. Before asking:
1. Export the remote DB (`wrangler d1 export --remote`) to a dated file outside the repo.
2. Record the D1 Time Travel restore point.
3. Show that every customer, order and user row matches the seed (2 real users, fictional
   sample customers, no others).

The wipe happens only after your go, and only before migration 0002.

## 5. Prioritized checklist

Each milestone ships the same way: API + migration → Codex review → fixes → UI → Codex
review → fixes → that milestone's acceptance tests → deploy to the protected site with
sample data so the family can try it. "Who" = the model per task (Sonnet for specified
build work, Opus where a thin implementation would pass tests and be wrong, Codex for pure
logic it can test, Claude for design, integration and verification).

### M0 — Foundations (no user-visible change) — authorised 2026-10-30
- [x] Decisions recorded (§4, DECISIONS.md). *(Arturo, Claude)*
- [x] Backup + evidence, then the wipe after Arturo's explicit go (2026-10-30). *(Claude)*
- [x] Pure domain rules + tests: readiness checklist (the five items, which one is missing, the
      derived awaiting status), quote transitions/supersede/`items_revision`, line and quote
      totals with discounts and charges, payment balance and status, purchase status from
      receipts, money parsing, shop-time-zone "today", fulfilment and unpaid-release rules,
      check-collection transitions, the production slot choice, and the §4.3 DDL test.
      *(Codex writes; Claude verifies)*
- [x] Codex independent review (fresh, read-only) of the M0 rules and the concurrency
      design; 9 findings fixed; re-review verdict **"M0 ready for M1"** (2026-10-30).
- [x] Design round: dashboard, order workspace, New order, customer, Production, Payments. Approved 2026-10-30 (`design/mockup/phase2/`).

**Carried forward from the M0 review** (each lands in the milestone named, with tests):
- **M1:** quote acceptance always goes through `checkQuoteAcceptable`; a charge-only or empty
  snapshot can never be accepted (route and boundary tests). Readiness `lineCount` counts
  product lines. The order-number counter row is created on first use (the remote
  `counters` table is empty after the wipe).
- **M1:** one integration check against a real D1 runtime (`wrangler dev`, workerd) proving
  that batch statements run in order and that `changes()` carries from one to the next.
  The node:sqlite tests can't show this.
- **M3/M4:** the start SQL re-asserts full readiness in the WHERE (not just
  `production_status = 'ready'`), with a domain↔SQL parity test like Phase 1's. There will be
  a readiness-guarded `quality_control → in_production` restart path, because the domain
  allows it and the SQL today doesn't. Routes map both slot-2 errors (trigger and CHECK).
- **M5:** a check-collect retry with a different amount returns 409 after reading back.
  Payment corrections are an audited **void** that keeps the row and its `request_id`, never a
  hard delete.

### M1 — Customers, orders, quotes, authorization (brief Step 2) → acceptance 1, 2, 3, 4, 6 — built, Codex-reviewed, **live 2026-10-31**
- [x] Migration 0002 + schema tests. *(Opus; Codex reviews)*
- [x] Customers API: list/search, detail, create/edit, contacts. *(Sonnet)*
- [x] Orders write API: create from customer defaults, edit header (conflict guard), items
      editor writes, cancel/reopen, assignee, notes, **record/revoke direct authorization**,
      the **cross-customer contact check** carried over from Phase 1. *(Opus)*
- [x] Quotes API: new version from items, duplicate, reorder, transitions, immutability. *(Opus, same task as orders: they share `items_revision`)*
- [x] UI: customer pages, New order, items + size grid, quote panel, authorization panel, ⌘K results. *(Sonnet)*

### M2 — Artwork and PO documents (brief Step 2, artwork) → acceptance 5, 6 — built and Codex-reviewed ("M2 ready") 2026-10-31; LIVE 2026-10-31 (0003 applied remotely, Worker version d7e50ae8)
- [x] Upload API: type allowlist by magic bytes, 50 MB limit, sha256, write-once R2 keys,
      authenticated downloads only, SVG served as attachment, previews generated in the
      browser for TIFF/PDF. *(Opus; Codex security review)*
- [x] Artwork versions, approval per version (with customer approval method), Not Required,
      new version resets approval; PO document upload. *(Opus, same task)*
- [x] UI: artwork tab (designs, versions, previews, approve), PO documents. *(Sonnet)*

### M3 — Purchasing and preparation (brief Step 3) → acceptance 7, 8, 10 — built and Codex-reviewed ("M3 ready") 2026-10-31; LIVE 2026-10-31 (0004 applied remotely, Worker version 5f845264)
- [x] Migration 0004 (0003 went to M2); suppliers (JDS default, add new); purchases; receipts (partial);
      "No purchasing needed"; prep status; **gate extended to all five items** in the domain
      and in the SQL guard, with the parity test. *(Sonnet for CRUD; Opus for the gate change)*
- [x] UI: purchasing panel, receipts, prep, **readiness checklist** at the top of the workspace. *(Sonnet)*

### M4 — Production queue (brief Step 4) → acceptance 9, 11, 12, 17 (production part) — built and Codex-reviewed ("M4 ready") 2026-10-31; LIVE 2026-10-31 (0005 applied remotely, Worker version 44221cd0)
- [x] *(migration is 0005, so M5's payments migration becomes 0006)* Migration 0005; queue ordering; start / QC / production complete transitions; units
      completed (correctable); the §4.3 slot DDL + owner override; production history. *(Opus; Codex
      reviews concurrency specifically)*
- [x] UI: Production page (Ready to start / In production / Completed), dashboard current job +
      upcoming + action required. *(Sonnet)*

### M5 — Pickup and payments (brief Step 5) → acceptance 13–16, 17 (payments part)
- [ ] Migration 0006; pickups (notify, collect, unpaid-release override); payments (multiple,
      derived balance/status); check collections (all five statuses, cleared separate). *(Opus; Codex reviews the money)*
- [ ] UI: pickup panel (also from the dashboard), payments panel, Payments page with checks
      to collect, dashboard Outstanding payments + Ready for pickup. *(Sonnet)*

### M6 — Polish and validation (brief Step 6)
- [ ] Two end-to-end lifecycle tests through the real UI: a regular customer (direct
      authorization, pay at pickup, unpaid-release override) and a school district (PO,
      pickup before payment, check collected → deposited → cleared). Together they cover
      acceptance 1–17.
- [ ] Phase 1 carry-overs: the ES column overflow, focus after "Record approval".
- [ ] Additive migration: unconditional `BEFORE UPDATE` id guards on `quotes` and `artwork` (their `UPDATE OF` triggers miss `rowid` aliases; direct-DB edits only — Codex, M3 review).
- [ ] Whole-phase Codex security review; accessibility pass; docs (README setup, ARCHITECTURE
      schema section, DECISIONS, notes); realistic seed for every new state.
- [ ] Deploy, migrate remote, signed-in smoke test; then the family starts entering real orders.

## 6. How Codex reviews each milestone

Codex runs read-only after each merge (`codex exec -s read-only`), with the milestone's
commits, AGENTS.md, this plan and the brief. It reports bug / risk / nit findings with
file:line; a fix pass follows before the next milestone builds on it. Its sandbox cannot run
the test suite, so Claude runs `npm run verify` itself. Standing checks every time: single
write paths, writes and activity rows in one batch, no string-built SQL, no internal data on
public routes, tests that would still pass if their rule were removed. Per milestone:

| Milestone | Codex focuses on |
|---|---|
| M0 | Domain rules vs the brief's wording; edge cases (a zero-quantity line, a discount larger than the total, no quote, every design approved vs one) |
| M1 | Accepted-quote immutability (can any SQL path change a frozen line?), supersede logic, `items_revision` drift, the cross-customer contact check, the conflict guard on edits, migration 0002 rebuild correctness |
| M2 | Upload security: content-type spoofing, SVG script, path/key injection, size limits, unauthenticated download paths; approval bound to an existing version; a re-upload resetting approval |
| M3 | The five-item gate in domain vs SQL (extended parity test), partial-receipt arithmetic, cancelled purchases, "No purchasing needed" not bypassing anything else |
| M4 | The one-active-job guarantee under concurrent requests, the override path, queue reordering races, transitions skipping QC |
| M5 | Cents arithmetic (overpayment, refunds as negative?, rounding), derived balance, unpaid-release override enforcement on the server, check status vs balance separation, no sensitive payment data stored |
| M6 | The whole-phase security review, plus test coverage against the brief's acceptance criteria 1–17 |

## 7. Not in Phase 2 (from the brief §15, plus)

No accounting, bank sync, Wave/PNC/JDS integrations, payment processing, invoicing,
quote PDF/email, automated notifications, inventory, shipping, scheduling, AI pricing,
multi-tenant. Also deferred: partial pickups (unless you say they happen), user management
screens (2 users), and a refund workflow (a negative payment, if needed, is a §4 follow-up).
