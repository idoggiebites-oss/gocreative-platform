# Learnings

Append-only. `### YYYY-MM-DD — what happened` → the rule that prevents it.

### 2026-10-30 — UPDATE/DELETE triggers don't make a SQLite row write-once
`REPLACE INTO` / `INSERT OR REPLACE` delete and re-insert without firing them
(the implicit delete fires DELETE triggers only with recursive_triggers on). Codex
caught it. Rule: write-once tables also need a BEFORE INSERT trigger that
rejects an existing key, plus a test for each REPLACE form.

### 2026-10-30 — Non-STRICT SQLite tables accept 1.5 in an INTEGER column
`CHECK (x >= 0)` passes fractional cents. Rule: every money column checks
`typeof(x) = 'integer'`.

### 2026-10-30 — An Access path `app/*` does not protect `/app`
A wildcard path excludes its parent. Rule: list the exact parent path as well,
and check both in a private window after setup.

### 2026-10-30 — Codex's sandbox can't run vitest/tsc -b (cache writes)
It writes the code but can't run the gate. Rule: after a Codex write task,
run `npm run verify` yourself before committing.

### 2026-10-30 — Parallel worktrees collide on the e2e port (4280)
`npm run verify` failed with "localhost:4280 is already used" while another
agent's e2e was running. Not a code failure. Rule: run e2e in only one worktree
at a time, or re-run after the other agent finishes, before concluding that
anything broke.
