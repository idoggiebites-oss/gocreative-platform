# SaaS readiness

> 2026-11-01. Evaluates what serving several businesses would require (brief §4, review areas 3–5).
> **Nothing here is to be built now** (brief §6: no multi-tenant infrastructure, no billing). The point is to
> make the cheap decisions now and avoid the expensive ones later. Codex reviewed independently, and its points
> are marked **(C)**.

## 1. The isolation model

There are two ways to host many businesses on this stack:

| | **One deployment per business** (current, DECISIONS.md 2026-10-30) | **Shared database with `tenant_id`** |
|---|---|---|
| Shape | Per business: one Worker, its own D1, its own R2 bucket and its own Access application, all from **one codebase**. | One Worker, one D1, one bucket; every row carries `tenant_id`. |
| Isolation | **Structural.** A query can't reach another business's data, because it's in another database. | **Behavioural.** Every query, join, aggregate, trigger, unique constraint and background job must be scoped. One miss leaks data. |
| What the current code assumes | Global unique constraints (`users.email`, `orders.number`, `suppliers.name`, `counters`, `one_job_per_slot`, `payments.request_id`) and global lookups by id. They are all correct here. **(C)** | All of them would be wrong. Two businesses' production slots would collide, for example. **(C)** |
| Export, restore, offboarding | Whole-business operations: copy or delete one D1 and one bucket. | Row-by-row and file-by-file, through immutability triggers. |
| Costs and risks | Provisioning, migrations and Access config repeated per business, so a deploy script and a registry are needed. Pointing a Worker at the wrong database is the main operator risk. Account-level limits need capacity planning. | Fewer moving parts, but security depends on discipline in every query, and restoring a single tenant is hard. |

**Decision (Arturo, 2026-11-01): one deployment per business.** It matches the code, makes the brief's data-ownership
promise easy to keep, and costs little on Cloudflare's free and low tiers. Revisit only if the number of
businesses makes per-deployment operations the bottleneck, and even then automate deployments before merging
databases. **(C) agrees:** "the approved isolated-deployment model remains viable."

**Hard rule, effective now:** this application must never be pointed at a database holding more than one
business. **(C)**

## 2. Decisions to make now (cheap now, expensive later)

| Decision | Proposal | Class |
|---|---|---|
| A stable **business identifier** per deployment | Add `business.id` (e.g. `gocreative`) to `shared/business.ts`; use it in R2 key prefixes for new objects (`<business>/orders/…`), exports, logs and support tooling | Fix before commercial launch (prefixing new keys is cheap any time; old keys keep working) |
| A **deployment registry** | One private file or table outside client repos: business id → Worker, D1 id, bucket, Access AUD/team, domain, owner contacts, schema version, plan | Before commercial launch **(C)** |
| **Migrations across deployments** | One script applies pending migrations to every registered D1 before deploying the shared Worker build, recording versions. The rule "additive migrations only" already makes rolling out safe | Before commercial launch |
| **Who signs in** | Keep Cloudflare Access (an email one-time PIN or the client's Google login) with one Access application per business; roles stay in that business's `users` table. Access's free plan covers up to 50 users per account **(unverified for multi-app use: check plan limits before the second client)** | Before commercial launch |
| **Platform-admin access to client data** | Support access is explicit: a named admin account in that business's Access policy, recorded in the activity log, removable by the client. No hidden superuser | Before commercial launch **(C)** |
| **Configuration ownership** | `business.ts`, `brand.css` and the content folder per business, chosen at build time (one build per business, or a runtime config row; decide at the second client) | Defer until the second client |
| **Do not add `tenant_id` now** | Unused tenant columns provide no safety **(C)** | Defer |

## 3. Security baseline for a commercial offer

Most of it is already in place for one business:
- JWT re-verification, server-enforced roles and owner-only overrides;
- same-origin writes and body caps;
- streamed, type-sniffed, write-once uploads with safe downloads;
- database-enforced invariants;
- a write-once audit log.

**To add before selling** (all **(C)** unless noted):
- **Backups with a tested restore.** There is none today, despite ARCHITECTURE.md (now corrected). D1 Time
  Travel offers point-in-time restore (retention depends on the plan, unverified for ours) plus a scripted daily
  export. *Fix now* for GoCreative.
- **App-wide security headers:** CSP, frame-ancestors and referrer-policy.
- **Access MFA policy:** decide whether email one-time PIN is enough, or require an identity provider with MFA.
- **Audit policy:** log file downloads, exports and permission changes. Stop copying contact details and
  internal notes verbatim into append-only audit JSON (`worker/db/customers.ts:128,161`), so that personal data
  can be erased.
- **Secret scanning** in CI, and a no-reply author email for commits to public repositories.
- **Per-business abuse budget** for public routes: Workers' daily request limit is shared with that business's
  dashboard.

## 4. Scalability (for a small-business platform)

- **D1:** each business is far below D1 limits (10 GB per database on paid plans; the free tier is smaller). The
  heaviest query (the dashboard) is bounded. No action.
- **Workers free plan:** a request cap per day across the account, unverified at our scale. **One account
  hosting many businesses shares that cap**: a paid Workers plan becomes the floor for commercial hosting, and
  it is a fixed cost to price into the subscription.
- **R2:** per-business buckets, free egress, storage priced per GB. Artwork is the bulk. No action.

## 5. Data ownership and offboarding

**The promise:** a business can take everything and leave.

**What an export must contain** **(C)**:
- every table, including the full activity history (not the 50-row screen views);
- all quote versions and approval history;
- voided payments;
- notes;
- inquiries and their original submissions;
- every R2 original, with a manifest giving filename, MIME type, size, SHA-256 and what it belongs to;
- business configuration;
- an export format version.

**Proposed format:** one zip holding `data/*.json` (one file per table, plus a README describing the fields),
`files/<sha256>-<filename>`, and `manifest.json`. Taken from a consistent snapshot (D1 Time Travel bookmark or
an export at a recorded point in time).

**Obstacles, and how a one-deployment-per-business model handles them:**

| Obstacle | Handling |
|---|---|
| Write-once triggers (activity, artwork, payments, purchases, quotes, pickups) block deletion | Ordinary operation never deletes. **Offboarding deletes the whole D1 database and bucket**, so no trigger is bypassed row by row |
| R2 objects without DB rows (ambiguous upload outcomes, abandoned public uploads) | Bucket-level deletion covers them; for live operation, a reconciliation job lists objects with no `files` row (and the storefront's cron cleans pending uploads) |
| Backups and Time Travel copies outlive deletion | Offboarding states when backup copies expire; nothing is "deleted" until they have |
| Downloaded exports and copies elsewhere | Out of our control; stated in the policy |

**Retention periods** aren't in the notes. Proposal for the offer:
- the export stays downloadable for 30 days after cancellation;
- the business's data is deleted at day 30;
- backup copies expire by day 60;
- a deletion certificate (a record of what was deleted and when) is sent to the owner.

**Arturo, 2026-11-01:** plan for a 30-day export window after cancellation, then deletion, with backup removal
targeted by day 60. **Before these deadlines are promised to any customer, verify:**
- the technical constraints: D1 Time Travel retention on our plan, R2 lifecycle, and how long our own export
  copies are kept;
- the legal constraints: record-keeping obligations for invoices and payments, and the customer's own
  obligations to keep records.

**Classification:**
- *Before commercial launch:* a demonstrated export plus a restore round trip, and the written offboarding
  procedure with retention periods.
- *Defer:* self-service export buttons. Export is run by us on request, as a configured service.

## 6. Summary by class

| Fix now (GoCreative, before storefront) | Before commercial launch | Defer |
|---|---|---|
| Backups + restore drill; storefront intake security (STOREFRONT_PLAN); Access re-scope verification | Business id + registry; migration rollout script; admin-access policy; security headers; MFA policy; audit policy + no PII copies in audit JSON; export/restore demo; offboarding procedure + retention; paid Workers plan priced in; JDS out of shared migration | tenant_id / shared DB; module extraction; per-business workflow stages; self-service export; billing |
