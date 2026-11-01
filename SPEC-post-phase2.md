# Post-Phase 2 Development Brief

> Arturo's brief, 2026-11-01, saved as given. Authoritative for the architecture review and the storefront
> preparation. Deliverables: PLATFORM_VISION.md, PLATFORM_ARCHITECTURE_REVIEW.md, SAAS_READINESS.md,
> STOREFRONT_PLAN.md, ROADMAP.md (updated).

Modular Business Management Platform — Architecture Review & Storefront Preparation

Project status: Phase 2 completed
Development environment: Claude Code + OpenAI Codex
Infrastructure: Cloudflare Workers, D1, R2
Platform name: To Be Determined
First client: GoCreative

## 1. Project Identity and Long-Term Vision

We are building a reusable, modular business management platform designed for small, independently owned businesses.

Important distinction: GoCreative is NOT the software platform's name.

GoCreative is our family's printing, embroidery, engraving, and customization business. It is the first business using the software.

The platform itself has not yet been named.

Our long-term goal is to provide affordable, professionally configured business management software to mom-and-pop businesses that currently rely on manual processes, spreadsheets, paperwork, or disconnected systems.

We want to offer personalized software without rebuilding an entirely new application for each customer.

### Business Model

Our anticipated commercial model includes:

- One-time setup and configuration fee
- Affordable monthly subscription
- Personalized workflow configuration performed by us
- Additional charges for significant custom development
- Ongoing software maintenance and support
- Clear data ownership, export, and offboarding policies

We are not building a self-service website builder or a general-purpose no-code platform.

Our customers describe their business operations, and we configure the software to fit their needs.

## 2. Architectural Philosophy

Our long-term objective is one reusable codebase with modular capabilities and configurable business workflows.

We want to avoid maintaining completely separate software projects for every business.

The architecture should eventually support three layers.

### Layer A — Platform Core

Reusable functionality shared by different industries.

Potential components include:

- Authentication and user management
- Role-based permissions
- Customer and contact management
- Order and request management
- Quotes and estimates
- Document management
- Activity history and audit logging
- Notifications
- Payment status tracking
- Dashboard infrastructure
- Reporting
- Data exports

These capabilities should not depend on printing-specific terminology or workflows.

### Layer B — Optional Business Modules

Industry-specific functionality that can be enabled or disabled depending on the client.

Examples include:

Printing and Customization
- Artwork approval
- Production queues
- Screen-printing estimates
- Garment purchasing
- Purchase order management

Service Businesses
- Appointment scheduling
- Service requests
- Job assignments
- Customer follow-ups

Repair Businesses
- Repair tickets
- Equipment tracking
- Parts management
- Service history

Retail Businesses
- Product management
- Inventory tracking
- Supplier management

These are examples of future capabilities, not requirements to implement immediately.

### Layer C — Business Configuration

Each client should eventually have its own:

- Business name
- Logo
- Brand colors
- Business terminology
- Enabled modules
- Workflow stages
- User permissions
- Business settings
- Customer-facing experience

The platform should be configurable by authorized platform administrators.

Business owners should not need to configure complex technical settings themselves.

## 3. GoCreative as the First Client

GoCreative is our first real-world implementation.

It currently requires:

- Customer management
- Order intake
- Quote management
- Artwork uploads and approvals
- School district purchase orders
- Supplier purchasing
- Production preparation
- Production tracking
- Customer pickup
- Payment tracking

These capabilities should continue working exactly as intended.

Do not compromise GoCreative's functionality to make the software more generic.

Instead, identify which capabilities are reusable and which should eventually become optional industry modules.

### Branding Separation

GoCreative branding belongs to the GoCreative business configuration.

Avoid introducing additional hardcoded GoCreative references into reusable platform components.

Do not rename the existing GitHub repository, database, or Cloudflare resources merely to reflect this distinction.

Any future naming changes should be planned as a separate migration.

## 4. Immediate Task — Post-Phase 2 Architecture Review

Phase 2 is complete.

Before starting storefront development, perform a focused architecture review of the existing implementation.

This is an assessment, not authorization for a major refactor.

### Review Area 1 — Code Modularity

Determine:

- Which components are already reusable?
- Which components depend on printing-specific logic?
- Are business rules separated from UI components?
- Are database operations properly abstracted?
- Can optional functionality eventually be disabled?
- Are there tightly coupled components that could become expensive to separate later?

### Review Area 2 — Workflow Configurability

Evaluate how difficult it would be to support different business workflows.

For example:

GoCreative uses:

Inquiry → Quote → Artwork Approval → PO Approval → Production → Pickup

A repair shop might use:

Service Request → Inspection → Estimate → Approval → Repair → Pickup

Determine whether the current architecture could eventually support both without duplicating the entire application.

Do not implement a universal workflow engine yet.

### Review Area 3 — Multi-Tenant Readiness

Evaluate what would be required for multiple businesses to use the same hosted platform securely.

Consider:

- Tenant identification
- Tenant-scoped database queries
- Authentication and authorization
- Business-specific settings
- Private file storage
- Role separation
- Cross-tenant access prevention
- Audit logging

Do not implement multi-tenancy yet.

Identify decisions we should make now to avoid expensive changes later.

### Review Area 4 — Security

Review the current implementation for:

- Authentication weaknesses
- Authorization bypasses
- Insecure file access
- Exposed secrets
- Unsafe database queries
- Missing input validation
- Excessive data collection
- Inadequate audit logging

We do not intend to store bank account numbers, payment card information, or other unnecessary financial credentials.

Customer contact information, artwork, purchase orders, and business records must still be protected.

Coordinate an independent security review with Codex.

### Review Area 5 — Data Ownership and Offboarding

Our platform's long-term promise includes:

Customers own their business data and can leave without being locked into our software.

Evaluate future support for:

- Exporting customer records
- Exporting orders and transaction history
- Downloading uploaded documents
- Exporting relevant configuration
- Account cancellation
- Defined data retention periods
- Secure deletion after offboarding

Do not build a full offboarding system yet.

Identify architectural requirements and potential obstacles.

## 5. Next Phase — GoCreative Customer Storefront

After completing the architecture review, prepare the customer-facing storefront for GoCreative.

The storefront is a client-specific experience built on the shared platform.

Not every future business will need a storefront.

It should eventually be an optional module.

### Design Direction

Create a polished, welcoming, mobile-first customer experience.

The storefront should feel different from the internal dashboard.

Internal Dashboard
- Light and airy
- Professional
- Utilitarian
- Information-dense where appropriate
- Optimized for operational efficiency

Customer Storefront
- Friendly and approachable
- Modern boutique-business appearance
- Attractive typography
- Clear calls to action
- Large artwork previews
- Simple navigation
- Mobile-first interactions

Both should share compatible design foundations while supporting separate layouts and branding.

Use relevant available Claude frontend design and animation skills.

Avoid generic AI-generated landing page aesthetics.

### Initial Storefront Features

Customers should be able to:

1. Learn about GoCreative's services.
2. Submit an order inquiry.
3. Select a requested product or service.
4. Enter quantities and specifications.
5. Upload artwork.
6. Provide contact information.
7. Submit the inquiry for review.
8. Receive a clear submission confirmation.

Submitted inquiries must flow into the existing internal order management system.

Employees should not have to manually reenter customer-submitted information.

### Future Storefront Features

Potential later additions:

- Customer accounts
- Order status tracking
- Quote acceptance
- Artwork approval
- Repeat ordering
- Automated notifications

Do not assume these are required for the initial storefront release.

### Storefront Security

Public submissions must be validated and rate-limited.

Uploaded files must be handled securely.

Do not expose internal customer records, employee notes, supplier costs, or other private information.

## 6. Technical and Cost Constraints

Continue using the existing technology stack wherever appropriate:

- Cloudflare Workers
- Cloudflare D1
- Cloudflare R2
- React
- TypeScript
- Tailwind CSS
- shadcn/ui
- Progressive Web App capabilities

Preserve the existing application architecture unless there is a documented reason to change it.

Keep infrastructure costs low.

Avoid unnecessary paid APIs and subscriptions.

Do not introduce AI inference costs without explicit approval.

Do not implement:

- Subscription billing
- Multi-tenant infrastructure
- Universal workflow builders
- Full accounting functionality
- Payment processing
- Large-scale architectural refactoring

These are future considerations.

## 7. Claude Code and Codex Responsibilities

Claude Code — Lead:
- Repository analysis
- Architecture documentation
- Modularity assessment
- Storefront planning
- Design system development
- Frontend implementation after approval

Codex — Independently review:
- Architectural findings
- Security concerns
- Data access patterns
- Database constraints
- Module boundaries
- Potential multi-tenant vulnerabilities
- Test coverage
- Storefront integration risks

Document disagreements and unresolved issues rather than silently selecting an approach.

Do not allow simultaneous uncoordinated edits to the same files.

## 8. Required Deliverables

Before storefront implementation, produce:

- **PLATFORM_VISION.md** — Document the long-term business and software vision, including the distinction between the unnamed platform and GoCreative.
- **PLATFORM_ARCHITECTURE_REVIEW.md** — Document current architecture, reusable components, printing-specific dependencies, and potential modularity issues.
- **SAAS_READINESS.md** — Evaluate future multi-tenancy, security, data isolation, scalability, data portability, and offboarding requirements.
- **STOREFRONT_PLAN.md** — Propose the GoCreative customer storefront's architecture, design direction, features, database integration, and development milestones.
- **ROADMAP.md** — Update the existing roadmap to reflect:
  1. Phase 2 — Completed
  2. Architecture readiness review
  3. GoCreative storefront
  4. End-to-end operational testing
  5. Modular platform development
  6. Multi-tenant security and infrastructure
  7. Second-industry pilot
  8. Commercial onboarding and offboarding

  Preserve existing roadmap information where relevant.

## 9. Development Instructions

Before writing new feature code:

1. Inspect the current repository.
2. Verify the actual implementation status of Phase 2.
3. Identify existing reusable infrastructure.
4. Review the architecture with Codex.
5. Document critical issues and technical debt.
6. Classify recommendations as:
   - Fix now: Security, data integrity, or architectural blockers affecting the storefront.
   - Fix before commercial launch: Tenant isolation, access control, export reliability, operational hardening.
   - Defer: Generalized workflows, optional modules, billing, and advanced configuration.
7. Create the storefront development plan.
8. Present findings for approval.

Do not begin a major refactor.

Do not deploy breaking changes.

Do not delete or reset production data.

Do not begin storefront implementation until the proposed plan is reviewed.

## 10. Final Objective

Our immediate goal is to finish a fully functional, polished GoCreative business application, including its customer-facing storefront.

Our long-term goal is to turn the underlying software into a configurable platform that can serve different small businesses without rebuilding the entire system.

Build for GoCreative today. Preserve the ability to serve many businesses tomorrow.

Prioritize real operational value, maintainability, affordability, security, and customer trust.

Do not overengineer features for hypothetical future customers.

Begin with the architecture review and documentation deliverables. Wait for approval before implementation.
