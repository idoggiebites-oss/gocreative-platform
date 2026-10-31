# Roadmap


The spec's phases stay, with one change: **Phase 1 ends with your three screens**,
so the family has something real to judge early.

| Phase | Builds | Done when |
|---|---|---|
| 1 Foundation | scaffold, wrangler + D1 + R2, Access + users/roles, tokens + shell (sidebar, ⌘K, mobile nav), migration 0001, seed data, **Dashboard, Order list, Order detail** (read + inline status changes), all 7 docs | deployed behind Access; family can click through seeded orders on desktop + phone |
| 2 Internal ops | customers + contacts CRUD, order create/edit with items + sizes, notes, activity feed, search/filter | a real phone order can be entered end-to-end |
| 3 Artwork + POs | R2 uploads, previews, versions, approvals, PO docs + workflow, production gate | an order can't reach production without approval; tests prove it |
| 4 Storefront | brand pages, services, inquiry form + uploads, Turnstile, inquiry review queue | customer submits; staff converts it into an order |
| 5 Production | queue/board by stage, assignees, deadlines, QC, completion | daily production runs from the dashboard |
| 6 Estimator | browser k-means quantisation, palette + per-colour previews, complexity/gradient flags, configurable pricing rules; the screen count is **confirmed by a person** | estimate drafted from an upload, confirmed by staff |

I break each phase into tasks with a per-task model table when it starts, not now.


## Phase 1 tasks — complete (2026-10-30)

Models assigned by Claude for token efficiency (Arturo, 2026-10-30: "assign models for efficiency and use codex as well").
Codex reviews the phase diff read-only before merge.

| # | Task | Shape | Model | State |
|---|---|---|---|---|
| 1.1 | Scaffold: Vite/React/TS, Tailwind v4, shadcn, Hono worker, wrangler (D1 + R2), Vitest + Playwright, `npm run verify` | mechanical, well-trodden | Claude (did it inline) | done |
| 1.2 | Migration 0001 (full schema in ARCHITECTURE.md) + seed script with sample orders in every status | mechanical given the schema | Sonnet agent | done (90745e4) |
| 1.3 | Domain rules: status enums, `canEnterProduction`, order numbering, plus unit tests | business rules; a thin version passes and is wrong | **Codex** (writes + tests) | done (ea63a82), Claude reviewed |
| 1.4 | Auth: Access JWT verify, `users` lookup, role guard, 401/403 API boundary tests | trust boundary | Opus agent, after 1.2; Codex reviews | done (99eed65, hardened 787c9d9 after Codex review) |
| 1.5 | Design pass: tokens + mockup of the 3 screens for Arturo to review (design skills) | taste + judgment; **review gate** | Claude | done, approved 2026-10-30 (design/mockup/) |
| 1.6 | App shell: sidebar, ⌘K search, mobile nav, `brand.css`, design tokens, **EN/ES toggle + i18n foundation** | build to the approved mockup | Sonnet agent | done (bbe36c7) |
| 1.7a | Read API (dashboard, order list, order detail) + PO and production status changes through the domain rules, activity log, API tests | wiring with a single write path | Sonnet agent; Codex reviews | done (713370d, hardened 1959139 + gate parity test 4358ff5) |
| 1.7b | Dashboard, order list, order detail screens on the 1.7a API, EN/ES | build to the mockup | Sonnet agent; Codex reviews | done (d268283, review fixes 6296911) |
| 1.8 | Deploy: create D1/R2, Access app, add the 2 users, ship to workers.dev | needs Arturo's emails + login | Claude | done 2026-10-30: live at gocreative.idoggiebites.workers.dev behind Access; both staff emails verified |

## Carried into Phase 2

- An order's contact and an artwork's order must belong to the same customer.
  Enforce this in the order and artwork routes, with negative tests. (Codex
  review of 1.2; ownership triggers were deliberately not added.)
- Before real orders go in: wipe the sample data from the remote DB (keep the
  `users` rows for ids 1 and 2).
- Polish: in Spanish at 1440px the orders table's Estimate column overflows its card
  by a few pixels (scrolls inside it). Shorten the long ES chip labels or tighten columns.
- Focus is lost after the "Record approval" button or a production-tab button
  disappears (the dropdown case is fixed). Return focus to a stable element.
- Native Spanish read-through of shared/i18n/es.ts by the family.

## Phase 2 plan — internal operations (drafted 2026-10-30, awaiting Arturo)

**Done when:** a real phone or email order can be entered end to end: find or
create the customer, add items and sizes, record artwork approval and the
authorization or PO, and move the order into production. Then the sample data is
wiped and the family starts using it for real.

Defaults until Arturo says otherwise (Q1–Q4 in the session):
- Q1: simple quotes are in (versions, Draft → Sent → Accepted/Declined; no PDF or email).
- Q2: a `not_needed` artwork status satisfies the production gate.
- Q3: the shop time zone lives in `shared/business.ts` and drives "today",
  overdue, and this week.
- Q4: a mockup of the New order form and customer detail gets reviewed before the UI is built.

| # | Task | Shape | Who | Depends on |
|---|---|---|---|---|
| 2.0 | Mockup: New order form, customer list + detail (review gate) | taste + judgment | Claude | — |
| 2.1 | Shared pure helpers + tests: dollars↔cents parsing, size sets (in business.ts), item and quote totals, shop-timezone "today", order-number formatting for the counter | pure, testable | **Codex** writes, Claude verifies | — |
| 2.2 | Migration 0002: `not_needed` artwork status, `notes` edit-free, `updated_at` triggers if needed; atomic order-number counter (`UPDATE … RETURNING`) | schema + one concurrency point | Sonnet; Codex reviews | 2.1 |
| 2.3 | Customers API: list/search, detail (contacts, orders, notes), create/update, contacts add/update/archive, add note; activity log on every write | CRUD with validation | Sonnet; Codex reviews | 2.2 |
| 2.4 | Orders write API: create (with items), edit header with an `updated_at` conflict guard, replace items atomically, record authorization (non-PO), set artwork status (manual until Phase 3), cancel/reopen, assignee, add note; awaiting-status sync after each prerequisite change; **cross-customer contact check** (carried over) | data integrity, single write paths | **Opus**; Codex reviews | 2.2 |
| 2.5 | Quotes API: create a version from the current items, status transitions, the latest drives the dashboard | small, rules-based | Sonnet; Codex reviews | 2.4 |
| 2.6 | Global search API for ⌘K (orders, customers, PO numbers) | small SQL | Sonnet | 2.3 |
| 2.7 | Customers UI: list + search, detail, create/edit, contacts | build to the 2.0 mockup | Sonnet; Codex reviews | 2.0, 2.3 |
| 2.8 | Order create/edit UI: New order flow (customer picker with inline create), items editor with size grid, header edit, authorize / artwork / cancel controls, notes composer, assignee, quote panel, ⌘K search results | build to the 2.0 mockup | Sonnet; Codex reviews | 2.0, 2.4–2.6 |
| 2.9 | Phase 1 polish carry-overs (ES column overflow, focus after Record approval, timezone switch-over) | small | Sonnet | 2.8 |
| 2.10 | Wipe the sample data on remote (keep users 1–2), migrate, deploy, smoke test signed in | ops | Claude, with Arturo's go | all |

Running order: 2.0 ∥ 2.1 → 2.2 → 2.3 ∥ 2.4 → 2.5 ∥ 2.6 → (mockup approved) 2.7 ∥ 2.8 → 2.9 → 2.10.
Every merged task gets a read-only Codex review and a fix pass before the next
one builds on it. e2e runs in one worktree at a time.

Deliberately not in Phase 2: file uploads (Phase 3), PO documents (Phase 3),
the storefront and inquiries (Phase 4), the production board (Phase 5), quote
PDF/email, user management screens (2 users; edit via SQL until there are more).
