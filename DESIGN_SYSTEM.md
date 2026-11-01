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


## Storefront motion spec (2026-11-01; prototyped in the storefront mockups)

Built in S2 from this spec, using the `animate` skill's rules: animate transform and opacity only; never
`ease-in`; never `scale(0)`; UI motion stays under 300 ms; reduced motion removes movement and keeps only short
fades.

**Tools (Arturo, 2026-11-01):**
- **Storefront:** **Motion** (`motion/react`), code-split into the storefront bundle only, never loaded by the
  dashboard. Components come from **Motion Primitives** and **Watermelon UI** (both MIT), **copied in through the
  shadcn CLI or by hand, then adapted**: our tokens, Bricolage Grotesque + Figtree, one icon set (Lucide, already
  used by the dashboard), no Next-only dependencies such as `next-themes`. Never a wholesale install. Use
  Motion's full `transform` strings, not the `x`/`y` shorthands, and `useReducedMotion()` everywhere.
- **Page-to-page:** the View Transitions API.
- **Hover, press and colour:** CSS transitions.
- **Dashboard:** keeps "no decorative motion" and no motion library.

| Piece | Source | Used for |
|---|---|---|
| Transition Panel | Motion Primitives | the order steps: direction-aware enter **and exit** (replaces the CSS enter-only fallback) |
| Animated Group, In View | Motion Primitives | staggered reveals of the service sections and the how-it-works steps on scroll (once, 30–80 ms stagger) |
| Text Effect | Motion Primitives | the home hero headline, once on load, subtle (optional; feel-check before keeping) |
| Morphing Dialog | Motion Primitives | tapping a work photo opens it full-size in place |
| morphing-button | Watermelon | Submit morphs into the confirmation check |
| copy-confirm | Watermelon | copy the reference number, with a tick |
| file-upload, labeled-progress-indicator | Watermelon | starting point for the upload rows, reworked to our upload states and icons |

| What | Why | How |
|---|---|---|
| Page to page (home ↔ services ↔ order) | prevents a jarring swap | React Router `viewTransition` on links. The root crossfades 200 ms, ease-out. The header and the sticky "Start an order" bar get their own `view-transition-name`, so they stay put. Browsers without View Transitions just navigate. |
| Order step forward / back | spatial consistency | Transition Panel (Motion). The new step enters from the side you're moving toward: `translateX(24px)` + opacity to rest (back: `-24px`), 220 ms `cubic-bezier(0.23, 1, 0.32, 1)`. The old step leaves with a 150 ms fade. Focus moves to the new step's heading, and the step's live region announces "Step 2 of 4". |
| Progress bar | state indication | `transform: scaleX(step / 4)` from the left, 250 ms ease-out (never animating `width`). |
| Choice tiles and options | feedback | `:active` scale(0.97), 120 ms. Selection ring and background change color in 150 ms `ease`. No hover movement on touch; any hover motion goes behind `(hover: hover) and (pointer: fine)`. |
| Method list changing with the product | prevents a jarring change | New options fade up 6 px over 180 ms, staggered 40 ms. |
| Upload row added | spatial consistency | Enters with `@starting-style` (opacity + `translateY(6px)`), 200 ms. Progress fill uses `scaleX`, linear. An error changes color with no shake. |
| Submit → confirmation | delight (rare: once per inquiry) | The check badge pops from scale(0.9) in 260 ms, the check stroke draws in 320 ms, then the heading, reference and "what happens next" rise in sequence (220, 300, 380 ms). Under reduced motion: fades only. |
| Keyboard focus, typing, field validation | none | No animation. Validation messages appear instantly. |

Tokens: `--ease-out: cubic-bezier(0.23, 1, 0.32, 1)`, `--ease-in-out: cubic-bezier(0.77, 0, 0.175, 1)`. These are
added to the shared tokens (the dashboard keeps its own "no decorative motion" rule).
