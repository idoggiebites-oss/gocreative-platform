# How we work on this project

Moved here from Claude's private memory on 2026-10-31, so it lives with the project and Codex can read it too.

## Who does what

- Claude Code builds and merges. Agents work in worktrees, on the cheapest model that suits the task, and the plan records who runs each task.
- Codex reviews read-only after each merge, re-reviews after fixes, and also reviews plans, not just code.
- Arturo decides. Anything Claude or Codex decides on his behalf is logged in DECISIONS.md for him to overturn.

## What needs Arturo's go

Standing approval (Arturo, 2026-10-31): once a milestone is Codex-reviewed "ready" and `npm run verify` exits 0, apply **additive** migrations remotely and deploy, then report.

Always ask first for anything possibly irreversible: a migration that rebuilds or drops tables or rewrites or deletes live data, wiping data, Access or auth changes, deleting R2 objects.

Before any remote migration, re-check live row counts and pending migrations, and run `npm run backup -- pre-migration` once it is live.

Pushing still needs asking (AGENTS.md); the repo is public.

## Gotchas

- Only one agent can run e2e at a time (port 4280).
- An edited migration needs local state rebuilt; e2e prepare does it. Applied migrations are never edited: use the next number.
- Codex's sandbox can't run vitest.
- Wrangler's OAuth login can't manage Access or run `d1 export`. Use per-table SELECTs.
- Wrangler has no `r2 object list`.
- Commit messages go in a file (`git commit -F`), because backticks in `-m` run as shell substitution.
- Don't put private details in this repo: no staff emails, customer data or backups.
