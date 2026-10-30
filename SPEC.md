# Master Project Specification

**Custom Print Shop Management Platform** — Version 1.0, Initial Development

> Arturo's brief, as written on 2026-10-30, with formatting only. Decisions made after it,
> in [DECISIONS.md](DECISIONS.md), override it where they differ: the first business is
> GoCreative Designs, login is Cloudflare Access, production is tracked per order, there are
> two users, and customer emails are in v1.

- Development: Claude Code + OpenAI Codex
- Infrastructure: Cloudflare
- Primary goal: Build a professional, affordable business management application that can eventually serve as the foundation for other small-business software projects.

## 1. Project overview

Build a production-quality application for a family-owned business specializing in:

- Screen printing
- Embroidery
- Direct-to-garment (DTG) printing
- Laser engraving
- Laser cutting
- Custom apparel and merchandise

The business primarily serves school districts, alongside individual customers.

Currently, most orders arrive through email or phone calls, and much of the administrative work is handled manually.

The application should streamline order management, artwork submissions, estimates, purchase orders, production tracking, and customer communication.

### Core philosophy

Do not reinvent existing software. Build the missing operational tools and integrate established services when necessary.

The initial application will not include payment processing or accounting functionality.

The family will initially use Wave for bookkeeping, with monthly manual imports of transactions from its PNC business checking account, subject to confirming the available import features.

Future accounting and payment integrations should be possible without redesigning the application.

## 2. Technology stack

| Component | Technology |
|---|---|
| Frontend | React + TypeScript |
| Styling | Tailwind CSS |
| UI components | shadcn/ui |
| Icons | Lucide |
| Backend | Cloudflare Workers |
| Database | Cloudflare D1 |
| File storage | Cloudflare R2 |
| Hosting | Cloudflare Workers Static Assets |
| Application format | Progressive Web App |
| Authentication | Secure session-based authentication |
| Testing | Vitest + Playwright |
| Version control | GitHub |
| Development | Claude Code + Codex |

Use Cloudflare's free-tier capabilities wherever practical.

Avoid unnecessary paid APIs, external subscriptions, and AI inference charges.

Important: The architecture must account for Cloudflare's resource limits, storage costs, and authentication requirements. Free-tier operation is a target, not a guarantee of permanently zero hosting costs.

## 3. Design system

Create two complementary experiences sharing a common design foundation.

### Internal management dashboard

Design philosophy: Utilitarian, efficient, and polished.

Visual inspiration: Linear, Shopify Admin, Stripe Dashboard.

Design requirements:

- Light and airy appearance
- Professional typography
- Soft neutral backgrounds
- Subtle borders and shadows
- Restrained accent colors
- Clear information hierarchy
- Efficient navigation
- Useful information density
- Minimal unnecessary clicks
- Responsive layouts

Avoid excessive whitespace that reduces productivity.

The interface should feel like professional business software rather than a generic admin template.

#### Primary layout

A persistent sidebar containing: Dashboard, Orders, Customers, Artwork, Purchase Orders, Production, Settings.

Include global search, notifications, and quick actions.

Support inline editing and status changes where appropriate.

### Customer storefront

Design philosophy: Welcoming, modern, and approachable.

The customer experience should resemble a boutique custom-products storefront.

Requirements:

- Mobile-first layout
- Friendly typography
- Attractive product and service categories
- Large artwork previews
- Simple order inquiry forms
- Clear progress indicators
- Accessible file uploads
- Minimal unnecessary steps

The storefront should share branding with the dashboard while maintaining its own layout and interaction patterns.

Use Claude's available frontend design and animation skills to improve visual quality. Animations should remain subtle, accessible, and performance-conscious.

## 4. Core application modules

### Module A: Dashboard

Display an overview of business operations.

Primary metrics:

- Active orders
- Pending quotes
- Artwork awaiting approval
- Purchase orders awaiting approval
- Orders in production
- Upcoming deadlines
- Orders ready for delivery

Include recent activity and a list of orders requiring attention.

### Module B: Order management

Allow employees to create, edit, search, filter, and manage orders.

Each order should contain:

- Unique order number
- Customer
- Contact information
- Order source: phone, email, or portal
- Products and quantities
- Sizes and variations
- Production method
- Artwork
- Estimated price
- Required completion date
- Internal notes
- Purchase order information
- Production status

Support multiple products and production methods within one order.

### Module C: Artwork management

Customers and employees can upload: PNG, JPEG, SVG, TIFF, PDF.

Features:

- File previews where supported
- Original file preservation
- Artwork version history
- Design approval status
- Internal artwork notes
- Association with customer and order records

Do not automatically overwrite original artwork.

### Module D: Screen-printing estimator

Create the foundation for an automated pricing estimator.

No LLM or paid AI API required.

Use traditional image-processing techniques to estimate:

- Dominant colors
- Potential spot-color count
- Artwork complexity
- Transparency
- Gradients and photographic elements

The initial implementation may use browser-side image processing to reduce server costs.

For traditional screen printing, the estimated number of printable colors must be reviewed by an employee.

JPEG compression, antialiasing, gradients, underbases, and garment color can affect the actual screen count.

The system must never treat an automated color estimate as a guaranteed production specification.

Pricing should eventually account for:

- Blank garment costs
- Quantity
- Screen setup charges
- Number of ink colors
- Printing labor
- Additional production costs

All pricing rules must be configurable.

### Module E: Purchase order management

School district orders require special handling.

Track:

- PO requested
- PO received
- PO under review
- PO approved
- PO rejected or correction required

Store associated documents securely.

Business rule: Orders requiring a purchase order cannot enter production until approval has been recorded.

Orders not requiring a PO may proceed through a separate authorization process.

Maintain a history of approvals and status changes.

### Module F: Production management

Track production independently from purchase order and payment status.

Suggested production stages:

1. Awaiting authorization
2. Awaiting artwork approval
3. Ready for production
4. In production
5. Quality control
6. Ready for pickup or delivery
7. Completed

Support production notes, assigned employees, and deadlines.

### Module G: Customer management

Maintain a searchable customer directory.

Each profile should include:

- Customer name
- Organization or school district
- Email
- Phone
- Contact persons
- Order history
- Saved artwork
- Internal notes

Customers may have multiple contacts and associated orders.

### Module H: Customer submission portal

Customers should be able to submit order inquiries without creating an account.

The submission process should collect:

- Customer contact information
- Requested products
- Quantities
- Production preferences
- Artwork uploads
- Requested completion date
- Additional instructions

The submission creates an order inquiry requiring employee review.

Future versions may support authenticated customer accounts and secure order-status access.

## 5. Application workflow

### Standard customer order

Inquiry received → Order created → Artwork reviewed → Estimate prepared → Customer approval → Production authorization → Production → Quality control → Pickup or delivery → Completed

### School district order

Inquiry received → Quote prepared → PO requested → PO received → PO approved → Production → Delivery → Invoice issued externally → Payment tracked externally

The application should maintain separate fields for:

- Quote status
- Artwork approval
- Purchase order status
- Production status
- Invoice reference
- Payment reference

Do not force all business processes into one status field.

The first release should not attempt to synchronize payments automatically.

## 6. Database architecture

Use Cloudflare D1.

Initial entities:

| Entity | Purpose |
|---|---|
| Users | Employee accounts |
| Customers | Customer records |
| CustomerContacts | Organization contacts |
| Orders | Primary order records |
| OrderItems | Products and quantities |
| Artwork | Uploaded files and versions |
| Estimates | Pricing estimates |
| PurchaseOrders | PO records |
| ProductionSteps | Production tracking |
| Notes | Internal comments |
| ActivityLogs | Auditable changes |

Use database migrations and enforce relationships.

Keep business logic separate from database access.

Use appropriate indexes for customer searches, order numbers, deadlines, and statuses.

## 7. Security requirements

Security is essential because the application will store customer information, school district documentation, and artwork.

Implement:

- Secure employee authentication
- Role-based access control
- Server-side authorization checks
- Input validation
- Protected file storage
- Secure upload limits and file validation
- Audit logging
- Rate limiting
- Secure session handling
- Environment-based secret management
- Database backup and recovery procedures

Customer-facing APIs must never expose internal notes, employee information, or another customer's records.

Do not rely on hidden frontend elements as a security boundary.

## 8. Progressive Web App requirements

The application must work across Windows, macOS, iPhone and iPad.

Support installation as a PWA where the platform permits it.

The dashboard should prioritize desktop productivity while remaining fully functional on mobile.

The storefront should be designed mobile-first.

Include a web app manifest, appropriate icons, and sensible caching.

Do not cache sensitive customer information or private documents inappropriately.

Offline editing and push notifications are future enhancements, not initial requirements.

## 9. Development phases

**Phase 1 — Foundation.** Initialize the project; configure Cloudflare Workers; establish the React frontend; configure Tailwind and shadcn/ui; create the design system; build responsive application layouts; establish D1 migrations; configure authentication; create development documentation. *Deliverable:* a functional application shell with polished navigation and authentication.

**Phase 2 — Internal operations.** Dashboard; customer management; order management; order detail pages; notes and activity history; status management. *Deliverable:* employees can create and manage real orders.

**Phase 3 — Artwork and purchase orders.** R2 uploads; artwork previews; artwork versioning; PO document management; PO approval workflow; production authorization rules. *Deliverable:* orders can move safely from intake to authorized production.

**Phase 4 — Customer storefront.** Branded storefront; service descriptions; order inquiry form; artwork submission; submission confirmation; internal inquiry review. *Deliverable:* customers can submit new work without calling or emailing.

**Phase 5 — Production workflow.** Production queue; status updates; deadline tracking; quality control; completion tracking. *Deliverable:* the family can manage daily production from the dashboard.

**Phase 6 — Artwork estimation.** An experimental, non-AI image-analysis tool. Begin with color quantization and visual previews. Require manual confirmation of screen count and pricing. *Deliverable:* a usable screen-printing estimation assistant.

## 10. Claude Code and Codex collaboration

Use one GitHub repository.

**Claude Code responsibilities** (primary development): project architecture, design system, frontend development, UI components, responsive layouts, application workflows, feature implementation. Claude should use relevant installed design skills when available.

**Codex responsibilities** (independent review and engineering support): code review, security analysis, database validation, automated testing, API testing, performance improvements, accessibility review, refactoring recommendations.

Both tools may contribute code, but work should be separated through branches or clearly defined tasks. Do not allow simultaneous uncoordinated edits to the same files.

Required development documents: README.md (setup and usage), SPEC.md (product requirements), ARCHITECTURE.md (technical design), DESIGN_SYSTEM.md (UI standards), ROADMAP.md (development phases), DECISIONS.md (architectural decisions), AGENTS.md (shared agent instructions).

## 11. Explicitly excluded from version 1

Do not implement: Clover integration, QuickBooks integration, Wave integration, automatic bank synchronization, full accounting functionality, payment processing, paid LLM APIs, automated invoice collection, complex multi-tenant SaaS infrastructure, native desktop or mobile applications.

Design appropriate integration boundaries for future expansion.

Avoid building functionality simply because it might eventually be useful.

## 12. Initial instructions for Claude Code

You are the lead software architect and frontend engineer for this project. Review the complete project specification before writing application code. Your objective is to create a professional, production-quality business management application using Cloudflare Workers, React, TypeScript, D1, and R2. The internal dashboard must be polished, utilitarian, efficient, and responsive. The customer storefront must be welcoming, visually refined, and mobile-first. Use the relevant frontend design and animation skills available in this environment. Avoid generic dashboard templates and unfinished placeholder interfaces.

First, inspect the repository and available development tools. Then produce: (1) a proposed project architecture, (2) a repository structure, (3) a design system proposal, (4) an initial database schema, (5) a phased implementation plan, (6) a testing and security strategy. Document assumptions and unresolved decisions. Do not begin implementing all features simultaneously. After the architecture is approved, begin Phase 1. Prioritize clean, maintainable code, reusable components, and excellent user experience. Keep operating costs as low as practical.

## Recommendation for the first build

Start with three exceptional screens: the main dashboard, the order list, and the order detail workspace. These will establish the application's design language and give the family something tangible to evaluate before investing time in the customer storefront or artwork analysis. Once the visual foundation is established, connect those screens to real data and progressively add the operational workflows.

The long-term opportunity is building affordable, tailored operational software for small businesses that currently rely on paperwork, spreadsheets, phone calls, and disconnected systems. The family's business becomes the first real-world implementation, and eventually the first case study.
