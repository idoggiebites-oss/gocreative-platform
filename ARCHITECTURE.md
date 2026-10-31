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

## Initial schema (D1)

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

## Testing, security, cost

**Tests**
- Vitest on `domain/`: transitions, production gate, order numbering.
- Vitest on the Workers pool for the API, against local D1/R2. These include the
  **boundary tests**: public routes never return internal notes, employee data or
  another customer's records; `/api/app/*` with no Access JWT returns 401; a
  `staff` user hitting an owner-only route returns 403.
- Playwright for the critical flows, plus screenshots at 390px and 1440px.
- One `npm run verify` gate (typecheck, lint, unit, api, e2e). Read its exit code.
- **Codex** reviews each phase's diff read-only (`codex exec -s read-only`) with a
  checklist covering security, SQL and accessibility, before merge. Claude builds and
  Codex reviews, on separate branches, so they never edit the same files at once.

**Security** (on top of the above)
- Access handles login, MFA and session expiry.
- The Worker re-verifies the Access JWT (signature and audience), so even if
  Access were misconfigured, the API would refuse.
- zod on every input. Upload limits: 50MB, type allowlist, magic-byte check.
- Rate limiting: Workers rate-limit binding on public routes, plus Turnstile.
- Secrets live in wrangler secrets only.
- CSP, no inline scripts. The service worker never caches `/api` or `/files`.

**Backups**
- D1 Time Travel gives point-in-time restore. Free-plan retention is 7 days.
- `npm run backup` does `wrangler d1 export` to a dated file. Run it monthly
  alongside the Wave import. A restore drill is documented in `notes/`.
- R2 originals are write-once; deleting them is an owner-only action and is logged.

**Cost**
- Free tier covers this load comfortably: Workers 100k requests/day, D1 5GB,
  Access ≤50 users, Turnstile free.
- **The one real meter is R2 storage.** 10GB is free, then about $0.015/GB-month.
  Print-ready TIFFs and PDFs run 20–200MB each, so a busy year could pass 10GB.
  Even then it's cents to a few dollars a month. The dashboard will show total
  storage used.

