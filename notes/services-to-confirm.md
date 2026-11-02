# Services to confirm with the shop

Arturo's item 12: the site must show what GoCreative actually does. The notes confirm the methods and the product-to-method map (STOREFRONT_PLAN §0c). The details below came from the mockup copy and are **not confirmed anywhere in the notes**. The family should confirm or strike each, then set `launch.servicesConfirmed` in `shared/business.ts`.

| Where | Claim | Source |
|---|---|---|
| Methods | Screen print, embroidery, DTG, laser engraving and cutting | Confirmed: AGENTS.md, §0c |
| Products | T-shirts, hoodies, polos, bags, hats, trophies and awards, engraved or cut items | Confirmed by Arturo: §0c |
| Trophies | Ordered, assembled and personalized by the shop | Confirmed by Arturo: §0c |
| Engraved goods | Drinkware, plaques, wood, acrylic | Confirmed by Arturo: §0c |
| Embroidery | Jackets, beanies | **To confirm** |
| T-shirts, bags | Long sleeves, sweatshirts, totes, backpacks | **To confirm** |
| Screen printing | "Great for larger runs" | **To confirm** |
| DTG | "No setup", "photos", "one-offs", "small batches" | **To confirm** |
| Home | "Family shop" | Notes say family print shop; confirm they want it public |
| Process | "A quote and a proof", "nothing is made until you approve both" | Matches the workflow for quotes and artwork; a job with no artwork has no proof. **To confirm wording** |
| Schools | "We confirm every PO with you before anything goes into production" | Matches the production gate; **confirm wording** |
| Pickup | "Approve, then pick up": no delivery or shipping mentioned | **To confirm** |

## Print details on the order form (E3)

Placeholders until the family confirms them, in `shared/business.ts` and `src/store/PrintDetails.tsx`: print locations (full front, full back, left chest, sleeve, somewhere else) and print size wording (small "about a left-chest logo", medium, large "a full front or back"). The customer-facing assumption "Based on our standard item" (`worker/domain/pricing/facts.ts`) also needs their check. None is a price.

