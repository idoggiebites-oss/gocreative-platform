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

### 2026-10-30 — An edited migration doesn't re-run on a database that already applied it
Migration 0002 was edited after the e2e state had applied it, so the browser tests
ran against the old schema ("no such column: orders.version"). Rule: until a
migration has been applied remotely it may be edited, but every local state must
be rebuilt. `tests/e2e/prepare.ts` now deletes `.wrangler/e2e` on every run.
Locally, run `rm -rf .wrangler/state` before `db:migrate`. Once a migration has
been applied remotely, never edit it; write a new one.

### 2026-10-31 — `BEFORE UPDATE OF col` triggers miss rowid aliases; guards must be unconditional
Codex found, in several milestones, that an immutability trigger written as `BEFORE UPDATE OF customer_id, version`
never fires for an update that goes through `id` or another rowid alias, so the row could be re-keyed. Rule: an
immutability guard is an unconditional `BEFORE UPDATE` with a `WHEN NEW.x IS NOT OLD.x` for every protected column
(including the id), and a test that updates through `rowid` and `id`, not only the named columns. Migration 0007 did
this for `artwork`.

### 2026-10-31 — `INSERT OR REPLACE` on a UNIQUE column deletes the old row without any delete trigger
`REPLACE` resolves a UNIQUE conflict by deleting the existing row, so a "write-once" or "never deleted" table can lose
a stored (even approved) row while its delete trigger never fires. Rule: every write-once table gets a BEFORE INSERT
trigger that aborts when the id or the unique key already exists (`pickups_no_replace`, `artwork_no_replace`), and the
app never uses REPLACE or `ON CONFLICT DO UPDATE` on them.

### 2026-10-31 — A test that only stubs the route can pass while the rule is gone
Several Codex findings were tests that mocked the response or checked only the route's status, so removing the rule
(the SQL guard, the trigger) left them green. Rule: for every rule that matters, one test goes through the real
database path with the rule's enforcement removed in mind, and asks "would this still pass if the rule were deleted?"
Parity tests (`gate-parity`) and direct-SQL bypass tests exist for this reason.

### 2026-10-31 — Conflict recovery must wait for a SUCCESSFUL refetch
After a 409 `conflict_retry` the dialog shows the notice and must replace its stale values with fresh ones. Unblocking
Save as soon as the version moved, or when the refetch merely finished, lets a failed refetch send stale values with a
new version. Rule: `useEditSession` blocks saving until the refetch for the new version has succeeded (`ready`), and
there is an e2e test where the refetch returns 500 and Save stays disabled until a good one lands.

### 2026-10-31 — A retry identity must outlive the dialog (module-level `requestId`)
A payment's `requestId` generated inside the dialog changed when the dialog closed and reopened, so a lost response
followed by a "try again" recorded two payments. Rule: the pending submission (requestId plus the details it was sent
with) lives at module level, shared by every entry point (the tab and the Payments page), is reused only while the
details are identical, and is cleared on success or on a definitive refusal. Changed details are a new submission.

### 2026-10-31 — Focus is lost when the focused button disappears; fix it once, for every screen
A button that turns into another (Start becomes Send to QC), a banner that clears (Record approval), or a control that
becomes disabled (Move down at the end of the list) drops focus to `<body>`, and a keyboard user restarts from the top.
Patching each button was a losing game. Rule: `useKeepFocus` (in `AppShell`) restores focus to the nearest surviving
control or section when focus falls to the body after a DOM change; dialogs and menus that manage their own focus are
left alone. A list that re-orders itself (the ready queue) also puts focus back on the moved row's button.

### 2026-10-31 — Spanish overflow is a layout problem, not a translation problem
The orders and Payments tables overflowed their cards in Spanish at 1440px because nowrap text cells (customer, terms,
next step, the quote total with its status) set a minimum width wider than the card. Rule: cells that hold sentences
wrap (`whitespace-normal!`); only chips, numbers and dates stay nowrap. `polish.spec.ts` fails if any table scrolls
inside its card in Spanish.

### 2026-11-01 — Chain the commit on the verify exit code
- **Cost:** the M6 fix was committed and pushed with a type error in an e2e file, because the commit ran after
  `npm run verify ...; echo exit=$?` in the same `;`-chained command, regardless of the result.
- **Rule:** `npm run verify > log 2>&1 && git commit ...`, never `;`. Read the exit code before anything outward.

### 2026-11-01 — Plans need Codex too, not just code
- **Cost:** the storefront plan took four Codex passes. Turnstile tokens are single-use, so one per submission
  session. Strict per-IP limits block whole schools. Upload/submit/cleanup races. A restore through write-once
  triggers fails. Backups resurrect deleted data.
- **Rule:** run Codex on any security or data design before presenting it for approval, and fold its findings
  in with **(C)** marks.

### 2026-11-01 — New MCP servers need a fresh session
- `claude mcp add` connects immediately, but its tools only reach the model in the next session. Add connectors
  at the end of a session, before the work that needs them.
