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

## Phase 2 — see [PHASE2_PLAN.md](PHASE2_PLAN.md)

The authoritative brief is [SPEC-phase2.md](SPEC-phase2.md) (2026-10-30). It replaced
the plan drafted earlier the same day and absorbs the old Phase 3 (artwork uploads, PO
documents) and Phase 5 (production queue). The storefront becomes Phase 3 and the
estimator Phase 4.
