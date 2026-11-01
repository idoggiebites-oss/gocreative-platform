# Architecture — GoCreative platform

Source of the decisions: [DECISIONS.md](DECISIONS.md). Requirements: [SPEC.md](SPEC.md).

## Architecture

One Cloudflare Worker serves everything. It has three surfaces on one origin:

| Surface | Path | Who | Auth |
|---|---|---|---|
| Storefront | `/` and `/services/*`, `/inquire` | public | none, Turnstile on submit |
| Dashboard | `/app/*` | employees | **Cloudflare Access** (email one-time code) |
| API | `/api/public/*` and `/api/app/*` | the two above | public: rate limit + Turnstile. app: Access JWT checked in the Worker, plus a role check per route |

- **Frontend:** React 19 + TS + Vite, Tailwind v4, shadcn/ui, Lucide, React Router.
  The storefront and dashboard are lazy-split route trees, so a customer never
  downloads dashboard code. TanStack Query handles server state; lists, filters and
  inline edits need cache invalidation, and writing that by hand is how bugs happen.
- **Worker:** Hono for routing, zod for validation (the same schemas in `shared/` are
  used client-side), and raw SQL with prepared statements. **No ORM.** D1 SQL is plain,
  and migrations are `.sql` files applied by wrangler.
- **Layering:** `routes/` (HTTP, auth, validation) → `domain/` (pure rules: status
  transitions, production authorization, order numbers, pricing) → `db/` (queries).
  The domain layer imports nothing from Workers, so Vitest tests it directly.
- **Files:** R2, private bucket. Uploads stream through the Worker, which checks
  type by magic bytes, size, and SHA-256. Downloads go through
  `/api/app/files/:id`, which checks auth on every request and never serves a
  public R2 URL. SVG is only ever shown via `<img>` (scripts can't run there) and
  is served with `Content-Disposition: attachment` and a sandbox CSP.
- **Previews:** native only, no thumbnails and no extra libraries (decided for M2a,
  2026-10-31): PNG/JPEG render natively, SVG only through `<img>`, PDF in the
  browser's viewer, TIFF in Safari (other browsers offer the download). Originals
  are never modified; `files.preview_key` stays unused.
- **Integration boundary for later (Wave, payments):** for now `invoice_ref` and
  `payment_ref` are free-text fields on the order. A future sync writes those same
  fields. No integration code yet.
- **Customer email:** Cloudflare Email Service through a Worker binding,
  sending from a domain on the shop's Cloudflare account (none exists yet; see
  DECISIONS.md). Two transactional messages for v1: *inquiry received* (Phase 4)
  and *ready for pickup/delivery* (Phase 5). Each send is written to
  `activity_log`. A failed send never blocks the status change that caused it.
- **One codebase, one deployment per business.** Everything specific to
  GoCreative lives in `shared/business.ts` (name, contact details, services and
  production methods, email copy) and in the brand tokens in `src/brand.css`.
  Nothing else in the code may name the business. A second business gets its
  own config, its own Worker, D1 and R2 (wrangler environments, added when that
  business exists), and never shares a database. That keeps the data isolated
  with no tenant IDs, and fixes still reach every business.

## Repository structure

```
print-shop/
  AGENTS.md            shared rules for Claude + Codex (CLAUDE.md = "@AGENTS.md" + capture steps)
  README.md SPEC.md ARCHITECTURE.md DESIGN_SYSTEM.md ROADMAP.md DECISIONS.md LEARNINGS.md
  notes/               one topic per file (deploy, access setup, backups…)
  migrations/          0001_init.sql, …
  shared/              zod schemas + types used by both sides
  worker/
    index.ts           Hono app, mounts route groups
    auth.ts            Access JWT verify → user + role
    routes/            public/, app/  (one file per resource)
    domain/            pure business rules + *.test.ts
    db/                SQL per entity
    files.ts           R2 upload/download, validation
  src/
    app/               dashboard routes + layout (sidebar, search, quick actions)
    store/             storefront routes + layout
    components/ui/     shadcn (copied in, owned)
    components/        shared composed components (StatusBadge, OrderTable…)
    lib/               api client, formatting (money = integer cents)
  tests/
    api/               Vitest on the Workers pool against local D1/R2
    e2e/               Playwright: critical flows + 390px / 1440px screenshots
  scripts/             seed, backup, add-user
```

## Initial schema (D1, Phase 1)

This is the Phase 1 shape. Phase 2 (migrations 0002 to 0007) changed it; see "Phase 2 schema" below, which wins where they differ (for example `estimates` became `quotes`).

IDs are integers. Money is integer cents. Timestamps are ISO text in UTC. Every
FK is declared, and `PRAGMA foreign_keys` is on in D1.

| Table | Key columns | Notes |
|---|---|---|
| users | email UNIQUE, name, role `owner\|staff`, active | Access gives us the identity; this table gives the role |
| customers | kind `district\|organization\|individual`, name, organization, email, phone, internal_notes | idx lower(name), email |
| customer_contacts | customer_id, name, email, phone, title, is_primary | |
| inquiries | raw submission JSON, contact fields, status `new\|converted\|spam`, order_id | **public input lands here only.** Staff converts it, matching or creating the customer. A form submission never writes to `customers` directly |
| orders | number UNIQUE (`2026-0001`), customer_id, contact_id, source `phone\|email\|portal`, due_date, **artwork_status**, **po_required**, **authorized_at/by** (non-PO path), **production_status**, assignee_id, invoice_ref, payment_ref, state `active\|completed\|cancelled` | idx (production_status, due_date), customer_id, due_date |
| order_items | order_id, product, garment_color, method `screen\|embroidery\|dtg\|laser_engrave\|laser_cut\|other`, sizes JSON `{"S":10,"M":24}`, quantity, unit_price_cents, notes | several methods per order |
| files | r2_key, mime, bytes, sha256, preview_key, uploaded_by / via_portal | shared by artwork and PO docs. No column is ever updated after insert |
| artwork | customer_id, order_id, lineage_id, version, file_id, approval_status, notes | UNIQUE(lineage_id, version). A new upload is a new version, never an overwrite |
| estimates | order_id, version, inputs JSON, lines JSON, total_cents, **status** `draft\|sent\|accepted\|declined` | quote status = the latest estimate's status |
| purchase_orders | order_id, po_number, amount_cents, **status** `requested\|received\|under_review\|approved\|rejected\|correction_required` | |
| po_documents | po_id, file_id | a corrected PO is another document, not a replacement |
| notes | entity_type, entity_id, author_id, body | internal only, never on a public route |
| activity_log | actor (user/portal/system), entity_type, entity_id, action, before JSON, after JSON, at | append-only. The app has no UPDATE/DELETE path for it |
| counters | name, year, next | order numbers, incremented atomically |

The five status tracks the spec keeps apart (quote, artwork, PO, production,
invoice/payment refs) stay separate columns or tables. **The production gate** is
one pure function (Phase 1; superseded in Phase 2 by the five-item `readiness()` in
`worker/domain/readiness.ts`, see PHASE2_PLAN.md §4), `canEnterProduction(order, latestPo)`: artwork approved AND
(po_required ? PO approved : authorized_at set). The production-status route is the
only place that writes `production_status`, and it calls that function. It gets a
unit test and an API test.

Deliberately left out: `pricing_rules` (Phase 6 adds it), `sessions` (Access owns
those), and `production_steps` as its own table (production is tracked per order;
stage history lives in `activity_log`).

## Phase 2 schema (migrations 0002 to 0007)

| Migration | Adds |
|---|---|
| 0002 | Whole vocabulary switched at once: customer defaults (`default_po_required`, `default_payment_terms`); order columns (`po_required`, `payment_terms`, `artwork_required`, `items_revision`, `authorization_method/notes`, `state` = `active\|cancelled\|closed`); `order_items.kind` (`product\|charge\|discount`); `quotes` + `quote_items` replacing `estimates` |
| 0003 | `files.filename`, `artwork.design_name`, write-once triggers on artwork versions and PO documents |
| 0004 | `suppliers` (JDS is the default), `order_purchases`, `purchase_receipts`, `orders.materials_required`, `orders.prep_status` |
| 0005 | `orders.production_slot`, `production_override_by/reason`, `queue_position`, `units_completed`; the slot triggers and the `one_job_per_slot` index |
| 0006 | `pickups`, `check_collections`, `payments`; `orders.payment_due_on` |
| 0007 | Unconditional id guards on `artwork`, and payment terms fixed once production is complete |

| Table | Key columns | Notes |
|---|---|---|
| quotes | order_id, version, status `draft\|sent\|accepted\|declined\|superseded`, items_revision (snapshot), total_cents | Only a draft is editable. Triggers freeze an accepted quote and its items; a new version supersedes the old one |
| quote_items | quote_id, position, kind, description, product, sizes JSON, quantity, unit_price_cents | A frozen copy of the order's lines at the time the quote was made |
| suppliers | name, is_default | JDS seeded as the default |
| order_purchases | order_id, supplier_id, description, quantity, sizes JSON, estimated/actual unit cost (cents), ordered_on, expected_on, status `not_ordered\|ordered\|cancelled` | "Partially received" and "received" are **derived** from the receipts, never stored |
| purchase_receipts | purchase_id, quantity, sizes JSON, received_on | One row per delivery, so partial shipments need no special case |
| pickups | order_id UNIQUE, ready_on, notified_on/method, picked_up_on, collected_by_name, release_override_by/reason | One pickup per order. The CHECKs tie each fact to its partner (a pickup date needs a name and a recorder) |
| check_collections | order_id, expected_cents, amount_received_cents, check_number, status `awaiting_payment\|ready_for_collection\|collected\|deposited\|cleared`, available/deposited/cleared dates | Several per order are allowed. Deposited and cleared are statuses of the collection only |
| payments | order_id, amount_cents (positive integer), method, paid_on, request_id UNIQUE, check_collection_id UNIQUE, voided_at/by/reason | Balance and financial status are **derived**: accepted quote total minus non-voided payments. A correction is a void; the row is kept |

### The four status tracks

An order is not one status; four things move independently and no track writes another's column.

| Track | Where it lives | Values |
|---|---|---|
| Production | `orders.production_status` | `awaiting_quote`, `awaiting_authorization`, `awaiting_artwork`, `awaiting_materials`, `awaiting_preparation` (derived from the first unmet readiness item, never chosen by hand), then `ready`, `in_production`, `quality_control`, `production_complete`. Production ends there |
| Fulfilment | the `pickups` row | `not_ready`, `ready_for_pickup` (set when production completes), `customer_notified`, `picked_up`. Picked up means fulfilled, even if unpaid |
| Financial | derived from `payments` and the accepted quote | `unpaid`, `partially_paid`, `paid` |
| Order state | `orders.state` | `active`, `cancelled`, `closed`. Closed = picked up AND paid, set in the same batch as the write that completes the second condition |

### The production slot model

`orders.production_slot` is NULL, 1 or 2, and the database enforces every rule so no SQL path can bypass them:
`one_job_per_slot` (a unique index) means at most two jobs ever run; entering slot 2 needs another order in slot 1,
an active owner as `production_override_by` and a non-blank reason (triggers), and the override columns are
immutable afterwards; an AFTER trigger writes the `production_override` activity row. A start is one batch: an
UPDATE guarded by `state='active' AND production_status='ready' AND production_slot IS NULL` that **re-checks the
full five-item readiness gate inside the SQL** (`tests/api/gate-parity.test.ts` keeps that SQL in step with
`readiness()`), then the activity INSERT guarded by `changes() = 1`. Every other move out of `in_production` clears the
slot and the override columns in the same UPDATE. A losing concurrent start matches no row or hits the index, and
the route answers 409 (`production_busy` names the running job).

### Payment de-duplication

Every payment carries one of two keys, enforced by a CHECK. A manual payment has a client-generated `request_id`
(UNIQUE): the form keeps one id per submission and reuses it across retries, so a lost response and a second click
record one payment; on a UNIQUE hit the route reads the stored row and `matchRetry` returns it if the details are
identical, or 409 `request_id_conflict` if they are not. A check collection produces its payment in one batch
(UPDATE the collection `WHERE status IN (...)`, INSERT the payment `WHERE changes() = 1`, then the activity row), and
`check_collection_id` is UNIQUE, so a retry or a competing collect changes nothing. Voids keep the row and its keys.

### Single write paths

| Data | Only written by |
|---|---|
| `production_status` | `applyProductionChange` (after `checkOrderProductionMove`, which uses `readiness()` and `productionFlow`) and the re-derive of the awaiting statuses; `cancelOrder` only drops a running job as part of cancelling |
| Quote acceptance | `checkQuoteAcceptable`; a charge-only or empty snapshot can never be accepted |
| Payments and check collections | the collect and record-payment batches in `worker/db/`, with the domain rules (`balance`, `matchRetry`, `checkCheckTransition`) |
| Pickup | the pickup batch, which also closes the order if it is now paid; the unpaid-release rule is enforced on the server and the override is owner-only with a reason |
| `activity_log` | inserted in the same batch as the change it records; UPDATE and DELETE are blocked by triggers |
| Business dates | `businessToday()` (`shared/businessDate.ts`), shop time zone America/Chicago; never the UTC date |

Writes from the browser send the `expectedVersion` they read; a stale one is a 409 `conflict_retry`.

## Testing, security, cost

**Tests**
- Vitest on `domain/`: transitions, production gate, order numbering.
- Vitest API tests (`tests/api`) run the Hono app in Node against an in-memory `node:sqlite`
  D1 adapter (`tests/api/d1.ts`) and an R2 fake (`tests/api/r2.ts`); they are not in the Workers
  pool. These include the **boundary tests**: public routes never return internal notes, employee
  data or another customer's records; `/api/app/*` with no Access JWT returns 401; a `staff`
  user hitting an owner-only route returns 403.
- Vitest `tests/d1` runs the real workerd D1 (via `getPlatformProxy`) for batch semantics and uploads.
- Playwright for the critical flows, run against wrangler/vite on port 4280 with its own local D1, plus screenshots at 390px and 1440px.
- One `npm run verify` gate (typecheck, lint, unit, api, e2e). Read its exit code.
- **Codex** reviews each phase's diff read-only (`codex exec -s read-only`) with a
  checklist covering security, SQL and accessibility, before merge. Claude builds and
  Codex reviews, on separate branches, so they never edit the same files at once.

**Security** (on top of the above)
- Access handles login, MFA and session expiry.
- The Worker re-verifies the Access JWT (signature and audience), so even if
  Access were misconfigured, the API would refuse.
- zod on every input. Upload limits: 50MB, type allowlist, magic-byte check.
- Public routes (storefront, not built yet): Turnstile once per submission session, session caps and an
  admission budget, an off switch. See STOREFRONT_PLAN.md §4. *(Corrected 2026-11-01: the rate limiting
  and Turnstile were planned, not built.)*
- Secrets live in wrangler secrets only.
- Planned, not built yet: an app-wide CSP and security headers (today only file downloads carry a CSP), and a
  service worker (no PWA yet). When one is added, it must never cache `/api` or `/files`.

**Backups** *(corrected 2026-11-01: there is no backup script yet; the architecture review lists it as a fix-now item)*
- D1 Time Travel gives point-in-time restore. Its retention depends on the plan; check it in the dashboard.
- To build (STOREFRONT_PLAN S0b): a scripted per-table JSON export of the live D1 (`wrangler d1 export --remote`
  failed with auth error 10000 on this account), plus a restore drill into a scratch local D1, documented in `notes/`.
- R2 originals are write-once and are never deleted by the app (the storefront's cleanup of expired,
  unsubmitted uploads will be the one exception).

**Cost**
- Free tier covers this load comfortably: Workers 100k requests/day, D1 5GB,
  Access ≤50 users, Turnstile free.
- **The one real meter is R2 storage.** 10GB is free, then about $0.015/GB-month.
  Print-ready TIFFs and PDFs run 20–200MB each, so a busy year could pass 10GB.
  Even then it's cents to a few dollars a month. The dashboard will show total
  storage used.

