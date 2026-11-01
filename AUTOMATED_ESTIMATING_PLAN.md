# Automated estimating and pricing management: plan

> Status 2026-11-01: **proposal, awaiting Arturo's approval. Nothing here is built.** Source: his "Automated Estimating and Pricing Management" brief. E1 to E3 do not start without his go. Production pricing, migrations and public intake are unchanged.

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

**Pricing today:** staff type `unit_price_cents` on order items. `quotes` and `quote_items` are immutable snapshots enforced by triggers, with versions, one accepted quote per order, and `quoteSatisfied` in the production gate. There is no rules engine, cost data, garment catalogue or estimate storage; the old `estimates` table was dropped in 0002. Roles are only `owner` and `staff`. No image library is installed.

| Requirement in the brief | State | Evidence or gap |
|---|---|---|
| Several products and quantities in one inquiry | **Met** | `payload.lines`; one order item per line |
| Conversion doesn't accept preliminary prices | **Met** | Items convert at 0 cents, no quote is created (`lineToItem`, tests) |
| Immutable quotes, production authorization | **Met** | Triggers and the gate are untouched by S3 |
| Estimates separate from quotes | **Met by design** | Stays true if estimates get their own table (§6) |
| Artwork linked to products or print locations | **Gap** | `inquiry_files` has only `kind`; no line link and no print locations in the form |
| Estimate linked to an inquiry, with a status | **Gap, belongs in E1** | Nothing to link yet |
| Reproducible calculation | **Gap, belongs in E1** | Needs stored inputs and rule version |
| Old requests stay readable as rules change | **Defect found** | See §3 |

## 3. Changes genuinely needed before or during S3

S3 needs **no migration and no new columns** for estimating.

**One defect in shipped code, independent of estimating.** `parsePayload` reads stored requests with today's validation rules. Proven by test: a stored line whose product is no longer offered, or whose method no longer fits, returns null. The inquiry then shows no lines and cannot be converted. Any edit to the product map, which pricing work makes likely, would strand old requests. No live rows are affected: intake is closed and the table is empty.

*Proposed fix, small, for his go:* a separate lenient read schema for stored payloads (type checks only, unknown products displayed as stored, unknown fields kept). Validation stays strict at submit. A regression test covers the three cases above.

**Compatibility rules to keep from now on, no code needed:**
- `payload` remains versionless JSON read leniently, so E3 can add fields without a migration.
- Conversion never reads an estimate's price into an item.
- Public API responses remain explicit objects, so cost fields can't leak by accident.

## 4. Where analysis runs

This is the main architecture decision. **Recommendation: analyse in the browser with one shared pure function, and price on the server.**

| | Browser (recommended) | Worker |
|---|---|---|
| Malicious images | Decoded in the browser's sandbox; our server never parses them | A decoder for hostile files inside the Worker that holds the data |
| Limits | No server cost | 128 MB memory and a CPU limit. **The account's Workers plan is unverified; Free allows about 10 ms CPU, which rules this out** |
| Trust | The customer's result is **untrusted** | Trusted |
| Formats | PNG, JPEG, SVG through `<img>` with scripts inert | Each needs a WASM decoder |

Handling the trust gap:
- The server validates shape and range only, and stores the analysis as `source: customer_browser`.
- Tampering can only change a non-binding preliminary figure on the customer's own screen.
- **Staff re-run the same function on the stored file** in the dashboard, through the authenticated file route. That is the reviewed value; a mismatch is flagged.
- The stored file's SHA-256 ties each analysis to its bytes.

**PDF is not analysed in E1.** A pdf.js dependency isn't justified yet, so PDF means "Manual review required". Decision for Arturo if PDFs prove common.

## 5. E1: artwork analysis

`shared/artworkAnalysis.ts`: pure, deterministic, no randomness (no random-seed k-means), with an `ANALYZER_VERSION`. Input is RGBA at a capped size.

1. **Limits, before decoding:** the existing file caps, a maximum pixel area, and a downscaled working copy. Decode with `createImageBitmap` and `colorSpaceConversion: 'none'` for consistency across browsers. A failure or an oversize file means manual review.
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

**Calculation order, so an adjustment can't compound:**
1. Line cost: garment or material, plus decoration from the service's model (quantity tier, colours or stitches, size, location).
2. Markup or target margin on cost.
3. Setup, screen and digitizing fees.
4. **Service adjustment, applied exactly once, to this subtotal.**
5. Minimum order charge and minimum margin floor, which can raise the figure and may trigger manual review.
6. Rounding once per line total, half up, to the cent.

| Service | Pricing inputs |
|---|---|
| Screen print | Garment cost, quantity tier, colours per location, locations, print size, screen fee per colour |
| Embroidery | Garment cost, stitch-count or complexity band, quantity tier, digitizing fee |
| DTG | Garment cost, print size, locations, quantity tier |
| Laser and trophies | Material or part cost, machine time, setup. Awards likely stay manual review at first |

Any missing rate or unknown input gives `manual_review`, with reasons. **The engine has no default prices.** Until the family enters real numbers, every estimate is manual review.

**Tables (new, additive migration, E1). Each one is needed by a stated requirement:**
- `pricing_versions`: id, status, config JSON, config hash, source version for a rollback, created and published by and when. Immutable once published (trigger). One active version (partial unique index). Publishing is guarded by the active version the publisher previewed, so two concurrent publishes can't both win.
- `inquiry_estimates`: inquiry, pricing version, engine and analyzer versions, inputs JSON, customer result JSON, internal result JSON (cost and margin), status `available | assumption_based | manual_review_required`. Append-only. Deleted with its inquiry through the existing journaled path, which replay must then cover.
- `pricing_overrides`: append-only target, original, replacement, reason, actor, time. Never touches an accepted quote.

**Reproducibility:** stored inputs + stored rule config + engine version give the same result, tested by recalculating stored rows.

## 7. E2: Settings → Pricing Management

- **Simple (default view):** one percentage per service, a preview on sample estimates, draft and publish.
- **Advanced (collapsed, owner only):** the controls in the brief, shown per service, not as one universal form.
- **Simulator:** a sample order, showing published vs proposed, difference, internal cost, gross margin, assumptions and warnings. Draft rules never reach the storefront, because public calculations read only the active version.
- **Permissions (proposal):** `owner` publishes and sees costs and margins. `staff` see estimates and can override the colour count, complexity, print details and labour with a reason. Price overrides on a draft quote follow existing staff quote rights; `owner`-only is the alternative. No new role is needed.
- **Audit:** version history and overrides, with existing activity logging. Rollback publishes a copy as a new version.

## 8. E3: storefront integration

- The form gains print locations and print sizes per line, and artwork-to-line links, **in the payload JSON, no migration**. The upload acknowledgement already returns an id to link.
- `POST /api/public/estimate` is stateless, needs the session token, and counts against a per-session limit, because **unlimited pricing queries would let anyone map the formula**. The session currently opens at first upload, so Turnstile would run earlier in the form.
- At submit the server **recalculates** from the submitted lines and the active version, and stores that. The browser's figure is never trusted.
- The customer sees a total, its assumptions and clear "preliminary" wording; never costs, margins or per-rule breakdowns. Boundary tests cover this.
- Staff see estimate, analysis, re-analysis and overrides on the inquiry. An optional "start draft quote from this estimate" creates a **draft only**, which staff edit and send through the existing quote workflow.
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
| Pricing scraped through the estimate API | Session token, Turnstile, per-session limit, totals only |
| Costs leak | Separate internal JSON, explicit serializers, boundary tests; backups already encrypted offsite, plaintext on this Mac |
| Family doesn't maintain pricing | Simple view first; missing data falls back to manual review |
| Garment cost varies by style, and the form doesn't capture style | Assumed base garment per product, stated to the customer; or manual review |
| Scope grows into a general pricing system | Per-service models only; second client decides what generalizes |
| Workers plan unverified | Browser analysis avoids it; pricing arithmetic is far below any limit |

## 11. Decisions for Arturo

1. **Launch order:** finish E1 to E3 before S4 as proposed, or launch S4 first with manual quotes?
2. **Analysis location:** browser with staff re-analysis (recommended), or pay for server decoding?
3. **Price overrides:** existing staff quote rights, or owner only?
4. **Estimate display:** one figure or a range? A range is more honest for a preliminary figure (recommended).
5. **Compatibility fix (§3):** approve it now?

## 12. Testing and review

Codex reviews each milestone on: image-processing edge cases, malformed and malicious artwork, processing limits, formula correctness, rounding, version integrity, concurrent publication, override authorization, estimate and quote separation, conversion, production safeguards. All existing suites stay green; Phase 2 behaviour does not change.
