# Phase 2 Implementation Plan

**Status:** proposal for review, 2026-10-30. Nothing in it is built yet.
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
| Orders | **extend**: `po_required` and `payment_terms` copied from the customer at creation and editable per order; `artwork_required`; `materials_required`; `prep_status`; `authorization_method` / `authorization_notes` (next to the existing `authorized_at` / `authorized_by`); `items_revision`; `queue_position`; `units_completed`; `production_override`; `payment_due_on` |
| OrderItems | **keep `order_items`** as the working list of what will be made (sizes drive purchasing). Add `kind` (`product` / `charge` / `discount`) and `description` |
| Quotes + QuoteItems | **replace `estimates`** with `quotes` (version, status incl. `superseded`, `items_revision` snapshot, totals) + `quote_items` (a frozen copy of the lines and prices). Triggers make accepted quotes and their items immutable |
| Artwork | **keep** `artwork` (lineage = one design, version = one file). Add `approved_at`, `approved_via`, `approval_recorded_by`. The order's artwork status is **derived**, not stored |
| Authorizations | **no new table**: the direct-authorization columns on `orders` + `purchase_orders` + `activity_log` history cover it (one current authorization per order; the history is in the log) |
| PurchaseOrders | **keep** as is; uploads fill `po_documents` |
| Suppliers | **new**, seeded with JDS (`is_default = 1`) |
| OrderPurchases | **new** `order_purchases` (supplier, description, qty, sizes JSON, estimated/actual unit cost in cents, ordered/expected dates, status `not_ordered / ordered / cancelled`; received and partially received are **derived** from receipts) + **new** `purchase_receipts` (qty + sizes per delivery), which covers partial shipments |
| ProductionPreparation | **columns on orders** (`prep_status`, notes go in `notes`); production is per order (Phase 1 decision) |
| ProductionJobs | **columns on orders** (`queue_position`, `units_completed`, `production_override`) + a **partial unique index**: `ON orders(production_status) WHERE production_status = 'in_production' AND production_override = 0`. The database itself refuses a second active job, whatever two users click at the same moment |
| PickupRecords | **new** `pickups` (1 per order: ready/notified dates, notification method, picked-up date, collected-by name, employee, notes, release override + reason) |
| Payments | **new** `payments` (amount cents, method `check / ach / cash / card / other`, date, notes, recorded_by). Balance and status are **derived** from the accepted quote total minus payments. No card or bank numbers anywhere |
| CheckCollections | **new** `check_collections` (order, expected/received cents, check number, available/collected/deposited/cleared dates, collected_by, status, notes, optional `payment_id` link) |
| ActivityLogs | **keep**; every new write logs, in the same batch as the change |

Migrations, one per milestone, each with its own schema test like `shared/schema.test.ts`:

- **0002** (M1): customer defaults; order columns for quotes and authorization; `order_items.kind`;
  `quotes` + `quote_items` replacing `estimates`; immutability triggers; artwork status rename
  (`none` → `not_received`, `pending` → `under_review`, + `not_required`); time zone in `business.ts` (not SQL)
- **0003** (M3): `suppliers` (+ JDS), `order_purchases`, `purchase_receipts`, `materials_required`, `prep_status`
- **0004** (M4): production status set (below), `queue_position`, `units_completed`, `production_override`, one-active-job index
- **0005** (M5): `pickups`, `payments`, `check_collections`, `payment_terms`, `payment_due_on`

## 4. Conflicts and unclear points, with my proposed resolution

Each one needs a yes or a correction. **Bold = my recommendation.**

1. **Where line items live.** The brief lists both OrderItems and QuoteItems. **Order items
   are the editable working list; each quote version freezes a priced copy.** An order counts
   as "quote accepted" only when its current quote is accepted *and* its items haven't changed
   since (`items_revision` matches). Editing items after acceptance flips the checklist back
   to pending until a new version is accepted, which is the brief's "reapproval".
2. **Which quote states can be edited.** **Only Draft.** Sent, Accepted and Declined are
   frozen; changing them means "New version", which marks older Draft/Sent/Accepted versions
   Superseded. Declined versions stay Declined.
3. **"Duplicate existing quotes".** **Two actions: duplicate a version within the order (as a
   new draft), and "Reorder": start a new order from a past order's items.** Schools reorder
   the same items yearly, and the brief doesn't say which it meant.
4. **Production status list.** The brief's list has no Awaiting Quote or Awaiting Artwork,
   yet both are checklist items, and it puts Production Complete after Ready for Pickup.
   **Stored statuses: `awaiting_quote`, `awaiting_authorization`, `awaiting_artwork`,
   `awaiting_materials`, `awaiting_preparation` (all derived from the first unmet checklist
   item, never picked by hand), then `ready`, `in_production`, `quality_control`,
   `ready_for_pickup`, `picked_up`.** "Production Complete" in the brief = leaving quality
   control. Pickup is recorded on its own and sets `picked_up`.
5. **When an order is "done".** **Its `state` becomes `completed` only when it has been
   picked up AND paid.** A district order collected but unpaid leaves the production lists
   and stays visible under Outstanding payments.
6. **Materials not needed** (customer-supplied garments, laser work on stock material).
   **An order can be marked "No purchasing needed", which satisfies the materials item.**
   Otherwise materials = every non-cancelled purchase fully received.
7. **Several designs on one order** (front + sleeve, or a shirt and a bag). **Each design is
   its own artwork lineage; the artwork item is satisfied when every design's latest version
   is approved, or artwork is marked Not Required.**
8. **Checks vs. the balance.** The brief keeps check collection separate from the balance.
   **The balance only moves when a payment is recorded. Recording a check as collected offers
   to record the payment too (linked), and "cleared" is a separate flag on the collection.**
   The dashboard shows "collected, not yet cleared" separately. Alternative: count the money
   only once cleared. Your call.
9. **Who can override** (second active job, releasing an unpaid regular order).
   **The owner role, with a required reason, logged.** Both current users are owners, so for
   now this is a deliberate confirm step, not a permission wall.
10. **Pickups.** **One pickup per order.** Partial pickups are deferred unless you say they happen.
11. **Production progress.** **Units completed out of the order's total quantity, with
    +/- quick actions.** Progress notes go in the order notes.
12. **Shop time zone. Still needed from you** (Eastern / Central / Mountain / Pacific).
13. **The dashboard changes from the approved Phase 1 layout.** **One design round up front
    (M0) covering the new dashboard, the order workspace, New order, customer pages,
    Production, and Payments, reviewed by you before any of that UI is built.** The
    backend milestones don't wait for it.
14. **New pages.** The brief wants most work in the order workspace. **Additions: a
    Production page (queue) and a Payments page (outstanding + checks to collect). Purchasing
    stays inside the order, plus a "materials awaiting arrival" list on Production.** No other new pages.

## 5. Prioritized checklist

Each milestone ships the same way: API + migration → Codex review → fixes → UI → Codex
review → fixes → that milestone's acceptance tests → deploy to the protected site with
sample data so the family can try it. "Who" = the model per task (Sonnet for specified
build work, Opus where a thin implementation would pass tests and be wrong, Codex for pure
logic it can test, Claude for design, integration and verification).

### M0 — Foundations (no user-visible change)
- [ ] Your answers to §4; record them in DECISIONS.md. *(Arturo)*
- [ ] Wipe the remote sample data, keep users 1–2. *(Claude, after your go)*
- [ ] Pure domain rules + tests: readiness checklist (the five items, which one is missing, the
      derived awaiting status), quote transitions/supersede/`items_revision`, line and quote
      totals with discounts and charges, payment balance and status, purchase status from
      receipts, money parsing, shop-time-zone "today". *(Codex writes; Claude verifies and
      extends the SQL↔domain parity test to the new gate)*
- [ ] Design round: dashboard, order workspace, New order, customer, Production, Payments. *(Claude; your review)*

### M1 — Customers, orders, quotes, authorization (brief Step 2) → acceptance 1, 2, 3, 4, 6
- [ ] Migration 0002 + schema tests. *(Opus; Codex reviews)*
- [ ] Customers API: list/search, detail, create/edit, contacts. *(Sonnet)*
- [ ] Orders write API: create from customer defaults, edit header (conflict guard), items
      editor writes, cancel/reopen, assignee, notes, **record/revoke direct authorization**,
      the **cross-customer contact check** carried over from Phase 1. *(Opus)*
- [ ] Quotes API: new version from items, duplicate, reorder, transitions, immutability. *(Opus, same task as orders: they share `items_revision`)*
- [ ] UI: customer pages, New order, items + size grid, quote panel, authorization panel, ⌘K results. *(Sonnet)*

### M2 — Artwork and PO documents (brief Step 2, artwork) → acceptance 5, 6
- [ ] Upload API: type allowlist by magic bytes, 50 MB limit, sha256, write-once R2 keys,
      authenticated downloads only, SVG served as attachment, previews generated in the
      browser for TIFF/PDF. *(Opus; Codex security review)*
- [ ] Artwork versions, approval per version (with customer approval method), Not Required,
      new version resets approval; PO document upload. *(Opus, same task)*
- [ ] UI: artwork tab (designs, versions, previews, approve), PO documents. *(Sonnet)*

### M3 — Purchasing and preparation (brief Step 3) → acceptance 7, 8, 10
- [ ] Migration 0003; suppliers (JDS default, add new); purchases; receipts (partial);
      "No purchasing needed"; prep status; **gate extended to all five items** in the domain
      and in the SQL guard, with the parity test. *(Sonnet for CRUD; Opus for the gate change)*
- [ ] UI: purchasing panel, receipts, prep, **readiness checklist** at the top of the workspace. *(Sonnet)*

### M4 — Production queue (brief Step 4) → acceptance 9, 11, 12, 17 (production part)
- [ ] Migration 0004; queue ordering; start / QC / ready for pickup transitions; units
      completed; one-active-job index + owner override; production history. *(Opus; Codex
      reviews concurrency specifically)*
- [ ] UI: Production page (Ready to start / In production / Completed), dashboard current job +
      upcoming + action required. *(Sonnet)*

### M5 — Pickup and payments (brief Step 5) → acceptance 13–16, 17 (payments part)
- [ ] Migration 0005; pickups (notify, collect, unpaid-release override); payments (multiple,
      derived balance/status); check collections (all five statuses, cleared separate). *(Opus; Codex reviews the money)*
- [ ] UI: pickup panel (also from the dashboard), payments panel, Payments page with checks
      to collect, dashboard Outstanding payments + Ready for pickup. *(Sonnet)*

### M6 — Polish and validation (brief Step 6)
- [ ] Two end-to-end lifecycle tests through the real UI: a regular customer (direct
      authorization, pay at pickup, unpaid-release override) and a school district (PO,
      pickup before payment, check collected → deposited → cleared). Together they cover
      acceptance 1–17.
- [ ] Phase 1 carry-overs: the ES column overflow, focus after "Record approval".
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
