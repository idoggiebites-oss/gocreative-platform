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
- `production_status` is written in one place, and only after `canEnterProduction`
  allows it. Never add a second path.
- Public routes (`/api/public/*`) must never return internal notes, employee
  data, or another customer's records. Every such route gets a boundary test.
- Hiding something in the UI is not access control. Enforce it on the server.
- Uploaded files are write-once. A new upload is a new version.
- Money is integer cents. Timestamps are UTC ISO text.
- Nothing outside `shared/business.ts` and `src/brand.css` may name GoCreative.
- Claude and Codex work on separate branches and never edit the same files at the same time.
- Never push or deploy unasked. Commit messages go in a file (`git commit -F`), and say why.
- Schema change: run `npm run db:migrate:remote` BEFORE `npm run deploy`.
