# GoCreative storefront plan

> Status: **conditionally approved 2026-11-01: S0 (design mockups) only.** No public deployment and no irreversible
> database change until Arturo approves S1. His decisions are in §0 and override anything below that differs.
> Source: [SPEC-post-phase2.md](SPEC-post-phase2.md) §5–§6. Architecture context:
> [PLATFORM_ARCHITECTURE_REVIEW.md](PLATFORM_ARCHITECTURE_REVIEW.md). Codex's independent review is folded in
> where marked **(C)**; disagreements are in PLATFORM_ARCHITECTURE_REVIEW.md §8.
>
> **Before S1 (fix now, from the review):** a working backup script and restore drill, and the Access re-scope
> plan verified for `/app`, `/app/*`, `/api/app`, `/api/app/*` on every hostname.

## 0. Arturo's decisions (2026-11-01, conditional approval)

1. **Architecture approved:**
   - one shared codebase;
   - a separate deployment, D1 database, R2 bucket and authentication configuration per business;
   - GoCreative stays the first client;
   - no universal workflow engine and no shared multi-tenant database;
   - all Phase 2 functionality preserved.
2. **Backup and restore** are implemented **and tested** before public launch (S0b; plan in `notes/backup-restore.md`).
3. **Public storefront routes stay separate** from the authenticated dashboard routes (§7).
4. **A Declined inquiry status**, with an optional internal reason (§5).
5. **School districts may attach a PO** when they inquire. A customer-uploaded document stays **unverified** until
   staff approve it (§4, §6).
6. **Retention:**
   - spam inquiries are kept **up to 30 days**;
   - unconverted inquiries are kept **up to 12 months**;
   - staff can delete either earlier (§9).
7. **Offboarding:** a 30-day export window after cancellation, then deletion, with backup removal targeted by
   day 60. The **technical and legal retention constraints must be verified before these deadlines are
   promised to customers** (SAAS_READINESS §5).
8. **Submission sessions** are short-lived and scoped to one inquiry. The server enforces upload count, file
   size, file type and aggregate storage limits (§4).
9. **The kill switch** stops new inquiries and uploads, **including through submission sessions already issued**
   (§4).
10. **Converting an inquiry into an order is atomic and idempotent** (§5, §6).
11. The domain and the final business content can be settled during storefront development.

**S0 direction:** the experience of a professional custom printing and embroidery business, not a SaaS dashboard.
Light, airy and modern, with warm branding, strong typography, attractive service sections and a simple
mobile-first inquiry. Responsive mockups of the home page, services, the order inquiry form, the artwork
upload experience and the submission confirmation. Temporary content is clearly labelled. **No invented contact
details, hours, prices or guaranteed turnaround times.**

## 0b. Revisions after Codex's security review (2026-11-01). These override §4–§10 where they differ.

**Fix before S1:**
1. **Backups:** a consistent snapshot in a maintenance window, a trigger-aware restore into an isolated
   database, backup expiry with deletion replay. See `notes/backup-restore.md`, "Revisions".
2. **Access re-scope verified before S1, cut over at S4.** New step **S0c**:
   - inventory every hostname (workers.dev; preview URLs stay disabled; the custom domain when there is one);
   - document the exact configuration method from current Cloudflare docs: path-scoped Access applications
     per hostname for `/app`, `/app/*`, `/api/app`, `/api/app/*` (wildcard children don't include the parent),
     plus removing the Worker-wide "All traffic" protection;
   - **rehearse it on a throwaway Worker** with the same layout, and prove from outside that the public paths
     are open and every protected path challenges.

   The JWT audience stays compatible, or the Worker accepts the new application's audience explicitly. Note:
   `/app` is a static SPA shell (`run_worker_first` covers only `/api/*`), so only Access protects it. It must
   contain no records, credentials or embedded responses, which is true today. Unknown `/api/*` paths stay
   Worker errors, never SPA HTML.
3. **Upload protocol with explicit states:**
   - each upload goes `reserved` → `stored` → `linked`, or ends `failed` or `expired`;
   - **submit is refused** ("uploads still in progress", 409) while any upload in the session is `reserved`;
   - an upload that settles after its session closed is marked `failed` and queued for deletion, never linked;
   - **cleanup first claims a session atomically** (`open` → `expiring`, only if unsubmitted and expired), so
     submit and settlement can't win afterwards. It then deletes the R2 objects through a retryable queue
     (rows stay `deleting` until each deletion is confirmed);
   - orphan reconciliation looks only at objects older than a **24 h grace period**;
   - every interleaving is tested: submit vs settle, settle vs cleanup, ambiguous R2 outcomes.
4. **Retention vs backups:** see item 1. Active-system retention and backup expiry are stated separately in the
   privacy text.

**Fix during S1–S4:**
5. **A separate public router** (`worker/routes/public.ts`), with:
   - its own streamed 64 KB JSON limit, the public upload cap, admission checks and the kill-switch check;
   - an explicit browser-origin policy.

   It reuses the low-level streaming and sniffing primitives only, never staff handlers or internal
   serializers. Responses are explicit objects (upload acknowledgements, `{ref}`), and validation errors are
   sanitized. Boundary tests cover every endpoint, its errors and retries, files from another session, and
   attacker-supplied internal fields.
6. **Storage is bounded, not just daily intake.**
   - A hard **outstanding-storage cap** for public inquiry files (proposal: 2 GB across all unconverted
     inquiries) and a cap on open sessions, alongside the daily admission budget.
   - Reservations are accounted atomically. Budget comes back only after a **confirmed** deletion, never for an
     uncertain one.
   - The kill switch is persisted in D1 and checked on every public write. A request already streaming when
     it flips is allowed to finish, but its submit is refused.
7. **Conversion and POs:**
   - conversion runs only on an eligible inquiry (`new`), unchanged since staff opened it (a version guard),
     and **not claimed for deletion**;
   - a duplicate conversion rolls back and returns the existing order;
   - customer/contact relationships and the owner-only payment-terms rules are validated server-side;
   - file purpose is enforced with **purpose-specific allowlists**: artwork accepts PNG, JPEG, PDF and SVG,
     **a PO accepts PDF, PNG and JPEG only (no SVG)**, matching the staff PO rule;
   - POs arrive `received` and artwork arrives under review.
8. **Deletion path:**
   - **spam retention counts from receipt** (`created_at`), so reclassifying can't extend it;
   - eligible records are claimed atomically before any R2 deletion, failures are retried, and dependent rows
     are removed in a documented order;
   - converted and order-linked files are never deleted by retention;
   - audit entries carry no submitted personal data;
   - **Decline** (with an optional internal reason) and owner deletion are added to S3's work list.

## 1. Goal and scope

A customer can, from a phone:

1. learn what GoCreative makes;
2. start an inquiry;
3. pick a product or service;
4. give quantities and specifications (including the size breakdown);
5. upload artwork;
6. leave contact details;
7. submit; and
8. see a clear confirmation with a reference number.

The inquiry lands in the dashboard's existing **Inquiries** view. One **Convert to order** action turns it into a
customer, contact, order, item lines and artwork versions, so staff never retype what the customer entered.

**Not in this release** (brief §5, "future"): customer accounts, order tracking, quote acceptance, online artwork
approval, repeat ordering, automated notifications, prices or checkout.

The storefront is GoCreative's experience on the shared platform. It is built as an optional module from day one:
its routes, API and dashboard review queue sit behind one switch in the business configuration (§8).

## 2. What already exists

| Piece | State | Use |
|---|---|---|
| `inquiries` table (0001/0002) | `payload` JSON, contact name/email/phone, `status IN ('new','converted','spam')`, `order_id`. **0 rows live.** | Keep. Extend additively (§5). |
| Dashboard Inquiries view + "new inquiry" on Needs attention | Lists and counts `status = 'new'` | Becomes the review queue; gains a detail page and Convert. |
| `src/store/Store.tsx` at `/*` | Placeholder | Replaced by the storefront. |
| Upload pipeline (`worker/files.ts`) | Content-Length required, 4 KB magic-byte sniff, streamed into R2 with SHA-256, 50 MB cap, write-once | Reused for public uploads, with a lower cap (§6). |
| Order creation, items with size grid, artwork versions | All live and tested | Conversion is one dedicated `worker/db` writer that reuses their SQL and rules in a single atomic batch (§6). |
| Cloudflare Access | Guards **all traffic** on the Worker today | Must be re-scoped to `/app*` and `/api/app/*` at launch (§7). |
| Design system | Tokens, Inter, warm greys, ink-blue accent; storefront direction written in DESIGN_SYSTEM.md | Shared foundations; the storefront gets its own layout and display face. |

## 3. Experience and design direction

The dashboard is a tool, so it is dense, quiet and fast. The storefront is an invitation, so it is warm, roomy
and confident: a small boutique shop that makes things by hand, not a SaaS landing page.

- **Shared foundations:** the same colour tokens, spacing scale, radius and Inter for body text, so both layouts
  feel related.
- **Its own layout:** a separate shell (no sidebar), large type, generous whitespace, and a display face for
  headings only. Fraunces or Bricolage Grotesque are the candidates, chosen at the mockup.
- **Large artwork:** the upload step shows big previews, and the confirmation shows what was sent.
- **Mobile-first:** one-thumb navigation, big targets, a sticky "Start an order" action, and native inputs.
  Number keypads for quantities; `capture` lets a phone camera photograph a sketch.
- **Motion:** purposeful and brief. The step transitions in the inquiry form (150–250 ms ease-out), press
  feedback on buttons, and nothing decorative. `prefers-reduced-motion` turns it all off. The installed
  design-engineering and animation skills (emil-design-eng, animate, apple-design, frontend-ui-engineering) are
  used at the mockup and build stages.
- **Avoid:** gradient hero blobs, stock-photo grids, "trusted by" logo rows, three-column feature cards, and
  testimonials we don't have.
- **Language:** English for now (Arturo, Phase 1: "store front can remain English"). Strings still go through
  i18n, so Spanish can be added later without rework.

### Pages

| Route | Purpose |
|---|---|
| `/` | Who GoCreative is, what it makes (screen print, embroidery, DTG, laser engraving/cutting), who it serves (schools, teams, organizations, individuals), how ordering works in three steps, and a primary "Start an order" call to action. |
| `/services/:slug` | One page per service: what it's good for, example work (photos when Arturo has them), typical turnaround, and "Start an order with this". |
| `/order` | The inquiry, as a 4-step form with a progress bar: **What** (product + method), **How many** (quantity, sizes grid, colours, due date, notes), **Artwork** (drag-and-drop or camera, previews, optional "I need design help"), **You** (name, organization or school, email and/or phone, preferred contact). Review, then submit. |
| `/order/sent/:ref` | Confirmation: the reference number, what happens next, and how to reach the shop. |
| `/privacy` | What we collect, why, and how long we keep it (§9). |

## 4. Public API

All under `/api/public/*`, outside Access, each with a boundary test (AGENTS.md rule). The responses carry only
what the customer just sent and the reference number: never customer records, notes, prices, supplier costs or
employee data.

A Turnstile token is single-use and valid for five minutes **(C)**, so it is verified **once, to open a
submission session**, not once per upload:

1. `POST /api/public/submissions`: the browser sends a Turnstile token, which is verified server-side
   (expected hostname and action) before anything is written. The server creates a **submission** row: a
   random id that is never an integer, `expires_at` set to now + 2 h, and caps of 5 files and 60 MB in total.
   It returns an opaque session token, which is stored only as a hash.
2. `POST /api/public/submissions/:token/files`: **one file per request**, raw body, through the existing
   streamed pipeline with a **public per-file cap** (proposal 20 MB; PNG, JPEG, PDF and SVG; SVG stays
   download-only for staff). It is stored under R2 key `inquiries/<submission>/<uuid>`. A guessed inquiry or
   order id authorises nothing. The lifecycle:
   1. **Reserve first.** Before streaming, one conditional D1 update reserves the declared Content-Length
      against the session's caps and the global daily budget, and only for an open, unexpired session. If it
      matches no row, the request is refused (413 or 429) before any byte is read.
   2. **Stream.**
   3. **Settle.** Success marks the file row `stored`. A failure releases the reservation. An ambiguous outcome
      leaves an unlinked object for the cleanup to reconcile.

   Parallel uploads therefore can't exceed the caps **(C)**.
3. `POST /api/public/submissions/:token/submit`: JSON form fields, validated by an **allowlisted** zod schema
   shared with the form. The browser can never send customer ids, statuses, prices, notes or any order field
   **(C)**. The `payload` stores the validated, normalised request, never raw JSON. One D1 batch does four things,
   each guarded on the session still being open:
   - inserts the inquiry (`status 'new'`);
   - links the session's files that are `stored` (pending or failed ones are excluded), each tagged by the
     customer as **artwork** or **purchase order** (a PO is offered only when the customer says they are a
     school, district or organization);
   - writes `inquiry_received`;
   - closes the session last, so later uploads are refused.

   It returns `{ ref }`, a short human-friendly reference such as `INQ-7K3Q`.
4. Retries: submitting a closed session returns the same `ref`, so a double-tap or a lost response never creates
   two inquiries.

**Abuse controls (cost-free):**
- **Turnstile** at session start.
- **Throttling that tolerates school networks, where many people share one IP** **(C)**:
  - per-session limits (the caps above);
  - a cautious per-IP ceiling on *new sessions*, for example 20 an hour;
  - a global daily admission budget (new sessions and total bytes) held in D1.

  Cloudflare's Workers rate-limiting binding can add a cheap first filter **(unverified on our plan: check it
  before building)**. Its counts are approximate and per-location, so it isn't the quota itself **(C)**.
- **Emergency off switch:** a setting changed without a deploy. When it's on:
  - the form shows "call or email us";
  - `/api/public/*` refuses **every public write** (new sessions, uploads to existing sessions, and submits)
    **(C)**.

  Already-submitted inquiries are unaffected.
- **Shared request budget:** a flood still costs Worker requests that the dashboard needs, so that risk is part
  of the launch checks and incident notes **(C)**.
- Strict field limits, a 64 KB JSON cap and a honeypot field.
- File sniffing proves a plausible file type, **not that a file is safe** **(C)**. Staff open customer files
  through the existing safe download (sandboxed, nosniff, SVG served as an attachment).
- A daily **cron cleanup** (Workers cron triggers are free) deletes expired, unsubmitted sessions and their files
  from R2 and D1, re-checking in the same statement that the session is still unsubmitted, so it can never
  delete a submitted inquiry's files. It also reconciles objects under `inquiries/` that have no file row.
  Besides the existing rollback cleanup in `worker/files.ts`, this is the only place a file is deleted.

## 5. Data model (migration 0008, additive)

- `inquiries`, new columns: `ref TEXT UNIQUE`, `request_id TEXT UNIQUE`, `customer_kind`, `organization`,
  `preferred_contact`, `due_date`, `converted_at`, `converted_by`, `ip_hash` (a salted hash for abuse review,
  never the raw IP). The `payload` JSON keeps the structured request (lines with product, method, colours,
  sizes, quantity, notes) in the **same shape as `order_items`**, so conversion copies it without re-keying.
- `inquiry_submissions (id TEXT PRIMARY KEY (random), token_hash UNIQUE, ip_hash, files_count, bytes_total,
  expires_at, submitted_inquiry_id NULL)`: the upload session with its caps.
- `inquiry_files (id, submission_id REFERENCES inquiry_submissions, inquiry_id NULL REFERENCES inquiries,
  file_id UNIQUE REFERENCES files, created_at)`: linked to its inquiry at submit, write-once after.
- `orders.inquiry_id` (ADD COLUMN) with `CREATE UNIQUE INDEX one_order_per_inquiry ON orders (inquiry_id) WHERE
  inquiry_id IS NOT NULL`. Conversion is **idempotent and race-safe** **(C)**: a second conversion's order
  INSERT violates that index, and because every side effect of the conversion is in the same batch (§6), the
  whole batch rolls back and nothing is half-written. A retry/concurrency test proves it.
- **Provenance** **(C)**: the original submission is kept as submitted. The order records `source = portal`
  and `inquiry_id`. A public submission never satisfies quote, authorization or artwork approval by itself:
  the artwork arrives "under review".
- `files.ts` download rule: today a file is served only when an artwork version or PO document links it to an
  order. It is extended to inquiry files, for signed-in staff only. Public routes never serve files back.
- **Statuses: `new / converted / declined / spam`** (Arturo), plus `decline_reason` (optional, internal, never
  shown publicly). Widening a CHECK needs the `inquiries` table rebuilt. It has **0 live rows and nothing
  references it**, so the rebuild is low-risk, but it is not additive. **It is listed for Arturo's explicit go at
  S1**, with a pre-migration export of the table either way.
- `inquiry_files.kind IN ('artwork','po')`.
- The usual guards: unconditional `BEFORE UPDATE` identity triggers, no REPLACE on unique columns, and a
  converted inquiry is frozen.

## 6. Converting an inquiry into an order (dashboard)

The inquiry detail page shows what was sent: lines, sizes, artwork previews and contact details. It suggests a
matching existing customer by email or phone. Staff confirm or edit:

- customer: an existing one, or a new one of the chosen kind;
- the contact;
- the line items.

Then **Convert** runs one D1 batch. It is a **new dedicated writer** in `worker/db`: the existing customer and order
writers each run their own batch, so they can't be composed into an atomic one. It reuses their SQL and
validation rules **(C)**. The batch:

1. creates or reuses the customer and contact;
2. creates the order with source `portal`, its items and the defaults from the customer (PO required, payment
   terms; owner-only terms rules still apply);
3. turns each inquiry **artwork** file into **artwork version 1** of its own design on the new order, under
   review. Each **PO** file becomes a `purchase_orders` record in status `received`, with the file as its
   document: **unverified until staff move it to approved** through the existing PO workflow. Approving a PO
   stays a staff action, so a customer upload can never satisfy authorization by itself;
4. marks the inquiry `converted`, with `order_id`;
5. writes one activity row per step.

The order then follows the normal Phase 2 workflow: quote, authorization or PO, and so on. **Mark as spam**
hides an inquiry from the queue.

## 7. Launch configuration

- **Access re-scope**: from "all traffic" to `/app`, `/app/*`, `/api/app`, `/api/app/*`.
  `notes/access-setup.md` has a reference outline, and some steps are marked unverified. The exact dashboard
  steps get verified at S4, then tested from outside on every hostname **(C)**. The Worker still re-verifies the JWT and looks up the role, so a mistake
  can't open the API. The `/app` page shell holds no data. This is an outward-facing change, so I'll ask
  before doing it.
- **Domain**: the storefront can launch on `gocreative.idoggiebites.workers.dev`, but a customer-facing site
  should have GoCreative's own domain. **Arturo to provide.** Confirmation emails to customers need a domain
  anyway, so they wait for it. Until then the confirmation is on-screen, with the reference number.
- **PWA**: SPEC.md lists it, but **it isn't implemented yet** (no manifest or service worker). It is optional
  for the storefront. Proposal: add it for the dashboard (home-screen install for the family) at S4, cache
  only static assets, and never cache `/api/*` (see the service-worker trap in the RR tracker's LEARNINGS).

## 8. Platform boundaries (so the storefront is reusable)

- **Module switch:** `business.modules.storefront` turns the storefront on. When it is off, `/` redirects to
  `/app` and `/api/public/*` returns 404.
- **Content lives in the business config, not in components:**
  - `shared/business.ts` grows a `storefront` section: tagline, services (slug, name, blurb, methods, image key),
    contact details and hours.
  - Photos and the logo go in `src/business/` (proposal; AGENTS.md's "only business.ts and brand.css may name
    GoCreative" rule would be widened to that folder).
  - Components render whatever the config provides.
- **Printing-specific form fields** (method, garment colour, size grid) come from the same config
  (`business.sizes`, the methods list), so another business's form shows its own fields.

## 9. Privacy and retention

- **What we collect:** name, contact details, an optional organization, the request and the artwork. **Not
  collected:** addresses, dates of birth, payment details.
- **Consent:** a one-line statement by the Submit button, linking to `/privacy`.
- **Retention (Arturo, 2026-11-01):**
  - **spam** inquiries and their files: deleted after **up to 30 days**;
  - **unconverted** (new or declined) inquiries: deleted after **up to 12 months**;
  - converted inquiries: kept with the order's records.

  **Staff can delete a spam, declined or unconverted inquiry earlier** (an owner-only action, confirmed, logged
  as an activity row without the personal data). The daily cron does the scheduled deletions and logs counts
  only. Deleting an inquiry deletes its files from R2. These are the only deletions of customer records the app
  performs.
- **IP addresses** are stored only as a salted hash, for abuse review.

## 10. Milestones

Each milestone ends with `npm run verify` passing, Codex's review, and its findings fixed. Deploys follow the
standing approval (additive changes only). The Access re-scope is the exception (§7).

| # | Work | Who |
|---|---|---|
| S0 | **Design mockups** (home, services, the inquiry form, the artwork and PO upload experience, confirmation; phone and desktop) on the design canvas, using the design skills. **Approved to start 2026-11-01. Review gate: Arturo approves before S1.** | Claude |
| S0c | **Access re-scope rehearsal** on a throwaway Worker: hostname inventory, exact config method, outside-in proof (§0b.2). Before S1. | Claude, with Arturo in the dashboard |
| S0b | **Fix-now items:** a backup script (per-table JSON export of the live D1, plus a restore drill into a scratch local D1), with ARCHITECTURE.md corrected. | Claude |
| S1 | Migration 0008; the submission, upload and submit endpoints; Turnstile; throttling and the admission budget; the off switch; cron cleanup; boundary tests seeded with internal notes, other customers and supplier costs; abuse tests (oversize, wrong type, token reuse and expiry, Turnstile failure and replay, budget races, flood). | Opus agent; Codex reviews security |
| S2 | Storefront UI to the approved mockups: layout, pages, the inquiry form with uploads and retries, confirmation, privacy page, e2e on phone and desktop. | Sonnet agent; Codex reviews |
| S3 | Dashboard: inquiry detail, customer match, **Convert to order**, Mark as spam, **Decline with an optional reason**, **owner delete**. Conversion e2e (storefront submit → convert → order has items and artwork → quote). | Opus (conversion batch), Sonnet (screens) |
| S4 | Launch: Access re-scope (with Arturo), domain if ready, PWA for the dashboard, signed-in smoke test, the family's dry run. | Claude + Arturo |

## 11. Needs from Arturo

1. ~~Approval~~: conditional approval given for S0 (§0). **S1 needs a separate go**, including the `inquiries`
   table rebuild for the Declined status.
2. **Domain** for GoCreative: during storefront development (the storefront can launch on workers.dev).
3. **Content** (during development; mockups use labelled placeholders until then):
   - the list of products and services to show;
   - any photos of past work and a logo, if there is one (otherwise we keep the typographic wordmark);
   - turnaround times;
   - contact details and hours to publish.
4. ~~Retention, Declined, PO uploads~~: decided (§0).
