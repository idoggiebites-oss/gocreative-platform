# Platform architecture review (post-Phase 2)

> 2026-11-01, at commit `ff25f30` (Phase 2 live). Lead: Claude. Independent review: Codex, run read-only over the
> same tree and summarised here with its file:line evidence; its full report is in the session scratchpad.
> **(C)** marks a point Codex raised that I hadn't, and §8 lists where we differ. This is an assessment, not a
> refactor plan (brief §4).

## 1. Verdict

A well-defended, **single-business printing application with reusable foundations**. It is not yet a
configurable multi-industry platform, and it must never be pointed at a database shared by several businesses.
Codex's summary, which I agree with: *"changing branding alone would not support a repair shop."* That is fine
for now. The brief says to build for GoCreative today and generalise when a second real client shows what has
to vary.

## 2. Phase 2 status, verified

| Claim | Evidence |
|---|---|
| Phase 2 (M0–M6) live | Worker `52951268`, migrations 0001–0007 applied remotely; PHASE2_PLAN.md all milestones ticked |
| Tests | `npm run verify` exit 0: 480 unit/API (32 files, incl. real-workerd D1 checks), 117 Playwright (desktop + phone) |
| Acceptance 1–17 | Two lifecycle e2e tests drive the UI end to end (tests/e2e/lifecycle.spec.ts) |
| Security | Codex whole-phase review "Phase 2 security: ready" after fixes (same-origin writes, body caps, payment-terms rules, 0007 guards) |
| Not done / not true | **No backup command** (ARCHITECTURE.md describes `npm run backup`; package.json has none) **(C)**; **no PWA** (no manifest/service worker); **no app-wide CSP** (only the file-download CSP) **(C)**; storefront is a placeholder |

## 3. How the code is organised

```
worker/   index.ts → routes/ (HTTP, auth, zod)  → domain/ (pure rules, tested)  → db/ (all SQL, D1)
shared/   enums, API types, money, business dates, i18n (en/es), business.ts (per-deployment facts)
src/      app/ (dashboard)  store/ (storefront placeholder)  components/ui (shadcn)
migrations/ 0001–0007   tests/ api (node:sqlite D1 adapter), d1 (real workerd), e2e (Playwright)
```

Size: domain ~1.0k lines, db ~1.75k, routes ~1.4k, shared ~2.5k, dashboard UI ~4.6k, tests ~6.9k.

**What holds up well:**
- Business rules live in `worker/domain` as pure, tested functions, and the UI reuses them for menus and labels.
- SQL lives only in `worker/db`, always with bound values. The only interpolation is from fixed fragments.
- Every write and its audit row go in one D1 batch, with optimistic versions, and the database refuses what the
  app must never do: triggers for immutability, slots, payment de-dup and owner-only overrides.

**Small exceptions** **(C)**:
- `index.ts`'s health check runs SQL outside `db/`.
- Some policy sits in routes rather than domain: the payment-terms permissions and the production edit locks.
- The UI duplicates a few locks for display, such as `OrderPanels.tsx:304`. The server still enforces them;
  these are drift risks, not bypasses.

## 4. Reusable vs printing-specific

| Layer A — platform core (reusable as is or nearly) | Notes |
|---|---|
| Auth: Access JWT re-verification + `users` role lookup (`worker/auth.ts`) | Tied to one Access app per deployment (see SAAS_READINESS) |
| Roles owner/staff, server-enforced owner actions | Two fixed roles; enough until a client needs more |
| Optimistic concurrency, batch + audit-row pattern, `activity_log` (write-once) | Core infrastructure |
| Money (integer cents), business dates/time zone, i18n plumbing | Core |
| Customers + contacts, notes | Core, **but** customers carry printing/district defaults (`default_po_required`, kind `district`) **(C)** |
| Orders: number, state (active/cancelled/closed), items, quotes/versions, payments, pickups | Core-shaped, **but** `orders` also carries artwork/materials/prep/production columns and `order_items` carries `method`, `garment_color`, `sizes` |
| File storage pipeline (`worker/files.ts`: sniff, stream, hash, write-once, safe downloads) | Core, **but** a file can only be served when linked through artwork or a PO document **(C)** |
| UI primitives, form/conflict patterns (`form.tsx`), shell, ⌘K | Core |

| Layer B — printing module (today woven into core tables) | Where |
|---|---|
| Artwork lineages, versions, approval | `artwork` table, `ArtworkTab`, readiness item "artwork" |
| Customer purchase orders + documents | `purchase_orders`, `po_documents`, readiness item "authorization" (PO branch) |
| Garment purchasing, receipts (JDS default) | `suppliers`/`order_purchases`/`purchase_receipts`; **JDS is seeded in a shared migration (0004)** **(C)** |
| Production prep, slot model, units completed, QC | `orders.prep_status`, 0005 slots, `productionFlow.ts` |
| Size grids, print methods, garment colours | `business.sizes`, `METHODS` enum, `order_items` columns, `ItemsEditor` |
| District check collection | `check_collections` (generic enough: "collect a cheque from the customer") |
| The dashboard | KPIs, attention priorities, action groups are all printing-specific (`worker/domain/dashboard.ts`) **(C)** |

**Branding:** `shared/business.ts` holds only the name, time zone, order prefix and sizes. GoCreative also
appears in `index.html`'s `<title>`, and in infrastructure names (`wrangler.jsonc`, `package.json` scripts),
which the brief says to leave. Translations assume printing vocabulary throughout. That is localisation, not
configuration **(C)**.

## 5. Workflow configurability

GoCreative's flow is encoded, deliberately, in several places that must agree:

| Hardcode | Where |
|---|---|
| Production vocabulary + DB CHECK | `PRODUCTION_STATUSES` (`shared/enums.ts:20`), `orders` CHECK (0002:67) |
| Transition graph, mandatory QC | `productionFlow.ts:20` |
| Five readiness items in fixed order (quote → authorization → artwork → materials → preparation), twice: TypeScript + SQL | `readiness.ts:34`, `worker/db/orders.ts` (`GATE_OK`, `PRE_PRODUCTION`), parity test |
| One job (two with override) | 0005 slots, `chooseSlot` |
| Quotes need a product line with a print method | `quotes.ts:61`, 0002:272, 0002:100 |
| Pickup / payment-terms lock keyed to `production_complete` | 0006, 0007 |

**A repair-shop flow** (request → inspection → estimate → approval → repair → pickup) could share this codebase
eventually, but **cannot be configured today**. Inspection must precede the estimate, there is no
ticket/equipment model, a labour-only estimate can't be accepted, and the capacity model differs. Switching
artwork and materials off would not create those concepts, and relabelling "preparation" as "inspection" would
hide incompatible ordering **(C)**.

**What would make it possible later, without a workflow engine:**
1. Readiness items as a per-module list. Each module contributes a `{ key, check(), sqlCheck }` item, and the
   parity test iterates over them.
2. Order stages per business, held in a table instead of a CHECK.
3. Line-item "kinds" owned by modules: printing lines carry method/sizes; a repair line carries
   labour/parts.

All three are table rebuilds or rewrites of the most heavily guarded code. That is the strongest reason not to
attempt them until a second real client defines the requirements. **Defer.**

## 6. Tight couplings that would be expensive to separate later

1. **Readiness in TypeScript and in SQL.** This is intentional, for atomic enforcement; any module system must
   keep both and the parity test.
2. **`orders` as a wide table** carrying printing columns, with printing triggers keyed to its statuses.
3. **Quote acceptance tied to printing-shaped product lines.**
4. **File access tied to artwork and PO links.** The storefront will add inquiry links, the third kind; a
   generic "attachments" relation would be the general form.
5. **Dashboard, API types, navigation and translations** assume every capability exists.

None of these blocks the storefront. Couplings 4 and 5 are the ones the storefront touches.

## 7. Recommendations

| Class | Recommendation |
|---|---|
| **Fix now** (before storefront) | **Backups:** a working, scripted D1 export (per-table JSON dump, since `wrangler d1 export --remote` failed with auth error 10000 here), plus a written restore drill and D1 Time Travel noted as the second line. Correct ARCHITECTURE.md's claim. **(C)** |
| Fix now | **Public intake design:** allowlisted schema, a session-bound Turnstile check, upload tokens tied to one submission with count/byte caps and expiry, throttling that tolerates shared school networks, an emergency off switch, abandoned-upload cleanup, and idempotent conversion. Details in STOREFRONT_PLAN.md. **(C)** |
| Fix now | **Access re-scope verification** for `/app`, `/app/*`, `/api/app`, `/api/app/*` on every hostname (workers.dev and the custom domain), tested from outside after the change. **(C)** |
| Fix now | Storefront content and module switch live in business configuration, not components (STOREFRONT_PLAN §8), so the first client-specific experience doesn't add new GoCreative literals to shared code. |
| Before commercial launch | Define the configuration boundary honestly in the offer: "configured for your business" means modules + terminology + branding + settings, and a new industry means a pilot and development. **(C)** |
| Before commercial launch | Move the JDS default supplier out of the shared migration into per-business seed/config. **(C)** |
| Before commercial launch | App-wide CSP and security headers; MFA policy for Access; secret scanning in CI; use a GitHub no-reply author email (the public history shows a personal Gmail in commit metadata, which is not a credential) **(C)** |
| Before commercial launch | Audit policy: decide which reads (file downloads, exports) and admin actions must be logged; stop copying contact details and internal notes verbatim into append-only audit JSON, since they then can't be erased **(C)** |
| Defer | Module extraction, per-business stages, generic line kinds, a generic attachments table, a configurable dashboard: all when the second-industry pilot defines them. |

## 8. Disagreements and open points

| Topic | Claude | Codex | Resolution |
|---|---|---|---|
| Add `tenant_id` columns now "to be ready" | No | No: "unused tenant columns would not create safety" | Agreed: don't |
| How much to generalise before the storefront | Only the storefront's own boundaries (module switch, content in config) | Same; flags the risk of claiming "all business-specific behaviour lives in business.ts" | Agreed; that claim is retired from the docs |
| Storefront Turnstile on every upload (my first draft) | — | Tokens are single-use, valid 5 min: verify once per submission session | **Codex is right**; STOREFRONT_PLAN revised |
| IP-only rate limits | Drafted per-IP limits | School networks share IPs; use session limits + storage admission budget, not strict IP blocks | Codex is right; revised |
| Severity of the Gmail author address in public history | Low | Personal information, not a credential; no history rewrite | Agreed: switch to a no-reply address going forward; Arturo's call |
