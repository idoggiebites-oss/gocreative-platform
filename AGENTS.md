# GoCreative platform — shared agent instructions

Business management app for GoCreative Designs, a family print shop (screen print,
embroidery, DTG, laser) whose main customers are school districts. It is built
as a base platform to be redeployed for other small businesses. Claude Code
builds; Codex reviews and tests. Both read this file first.

## Where things live

- [SPEC.md](SPEC.md) — the product requirements as Arturo wrote them. [DECISIONS.md](DECISIONS.md) overrides it where they differ.
- [SPEC-phase2.md](SPEC-phase2.md) — the authoritative Phase 2 brief; [PHASE2_PLAN.md](PHASE2_PLAN.md) — its implementation plan, milestones and open questions.
- [ARCHITECTURE.md](ARCHITECTURE.md) — stack, layering, schema, security, testing, cost.
- [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md) — tokens, type, the two layouts, motion.
- [ROADMAP.md](ROADMAP.md) — phases, the current phase's tasks, and who runs each one.
- [SPEC-post-phase2.md](SPEC-post-phase2.md) — the post-Phase 2 brief; [PLATFORM_VISION.md](PLATFORM_VISION.md) (the unnamed platform vs GoCreative, its first client), [PLATFORM_ARCHITECTURE_REVIEW.md](PLATFORM_ARCHITECTURE_REVIEW.md), [SAAS_READINESS.md](SAAS_READINESS.md), [STOREFRONT_PLAN.md](STOREFRONT_PLAN.md).
- [DECISIONS.md](DECISIONS.md) — append-only, dated: what was decided, why, and who decided it.
- [LEARNINGS.md](LEARNINGS.md) — append-only, dated: what cost time, and the rule that prevents it.
- `notes/` — durable how-tos, one topic per file, named for the topic.
- `worker/` (API: routes → domain → db), `src/` (app/ dashboard, store/ storefront),
  `shared/` (zod schemas, `business.ts`), `migrations/`, `tests/`.

## How to answer

Say whether an answer comes from these files or from general knowledge. Never
invent a fact about the business, its customers or Arturo's preferences. If
the files don't say, say "not in the notes".

## Rules

- `npm run verify` is the gate. Read its exit code, not the tail of its output.
- Business rules go in `worker/domain/` as pure functions with tests. Routes do
  HTTP, auth and validation only. SQL lives only in `worker/db/`.
- `production_status` is written only by `applyProductionChange` (after
  `checkOrderProductionMove`, which uses `readiness()` and `productionFlow`) and by the
  awaiting-status re-derive. Starts re-check the full five-item gate inside the SQL
  UPDATE, and `tests/api/gate-parity.test.ts` keeps that SQL in step with `readiness()`.
  Never add a third path. (`cancelOrder` only drops a running job to the derived status
  as part of cancelling.) A start also takes a production slot (`chooseSlot`; migration
  0005's triggers and `one_job_per_slot` enforce one job, or two with an owner override);
  every other move clears the slot in the same UPDATE.
- Public routes (`/api/public/*`) must never return internal notes, employee
  data, or another customer's records. Every such route gets a boundary test.
- Hiding something in the UI is not access control. Enforce it on the server.
- Uploaded files are write-once. A new upload is a new version.
- Money is integer cents. Timestamps are UTC ISO text.
- Nothing outside `shared/business.ts` and `src/brand.css` may name GoCreative.
- One deployment (Worker + D1 + R2 + Access app) per business. Never point this app at a database holding more than one business (SAAS_READINESS.md §1).
- Claude and Codex work on separate branches and never edit the same files at the same time.
- Never push or deploy unasked. Commit messages go in a file (`git commit -F`), and say why.
- Schema change: run `npm run db:migrate:remote` BEFORE `npm run deploy`.
