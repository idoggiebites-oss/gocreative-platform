# Design system


One set of tokens and two layouts.

- **Type:** Inter for the dashboard (tabular numbers in tables). For the
  storefront, a warmer display face for headings only (candidate: Fraunces or
  Bricolage Grotesque). Inter is the body text on both.
- **Colour:** warm neutral greys (stone, not blue-slate). One accent, which comes
  from the shop's brand if it has one (otherwise a deep ink-blue). Status colours
  are used only for meaning: amber = waiting on someone, blue = in progress,
  green = done/approved, red = blocked/rejected. Each status always has a text
  label, never colour alone.
- **Dashboard:** dense by default. 13–14px tables, 32px rows, a fixed sidebar that
  collapses to an icon rail under 1024px and becomes a bottom sheet on phones.
  ⌘K global search and command palette. Status changes happen inline from a badge
  dropdown. The order detail page is a workspace: header with all five status
  tracks, then tabs for Items / Artwork / Quote / PO / Production / Activity.
- **Storefront:** mobile-first, large type, a category grid of photos (screen print,
  embroidery, DTG, laser), a 3-step inquiry form with a progress bar, and a large
  drag-and-drop artwork upload with previews.
- **Motion:** 150–200ms ease-out on state changes only. No motion when the user
  has `prefers-reduced-motion` set. No decorative motion in the dashboard.
- Before building the first screens, I run the design skills that are installed
  (frontend-ui-engineering, emil-design-eng, apple-design) and do one visual
  mockup for you to review.


## Brand (GoCreative Designs)

GoCreative has no website, logo or brand colour yet. Phase 1 uses a typographic
wordmark and the default ink-blue accent. Both are set in `src/brand.css` and
`shared/business.ts`, so replacing them later is a two-file change.
