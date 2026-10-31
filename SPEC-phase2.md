# Phase 2 Development Brief — Custom Print Shop Management Platform

> Version 2.0, the consolidated Phase 2 requirements, as Arturo wrote them on 2026-10-30
> (formatting only). This is **authoritative for Phase 2** and replaces SPEC.md §9's
> Phase 2 and the earlier drafted plan. It also absorbs the old Phase 3 (artwork
> uploads, PO documents) and Phase 5 (production queue). The implementation plan and
> its open questions are in [PHASE2_PLAN.md](PHASE2_PLAN.md); later decisions are in
> [DECISIONS.md](DECISIONS.md).

Development: Claude Code + OpenAI Codex. Priority: functional, production-quality implementation.

## 1. Project objective

Expand the existing application into a functional order management system for a family-owned printing and embroidery business.

The application must support the complete operational workflow:

Customer Inquiry → Quote → Approval → Purchasing → Production → Quality Control → Customer Pickup → Payment Tracking

The application should be professional, intuitive, and efficient enough for daily business use.

Important development instructions:

- Inspect the existing repository before making changes.
- Preserve the existing architecture and design system.
- Do not rebuild functionality that already exists.
- Follow established project conventions.
- Use existing Claude frontend design and animation skills where appropriate.
- Keep the interface light, airy, polished, and utilitarian.
- Prioritize functionality over unnecessary complexity.
- Avoid paid APIs and unnecessary subscriptions.
- Maintain compatibility with Cloudflare Workers, D1, and R2.
- Use Codex for independent review, testing, and security validation.

Do not implement everything simultaneously. Develop and test incrementally.

## 2. Customer and order management

The business receives most customer inquiries through email and phone calls. Staff will manually create orders in the application.

### Customer types

Support two primary customer categories:

**Individual / Regular Customer**
- Usually pays at pickup.
- Typically does not require a purchase order.
- Requires direct customer authorization before production.

**School District / Organization**
- Usually requires a purchase order.
- Generally pays after collecting the completed order.
- Typically pays by check, although ACH is also possible.

Allow customer type and authorization requirements to be configured independently.

### Order information

Each order should include: automatically generated order number; customer and contact information; order creation date; requested completion date; order source (Phone, Email, or Customer Portal); product descriptions; quantities and sizes; production method; artwork attachments; quote information; purchase order information; purchasing information; production progress; customer pickup information; payment status; internal notes; activity history.

An order may contain multiple products or line items.

## 3. Quotes and pricing

### Pricing structure

The family generally prices products using: Quantity × Unit Price = Line Total.

| Product | Quantity | Unit Price | Total |
|---|---|---|---|
| Gildan T-Shirt | 100 | $12.00 | $1,200 |
| Polo Shirt | 20 | $18.00 | $360 |
| Total | | | $1,560 |

Prices are examples only.

### Pricing requirements

Allow staff to: add multiple line items; enter product descriptions; enter quantities; record size breakdowns; set unit prices manually; calculate totals automatically; edit prices before quote approval; duplicate existing quotes; create new quote versions; record discounts or additional charges.

### Volume discounts

Larger orders generally receive lower per-unit pricing. For Phase 2: do not automate volume pricing. Allow employees to manually adjust unit prices based on order quantity. Preserve the agreed price on each accepted quote, even if future pricing changes.

### Garment sizes

The family generally does not charge different selling prices based on garment size. However, supplier costs may vary. Track sizes for purchasing and fulfillment, but do not automatically increase selling prices for larger sizes.

### Quote statuses

1. Draft 2. Sent 3. Accepted 4. Declined 5. Superseded

Every quote must have a version number. Accepted quotes should become immutable historical records. Changes require a new version.

**Important business rule:** quote acceptance does not automatically authorize production. Production authorization is handled separately.

**Exclusions:** do not implement automated quote emailing or PDF generation in this phase.

## 4. Artwork management and approval

Artwork approval must be tied to an actual artwork file or version.

Support: artwork uploads; artwork previews; version tracking; internal notes; approval history; customer approval recording.

Artwork statuses: Not Received; Under Review; Changes Requested; Approved; Not Required.

An artwork version cannot be approved unless it exists. If artwork is replaced or materially revised after approval, the new version requires approval.

**Production requirement:** production cannot begin unless the current artwork version is approved, or artwork has explicitly been marked Not Required.

Artwork preparation can happen while garments are being shipped.

## 5. Purchase order and authorization management

School districts generally require purchase orders. Regular customers typically authorize production directly.

**School district authorization.** Track: PO Required; PO Requested; PO Received; PO Under Review; PO Approved; PO Rejected / Correction Required. Allow staff to upload and associate PO documentation with the order.

**Regular customer authorization.** Allow staff to record direct authorization. Capture: authorization date; authorization method; employee recording authorization; optional notes.

**Production authorization rules.** An order may proceed only when:

1. The current quote is accepted.
2. Required artwork is approved.
3. Required PO approval or direct authorization is recorded.
4. Required materials are available.

These rules must be enforced on the backend. A frontend warning alone is insufficient. Authorization changes must be recorded in the activity history.

## 6. Supplier purchasing

The family generally purchases garments specifically for each customer order. They do not maintain significant blank garment inventory.

**Default supplier: JDS.** Approximately 99% of purchases are made through JDS. Make JDS the default supplier while allowing employees to select or create another supplier. Do not integrate directly with JDS yet.

**Purchasing information.** Track: supplier; product description; quantity; size breakdown; estimated unit cost; actual unit cost; estimated total cost; actual total cost; order date; expected arrival date; received date; purchasing notes.

**Purchasing statuses:** Not Ordered; Ordered; Partially Received; Received; Cancelled.

**Purchasing rules.** The application should not automatically purchase materials. Purchasing normally begins after the required authorization is recorded. Staff must manually confirm purchases. Track supplier costs separately from customer selling prices. This will eventually support profit-margin reporting.

**Inventory.** Do not build a full inventory management system. Only track materials purchased and received for specific orders.

## 7. Production preparation

The family generally prepares artwork, screens, or embroidery files while waiting for garments to arrive. Purchasing and production preparation should therefore operate independently.

Preparation statuses: Not Started; In Progress; Ready; Not Required.

**Production readiness.** Create a clear readiness checklist showing:

| Requirement | Status |
|---|---|
| Quote Accepted | Complete / Pending |
| Artwork Approved | Complete / Pending |
| PO or Authorization | Complete / Pending |
| Materials Received | Complete / Pending |
| Production Prep | Complete / Pending |

When every required condition is satisfied, the order becomes Ready for Production. Display missing requirements clearly.

## 8. Production management

**Primary operating model.** The family generally completes one production order before starting another. Design the production workflow around one active production job at a time. Multiple orders may be quoted, approved, purchased, and prepared simultaneously.

**Production queue.** Three primary sections: **Ready to Start** (orders that have completed all required approvals and preparation); **Currently in Production** (the active production job); **Completed Production** (orders that have finished production and moved into quality control or fulfillment).

**Dashboard behavior.** Prominently display the current production job. Include: order number; customer; product; quantity; production method; deadline; production progress; relevant notes. Below the active job, show upcoming orders. Allow employees to manually reorder the queue.

**Production statuses:** Awaiting Authorization; Awaiting Materials; Awaiting Preparation; Ready for Production; In Production; Quality Control; Ready for Pickup; Production Complete.

Keep production status separate from payment status.

**Concurrency rule.** Normally permit only one active production job. Enforce this consistently through backend transactions or equivalent safeguards, preventing two employees from starting separate jobs simultaneously. An administrator may be given an explicit override if operationally necessary.

Do not implement complicated employee scheduling, machine scheduling, or capacity planning.

## 9. Customer pickup workflow

Customers generally pick up completed orders. Do not implement shipping or delivery integrations in Phase 2.

Pickup workflow: 1. Production completed 2. Quality check completed 3. Ready for pickup 4. Customer notified 5. Customer picks up order 6. Pickup recorded.

Pickup information. Record: ready date; notification date; notification method; pickup date; name of person collecting order; employee completing pickup; optional notes.

Customer notification will initially be manual. No automated SMS or email notifications are required.

**Dashboard.** Create a Ready for Pickup section. Display orders awaiting customer collection. Allow staff to update pickup status directly from the dashboard or order detail page.

## 10. Payment tracking

The application will not process payments. Accounting will remain external, initially using Wave with manually imported PNC bank transactions. However, employees need operational visibility into outstanding customer payments.

**Regular customers.** Default payment arrangement: Payment Due at Pickup. Staff can manually record payment confirmation. If an employee attempts to release an unpaid order, display a warning. Require an authorized override to release an unpaid regular customer order.

**School districts.** Default payment arrangement: Payment Due After Pickup. School districts may collect orders before payment is received. Keep payment status separate from production completion and customer pickup.

**Payment information.** Track: order; amount due; amount received; outstanding balance; payment method; payment date; payment notes; employee recording payment.

Payment methods: Check; ACH; Cash; Card; Other.

Payment statuses: Unpaid; Partially Paid; Paid.

Payment status should be calculated from recorded payments and the agreed order total. Support multiple payments against an order. Do not store card numbers or sensitive bank account details.

## 11. School district check collection

School districts generally pay by check. A family member typically visits the district to collect the check. Create a lightweight check collection workflow.

**Collection information.** Track: school district; associated order; amount expected; amount received; optional check number; date check became available; date collected; employee collecting check; deposit date; deposit status; optional notes.

Collection statuses: Awaiting Payment; Ready for Collection; Collected; Deposited; Cleared.

Do not treat collecting or depositing a check as confirmation that it has cleared. Keep check collection status separate from the order's payment balance. Allow staff to record confirmation that a check has cleared without implementing bank synchronization.

**Dashboard.** Add an Outstanding Payments section. Show: customer; order number; amount outstanding; payment due date, if known; days outstanding; collection status; next action. Provide a dedicated view of checks awaiting collection.

## 12. Dashboard design

The internal dashboard must remain light, airy, professional, and highly utilitarian. Avoid excessive cards, decorative elements, or unnecessary navigation.

Recommended layout:

- **Top section, Business Overview:** active orders; quotes awaiting approval; orders awaiting authorization; ready for production; ready for pickup; outstanding payments.
- **Primary section, Current Production Job:** prominently display the active production order. Provide quick actions to update progress.
- **Secondary section, Upcoming Production:** show the next orders in the queue.
- **Action Required section:** highlight quotes needing attention; missing artwork; pending POs; materials awaiting arrival; customers awaiting pickup; checks ready for collection.

Interface requirements: responsive desktop and mobile layouts; searchable order tables; consistent status indicators; clear action buttons; useful loading and empty states; inline editing where appropriate; accessible keyboard navigation; minimal clicks for routine operations.

Employees should be able to manage most order-related activities from the order detail workspace. Avoid requiring navigation across numerous unrelated pages.

## 13. Database requirements

Extend the existing D1 schema rather than replacing it. Review existing tables and migrations before designing changes.

| Entity | Purpose |
|---|---|
| Customers | Customer information |
| Orders | Order records |
| OrderItems | Products, sizes, and quantities |
| Quotes | Versioned estimates |
| QuoteItems | Historical quoted pricing |
| Artwork | Artwork files and versions |
| Authorizations | Customer or PO authorization |
| PurchaseOrders | School district PO records |
| Suppliers | Supplier directory |
| OrderPurchases | Materials purchased per order |
| ProductionPreparation | Preparation tracking |
| ProductionJobs | Production queue and progress |
| PickupRecords | Customer pickup history |
| Payments | Manually recorded payments |
| CheckCollections | School district check tracking |
| ActivityLogs | Auditable changes |

Adapt these entities to the existing schema. Do not duplicate tables unnecessarily.

**Data integrity.** Implement: foreign key relationships; database indexes; appropriate constraints; transactional status updates; immutable accepted quote versions; server-side authorization; audit records for important changes.

Monetary values must use integer cents or another exact decimal representation. Do not use floating-point arithmetic for financial calculations.

## 14. Business rules and edge cases

The system must handle:

- **Quote revisions:** if an accepted quote changes, create a new version and require appropriate reapproval.
- **Artwork revisions:** replacing approved artwork invalidates approval for the new version.
- **PO changes:** a rejected or invalidated PO must prevent unauthorized production.
- **Partial shipments:** materials may arrive in multiple deliveries.
- **Partial payments:** customers may make more than one payment.
- **Check collection:** collecting a check does not automatically mean the funds have cleared.
- **Unpaid pickup:** school districts can collect orders before payment; regular customers require payment or an authorized override.
- **Concurrent users:** two employees must not accidentally activate separate production jobs.
- **Order completion:** production completion, customer pickup, and payment completion are separate milestones.
- **Cancelled orders:** preserve records and audit history rather than deleting operational information.

## 15. Explicit exclusions

Do not implement in Phase 2: full accounting; bank reconciliation; PNC integrations; Wave integrations; payment processing; automated invoicing; automated quote emails; PDF quote generation; automated customer notifications; JDS ordering integrations; full inventory management; shipping integrations; complex employee scheduling; machine scheduling; AI pricing estimation; multi-tenant SaaS infrastructure.

Keep future integration points modular.

## 16. Implementation plan

Claude Code should first inspect the existing repository and identify what is already implemented.

- **Step 1, architecture review.** Review the existing database schema, authentication, customer management, order management, current dashboard, existing UI components and Cloudflare configuration. Identify gaps against this specification.
- **Step 2, quotes and authorization.** Order line items; pricing calculations; quote versions; quote statuses; direct authorization; PO approval requirements; artwork approval dependencies.
- **Step 3, purchasing and preparation.** Supplier selection; JDS default; order-specific purchasing; materials receipt tracking; preparation statuses; production readiness checklist.
- **Step 4, production queue.** Single active production job; upcoming production queue; production status transitions; quality control; production history.
- **Step 5, pickup and payments.** Pickup workflow; manual payment recording; outstanding balances; school district check collection; dashboard follow-up views.
- **Step 6, polish and validation.** Responsive layouts; error handling; loading states; accessibility; security review; automated tests; documentation.

## 17. Claude Code and Codex collaboration

Use the existing GitHub repository.

**Claude Code leads:** architecture; database implementation; frontend design; business workflows; UI development; feature integration. Use installed design skills to maintain a premium application experience.

**Codex independently reviews:** database migrations; business-rule enforcement; authentication and permissions; financial calculations; concurrent production updates; API validation; security vulnerabilities; automated test coverage. Codex should identify defects and missing edge cases before features are considered complete.

Avoid simultaneous uncoordinated edits to the same files.

## 18. Acceptance criteria

Phase 2 is complete when staff can successfully:

1. Create a customer and order.
2. Add products, quantities, sizes, and prices.
3. Generate and revise a quote.
4. Record quote acceptance.
5. Upload and approve artwork.
6. Record direct authorization or PO approval.
7. Track purchasing from JDS.
8. Record material receipt and production preparation.
9. Move an eligible order into production.
10. Prevent unauthorized orders from entering production.
11. Complete quality control.
12. Mark an order ready for pickup.
13. Record customer notification and pickup.
14. Record regular customer payments.
15. Track school district outstanding balances.
16. Record check collection and deposit information.
17. View current production and pending actions from the dashboard.

All major workflows must have automated tests. Use realistic sample data during development. Do not mark features complete if they only display mock information without functional backend behavior.

## 19. Instructions to begin development

Review this specification against the existing repository. Before implementing changes: identify which requirements are already satisfied; identify missing functionality; review the existing database architecture; propose any required migrations; identify conflicting requirements or unclear assumptions; create a prioritized implementation checklist; recommend how Codex should independently review each milestone.

Do not redesign the application unnecessarily. Preserve existing functionality and visual consistency. Once the implementation plan is established, proceed incrementally, testing each milestone before moving to the next.

The objective is a polished, functional system that reflects how this family business actually operates, not a generic enterprise management platform.
