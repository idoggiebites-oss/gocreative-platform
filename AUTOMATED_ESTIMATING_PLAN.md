# Automated estimating and pricing management: plan

> Status 2026-11-01: **approved by Arturo.** His decisions: S4 waits for E1 to E3; browser analysis with required staff verification; owners alone configure and publish pricing and see costs and margins; staff may adjust individual draft quote prices; customers see one figure with his exact wording; validate on at least 30 real jobs before customers see automatic prices. Offsite backups are deferred as a documented risk, revisited before S4.

> E3 built 2026-11-01 with customer prices switched off in code (`customerEstimates`). Arturo told us to build it while the 30 jobs are collected, ahead of the validation gate in §9; the gate now governs turning prices on, not building. "Start draft quote from this estimate" (§8, optional) was not built: staff enter final prices through the existing quote flow.

## 1. Confirmed decisions (Arturo)

- **No LLMs, paid AI APIs, vision services or per-image subscriptions.** Deterministic image processing and a rules engine only.
- A detected colour count is an estimate, never a verified separation. Staff can override it with a reason.
- No defensible number means **"Manual review required"**, never an invented price.
- A preliminary estimate never becomes an accepted quote or a production authorization. Staff issue every final quote.
- Pricing goes Draft → Preview → Publish → Active. Rollback publishes a prior configuration as a new version.
- Each estimate keeps its exact rule version. Nothing historical is recalculated.
- Dashboard and storefront use one server-side pricing engine. Costs, margins and formulas stay private.
- Service-specific pricing models, reusable by other businesses, with no universal cross-industry system.

## 2. Audit of what exists (2026-11-01)

**S3 is complete and live behind Access** (migration 0010, Worker 412d36de), so this is a review of shipped code, not of a plan.

**Pricing today:** staff type `unit_price_cents` on order items. `quotes` and `quote_items` are snapshots that freeze once they leave draft, enforced by triggers, with versions, one accepted quote per order, and `quoteSatisfied` in the production gate. There is no rules engine, cost data, garment catalogue or estimate storage; the old `estimates` table was dropped in 0002. Roles are only `owner` and `staff`. No image library is installed.

| Requirement in the brief | State | Evidence or gap |
|---|---|---|
| Several products and quantities in one inquiry | **Met** | `payload.lines`; one order item per line |
| Conversion doesn't accept preliminary prices | **Met** | Items convert at 0 cents, no quote is created (`lineToItem`, tests) |
| Immutable quotes, production authorization | **Met** | Quotes freeze once they leave draft (drafts stay editable, on purpose); triggers and the gate are untouched by S3 |
| Estimates separate from quotes | **Met by design** | Stays true if estimates get their own table (§6) |
| Artwork linked to products or print locations | **Gap** | `inquiry_files` has only `kind`; no line link and no print locations in the form |
| Estimate linked to an inquiry, with a status | **Gap, belongs in E1** | Nothing to link yet |
| Reproducible calculation | **Gap, belongs in E1** | Needs stored inputs and rule version |
| Old requests stay readable as rules change | **Defect found** | See §3 |

## 3. Changes genuinely needed before or during S3

S3 needs **no migration and no new columns** for estimating.

**One defect in shipped code, independent of estimating.** `parsePayload` reads stored requests with today's strict validation. Confirmed by a test with assertions: a stored line whose product is no longer offered, whose method no longer fits, or which has a field added later all return null. The inquiry then shows no lines and cannot be converted. Any edit to the product map would strand old requests, and adding print locations in E3 would strand them unless this is fixed first. No live rows are affected: intake is closed and the table is empty.

*Proposed fix, small, for his go:* a separate stored-request schema for reads. It drops the catalogue checks but **keeps safe quantity and size checks**, and maps a method the database doesn't accept to `other` explicitly, never passing an arbitrary string to SQL. Strict validation stays at submit. A regression test covers all three cases. This makes old requests readable; it does not by itself carry new fields through to staff or conversion, which E3 must add.

**Compatibility rules to keep from now on, no code needed:**
- `payload` remains versionless JSON read leniently, so E3 can add fields without a migration.
- Conversion never reads an estimate's price into an item.
- Public API responses remain explicit objects, so cost fields can't leak by accident.

## 4. Where analysis runs

This is the main architecture decision. **Recommendation: analyse in the browser with one shared pure function, and price on the server.**

| | Browser (recommended) | Worker |
|---|---|---|
| Malicious images | Decoded in the browser's sandbox; our server never parses them. Resource exhaustion is still possible in the customer's and staff's browsers (§5) | A decoder for hostile files inside the Worker that holds the data |
| Limits | No server cost | 128 MB memory and a CPU limit. **The account's Workers plan is unverified; Free allows about 10 ms CPU, which rules this out** |
| Trust | The customer's result is **untrusted** | Trusted |
| Formats | PNG, JPEG, SVG through `<img>` with scripts inert | Each needs a WASM decoder |

**What a dishonest customer can do, stated plainly.** They can send a low colour count, hide gradient flags, or claim high confidence. The server's arithmetic is then correct on false facts, and the stored estimate is wrong, not just their screen. A file's SHA-256 identifies the bytes; it does not prove the analysis describes them.

Handling it:
- Every estimate records **two separate facts**: calculated by the server, and whether its artwork facts are `customer_reported` or `staff_reviewed`. A customer can never set the second.
- **Staff must re-run the analysis on the stored file before an estimate can start a draft quote**, through the authenticated file route.
- A difference between the two is shown to staff as a difference, not as tampering: browsers may scale and decode images differently.
- The harm is bounded because nothing here is binding: staff set every final price.

This choice is about reducing server risk and cost for an explicitly unverified figure. It does not mean a Worker analyser is impossible; Cloudflare's limits (10 ms CPU on Free, 128 MB memory) would need benchmarking on our plan, which is itself unverified. Browser analysis still costs API calls and storage for the estimate.

**PDF is not analysed in E1.** A pdf.js dependency isn't justified yet, so PDF means "Manual review required". Decision for Arturo if PDFs prove common.

## 5. E1: artwork analysis

`shared/artworkAnalysis.ts`: pure, deterministic, no randomness (no random-seed k-means), with an `ANALYZER_VERSION`. Input is RGBA at a capped size.

1. **Limits:** `createImageBitmap` has already decoded by the time dimensions are known, so a check afterwards is too late. Read PNG and JPEG dimensions from their headers first and refuse an oversize image without decoding. Run analysis in a Web Worker with a time limit and cancel it on overrun, in both customer and staff browsers. Allow only simple SVG, with a size cap, drawn through `<img>`; anything else means manual review. Any failure means manual review.
2. **Transparency:** drop pixels below an alpha threshold. Partly transparent pixels are edges, not inks.
3. **Anti-aliasing:** count colours from locally uniform pixels only. Pixels between two flat regions are edges and are excluded.
4. **Compression artifacts:** cluster in Lab space with a ΔE merge threshold, deterministic agglomerative merging over a quantized histogram.
5. **Small specks:** colours below a coverage threshold are dropped and reported, never silently.
6. **Gradients and photographs:** a high share of non-uniform pixels, or colour ramps, sets `gradient` or `photographic`. Count is not reliable, so the status is manual review or a suggestion of DTG, never a number presented as sound.
7. **Background:** a large colour touching the edges is flagged as a likely background. Whether it prints is an **assumption stated to the customer**.
8. **Result:** detected colours, palette with coverage, flags, confidence, analyzer version and thresholds used.

Not knowable from a file, so always an assumption: garment colour and underbase, halftones used on purpose, spot versus process printing.

**Validation gate.** Synthetic fixtures (flat logos, gradients, photographs, transparency, anti-aliased edges, JPEG artifacts, malformed files) prove behaviour, not accuracy. **Before E3 shows any customer a number, compare against real shop artwork with the screens actually used.** Proposal: at least 30 past jobs, reporting the exact-match and within-one rates, used to set confidence thresholds. No accuracy claim is made without this. Real artwork stays out of the public repo.

## 6. E1: pricing engine and estimate storage

`worker/domain/pricing/`: pure functions, one model per service, all money in integer cents and all rates in basis points.

**Calculation order, so an adjustment can't compound.** Exact definitions:
- **Markup:** `cost × (1 + rate)`. **Target margin:** `cost ÷ (1 − rate)`, with a rate of 100% or more rejected when saved. Each service uses one or the other.
- **Setup, screen and digitizing fees are selling fees, shown as their own lines.** Each has an optional internal cost, which counts in the margin check.

For each **line**:
1. Unit cost from the service's model (garment or material, decoration by tier, colours or stitches, size, location).
2. Apply markup or target margin to get the unit selling price before adjustment.
3. Apply the **service adjustment exactly once**, to that price and to the fee lines. Rates in the config are stored **unadjusted**, so a percentage change never modifies a rate and can't stack across versions.
4. **Round up to a whole cent per unit**, so `quantity × unit price` is the exact line total.

Then for the **whole inquiry**:
5. **Minimum order charge applies once per inquiry, not per line:** if the total is below it, a separate "minimum order" charge line makes up the difference.
6. **Minimum margin is checked last,** on the rounded totals, including fee costs. Below the floor means `manual_review_required`, never a silent price change.

**Mapping to quotes.** The existing quote code needs integer unit prices, with `quantity × unit price`. Rounding per unit in step 4 means every estimate line fits exactly, with no remainder charge and a margin floor that holds after rounding. Compared with the unrounded total, rounding up adds **less than `quantity` cents** to a line. The tests assert that bound, and it is simple enough for the family to check by hand.

**Build order inside E1:** screen printing first, since that is where analysis matters. Other services get a model only once the family's real rates show what it needs; until then they return manual review.

| Service | Pricing inputs (to confirm against real rates) |
|---|---|
| Screen print | Garment cost, quantity tier, colours per location, locations, print size, screen fee per colour |
| Embroidery | Garment cost, stitch-count or complexity band, quantity tier, digitizing fee |
| DTG | Garment cost, print size, locations, quantity tier |
| Laser and trophies | Material or part cost, machine time, setup. Awards likely stay manual review at first |

Any missing rate or unknown input gives `manual_review`, with reasons. **The engine has no default prices.** Until the family enters real numbers, every estimate is manual review.

**Tables (new, additive migration, E1). Each one is needed by a stated requirement:**
- `pricing_versions`: id, status, config JSON, config hash, source version for a rollback, created and published by and when. **The config of a published version never changes** (trigger); only its active or retired status moves. One active version (partial unique index). **Publishing is one atomic statement guarded by both the active version and the draft's config hash the publisher previewed**, so neither a concurrent publish nor a draft edited after preview can go live unseen; a stale publisher writes nothing.
- `inquiry_estimates`: inquiry, pricing version, engine and analyzer versions, inputs JSON, customer result JSON, internal result JSON (cost and margin), status `available | assumption_based | manual_review_required`. Append-only except for authorized deletion.
- `estimate_overrides`: estimate, field, original, replacement, reason, actor, time. Never touches an accepted quote. Overrides of a quote's own price use the existing draft and new-version flow plus activity logging, so no generic override table is needed.

**Deletion and restore.** Reasons and values can hold personal data, so overrides and estimates go with their inquiry. Both explicit deletion lists (`removeClaimedRows` and `replaySql`) must include them, with their triggers allowing only claimed deletion. Replay must also skip tables an older backup's schema lacks, and the test covers a backup from before these tables.

**Reproducibility, stated exactly:**
- The **stored result is the historical record**. Nothing is ever recalculated in place.
- The pricing arithmetic can be replayed from stored inputs and the stored rule version by the same engine version, and the test does this. Old engine code isn't kept forever, so replay across engine versions is not promised.
- **Artwork analysis is not replayed.** Its stored result, with analyzer version and thresholds, is the historical record. Staff can run a fresh analysis on the stored file at any time, which adds a new result and never replaces the old one; browsers may decode and scale differently, so the two can differ.

## 7. E2: Settings → Pricing Management

- **Simple (default view):** one percentage per service, a preview on sample estimates, draft and publish.
- **Advanced (collapsed, owner only):** the controls in the brief, shown per service, not as one universal form.
- **Simulator:** a sample order, showing published vs proposed, difference, internal cost, gross margin, assumptions and warnings. Draft rules never reach the storefront, because public calculations read only the active version.
- **Cost confidentiality is enforced on the server, not hidden in the UI.** Draft config, simulator, internal estimate JSON, and audit values holding costs are owner-only routes with field allowlists, covering responses, errors and activity rows. Tests sign in as `staff` and assert no cost or margin appears anywhere. A labour or cost override by staff is recorded in owner-only detail, with a staff-safe activity row.
- **Permissions (proposal):** `owner` publishes and sees costs and margins. `staff` see customer-facing estimates and can override the colour count, complexity, print details and labour with a reason. Price overrides on a draft quote follow existing staff quote rights; `owner`-only is the alternative. No new role is needed.
- **Audit:** version history and overrides, with existing activity logging. Rollback publishes a copy as a new version.

## 8. E3: storefront integration

- The form gains print locations and print sizes per line, and artwork-to-line links, **in the payload JSON, no migration**. Submit must verify each linked upload id belongs to this session, is stored, and is artwork. Upload ids are UUIDs while staff screens use numeric file ids, so staff screens resolve them through `inquiry_files`. Serializers and conversion must be extended to carry the new fields; print locations reach staff in the item description.
- `POST /api/public/estimate` needs an open, unexpired session and counts against an **atomic per-session quota, which submit-time recalculation also counts against**, so submit can't become a free pricing oracle. The session currently opens at first upload, so Turnstile would run earlier in the form.
- **This slows scraping; it does not keep pricing secret.** Any genuine customer can vary inputs and infer tiers and fees from the totals, and false analysis makes that easier. Totals-only output hides costs and formulas, not price behaviour. The family should accept that before E3.
- At submit the server **recalculates the arithmetic** from the submitted lines, the reported artwork facts and the active version, and stores that. The browser's total is never used; its artwork facts stay labelled `customer_reported` (§4).
- The customer sees a total, its assumptions and clear "preliminary" wording; never costs, margins or per-rule breakdowns. Boundary tests cover this.
- Staff see estimate, analysis, re-analysis and overrides on the inquiry. An optional "start draft quote from this estimate" is available **only after staff re-analysis**, creates a **draft only**, and goes through the existing quote workflow.
- A price changing between preview and submit is shown to the customer as an updated preliminary figure.

## 9. Sequence and dependencies

S3 (done) → one compatibility fix → E1 → E2 → validation gate → E3 → S4.

| Milestone | Depends on | Needs from Arturo |
|---|---|---|
| Fix (§3) | Nothing | Go |
| E1 | Decisions in §11 | Go for code; separate go for the migration in production |
| E2 | E1 | **The family's real costs and rates**, entered by them |
| Validation | E1 | **At least 30 past jobs with the screens used** |
| E3 | E2 and validation | Approval of customer wording; legal check of "preliminary" text |
| S4 | Its own checklist | Listed in ROADMAP |

**S4 does not technically depend on E1 to E3.** Launching first with "we will quote it" and adding estimates later is possible and lowers risk (§11, question 1).

## 10. Risks

| Risk | Mitigation |
|---|---|
| A wrong estimate anchors a customer's expectation | Clear wording, the validation gate, manual review when unsure |
| Colour counts disagree with shop practice | Real-artwork validation; staff override; never binding |
| Price behaviour inferred through the estimate API | Slowed by session, Turnstile and atomic quotas; **residual risk the family must accept**; costs and formulas never leave the server |
| Dishonest artwork facts | Labelled `customer_reported`; staff re-analysis required; nothing binding |
| Rounding up per unit raises a line by less than `quantity` cents over the unrounded total | Small, disclosed and consistent; staff can adjust the final quote |
| Costs leak to the public or to staff | Owner-only routes and field allowlists, boundary tests signed in as staff; backups encrypted offsite, plaintext on this Mac |
| Family doesn't maintain pricing | Simple view first; missing data falls back to manual review |
| Garment cost varies by style, and the form doesn't capture style | Assumed base garment per product, stated to the customer; or manual review |
| Scope grows into a general pricing system | Per-service models only; second client decides what generalizes |
| Workers plan unverified | Browser analysis avoids it; pricing arithmetic is far below any limit |

## 11. Decisions Arturo was asked (all answered in the status above)

1. **Launch order:** finish E1 to E3 before S4 as proposed, or launch S4 first with manual quotes?
2. **Analysis location:** browser with required staff re-analysis (recommended), or benchmark a server analyser?
3. **Price overrides:** existing staff quote rights, or owner only?
4. **Estimate display:** one figure, with "preliminary" wording, is what this plan specifies. A range is possible only if real-artwork validation shows how to calculate one honestly, so decide after the gate.
5. **Compatibility fix (§3):** approve it now?

## 12. Testing and review

Codex reviews each milestone on: image-processing edge cases, malformed and malicious artwork, processing limits, formula correctness, rounding, version integrity, concurrent publication, override authorization, estimate and quote separation, conversion, production safeguards. All existing suites stay green; Phase 2 behaviour does not change.
