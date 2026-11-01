# Platform vision

> Source: Arturo's post-Phase 2 brief ([SPEC-post-phase2.md](SPEC-post-phase2.md), 2026-11-01). This file restates
> it as the standing reference; where they differ, the brief wins. Anything not in the brief is marked as a
> proposal.

## Two different things

| | What it is | Where its name lives |
|---|---|---|
| **The platform** | Reusable business-management software for small, independently owned businesses. **Not yet named.** | Nowhere yet. Code, docs and UI say "the platform". |
| **GoCreative** | Arturo's family business: printing, embroidery, engraving and customization, mainly for school districts. **The first client** of the platform. | `shared/business.ts`, `src/brand.css`, `index.html` title, and the deployment's Cloudflare resources. |

GoCreative is not the product's name. Branding belongs to GoCreative's *configuration*, not to the platform.
The repository (`gocreative-platform`), the D1 database (`gocreative`), the R2 bucket (`gocreative-files`) and
the Worker (`gocreative`) keep their names; renaming them is a separate, planned migration, never a side
effect (brief §3).

## Who it is for

Mom-and-pop businesses that run on paper, spreadsheets, text messages or disconnected tools. They want software
that fits how they already work, at a price a small business can carry, set up by people who listen to them.

## How we sell it (brief §1)

- A one-time **setup and configuration fee**: we learn the business and configure the platform to it.
- An affordable **monthly subscription**: hosting, maintenance and support.
- **Custom development** beyond configuration is quoted and charged separately.
- **Data ownership** is written into the offer: the business owns its records and files, can export them, and
  can leave. Offboarding is a defined process, not a negotiation.

## What we are not building

- A self-service website builder or a no-code platform. Owners describe their business; we configure it.
- Accounting, payment processing, payroll or bank sync. Wave (or the client's own tool) stays the books.
- Features for hypothetical customers. Each capability earns its place with a real client.

## The shape of the software (brief §2)

Three layers, built toward over time, never all at once:

1. **Platform core**: what every client needs. Authentication and users, roles, customers and contacts,
   orders/requests, quotes/estimates, documents, activity history and audit, notifications, payment status,
   dashboards, reporting, exports. No printing words or printing workflow in here.
2. **Optional business modules**: industry capabilities switched on per client. For printing these are artwork
   approval, purchase orders, garment purchasing, the production queue and screen-print estimating. Service,
   repair and retail modules are examples of what might follow, built only when a client needs them.
3. **Business configuration**: per client, set by us (platform administrators), never by the owner: name, logo,
   colours, terminology, enabled modules, workflow stages, permissions, settings, and the customer-facing
   experience.

## Principles

- **Build for GoCreative today; keep the door open for many businesses tomorrow** (brief §10). GoCreative's
  workflow is never weakened to make the code more generic. Generalising happens when a second real client
  shows exactly what must vary.
- **One codebase.** Clients differ by configuration and enabled modules, not by forks.
- **Owners don't configure software.** If a setting needs explaining, we set it.
- **Trust is the product.** Customer data is protected, never sold or mined, and always exportable.
- **Cheap to run.** The Cloudflare free/low tiers carry a small business; no paid APIs or AI inference without
  Arturo's explicit approval (brief §6).

## Where we are (2026-11-01)

- GoCreative's internal application (Phase 2) is complete and live.
- Next: the architecture readiness review ([PLATFORM_ARCHITECTURE_REVIEW.md](PLATFORM_ARCHITECTURE_REVIEW.md),
  [SAAS_READINESS.md](SAAS_READINESS.md)), then GoCreative's customer storefront
  ([STOREFRONT_PLAN.md](STOREFRONT_PLAN.md)). Order of work: [ROADMAP.md](ROADMAP.md).

## Open questions for Arturo (not in the brief)

1. The platform's name, when you want one. Nothing blocks on it.
2. How clients' own staff sign in on a shared platform. Today it is Cloudflare Access with an email allow-list
   per deployment; see SAAS_READINESS.md.
3. The data-retention promise to put in the offer (for example, export available for N days after
   cancellation, then deletion). See SAAS_READINESS.md §5.
