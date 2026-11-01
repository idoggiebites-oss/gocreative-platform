// Everything specific to the business this deployment serves. Nothing else in
// the codebase may name it (AGENTS.md). Another business = another copy of this file.
export const business = {
  name: 'GoCreative Designs',
  shortName: 'GoCreative',
  timeZone: 'America/Chicago',
  orderNumberPrefix: '',
  // The columns of every size grid, in display order (youth then adult).
  sizes: ['YS', 'YM', 'YL', 'S', 'M', 'L', 'XL', '2XL', '3XL'],
  modules: { storefront: true as boolean },
  storefront: {
    tagline: 'Custom printing, embroidery and engraving.',
    headline: 'Custom apparel for schools, teams and you.',
    intro: 'Printing, embroidery, engraving and custom trophies from a family shop. Tell us your idea and we will quote it.',
    // Null until the business supplies it: the site shows a labelled placeholder and never a guess.
    contact: { address: null, phone: null, email: null, hours: null } as Record<'address' | 'phone' | 'email' | 'hours', string | null>,
    // Both stay false until the real thing exists. scripts/launch-check.ts refuses a launch while they are.
    launch: { photosSupplied: false as boolean, privacyReviewed: false as boolean, servicesConfirmed: false as boolean },
    services: [
      {
        id: 'screen', name: 'Screen printing', short: 'Bold color for team shirts and events.', card: 'Bold, durable color for team shirts, events and spirit wear. Great for larger runs.',
        body: 'Ink pressed through a screen, one color at a time. Vivid, long-lasting, and the go-to for team and event shirts.',
        uses: ['Team shirts', 'Spirit wear', 'Events and fundraisers', 'Larger quantities'], photo: 'screen printing a run of school shirts', method: 'screen', cta: 'screen printing',
      },
      {
        id: 'embroidery', name: 'Embroidery', short: 'Stitched logos on polos, caps and bags.', card: 'Stitched logos on polos, jackets, caps and bags. Polished and built to last.',
        body: 'Your logo stitched in thread. Looks sharp on staff polos, jackets and caps, and holds up wash after wash.',
        uses: ['Staff polos', 'Caps and beanies', 'Jackets', 'Bags'], photo: 'embroidery machine stitching a logo', method: 'embroidery', cta: 'embroidery',
      },
      {
        id: 'dtg', name: 'Direct to garment', short: 'Full-color prints for small batches.', card: 'Full-color prints and photos with no setup, ideal for small batches.',
        body: 'Printed straight onto the fabric like a photo printer. Every color, gradients and photos, with no screens to set up.',
        uses: ['Photos and detailed art', 'Small batches', 'One-offs'], photo: 'full-color print on a tee', method: 'dtg', cta: 'DTG',
      },
      {
        id: 'laser', name: 'Laser engraving and cutting', short: 'Names and logos on drinkware and more.', card: 'Names and logos etched into drinkware, plaques, wood and more.',
        body: 'Names, logos and designs etched or cut with a laser. Clean detail on hard goods that last.',
        uses: ['Drinkware', 'Plaques and awards', 'Wood and acrylic'], photo: 'engraved wooden plaque', method: 'laser_engrave', cta: 'laser engraving',
      },
      {
        id: 'awards', name: 'Trophies and awards', short: 'Built and personalized for your event.', card: 'We order the parts, build each trophy and personalize it with names, years and logos. For seasons, banquets and recognition events.',
        body: 'We order the parts, build each award and personalize it with names, years and logos. Send us your list and we take it from there.',
        uses: ['Team trophies', 'Banquets and seasons', 'Staff recognition', 'Plaques'], photo: 'assembled trophies with engraved plates', method: 'laser_engrave', cta: 'trophies', product: 'trophies',
      },
    ],
    // What can be asked for, and how each can be made (STOREFRONT_PLAN §0c, confirmed by Arturo). `sized` shows the size grid.
    products: [
      { slug: 'tshirts', hint: 'Tees and long sleeves', name: 'T-shirts', methods: ['screen', 'embroidery', 'dtg'], sized: true },
      { slug: 'hoodies', hint: 'And sweatshirts', name: 'Hoodies', methods: ['screen', 'embroidery', 'dtg'], sized: true },
      { slug: 'polos', hint: 'Staff and uniforms', name: 'Polos', methods: ['screen', 'embroidery', 'dtg'], sized: true },
      { slug: 'bags', hint: 'Totes and backpacks', name: 'Bags', methods: ['screen', 'embroidery', 'dtg'], sized: false },
      { slug: 'hats', hint: 'Caps and beanies', name: 'Hats', methods: ['embroidery'], sized: false },
      { slug: 'trophies', hint: 'Built and personalized', name: 'Trophies and awards', methods: ['laser_engrave'], sized: false },
      { slug: 'engraved', hint: 'Drinkware, plaques, wood, acrylic', name: 'Engraved or cut items', methods: ['laser_engrave', 'laser_cut'], sized: false },
      { slug: 'other', hint: 'Tell us about it', name: 'Something else', methods: ['screen', 'embroidery', 'dtg', 'laser_engrave', 'laser_cut', 'other'], sized: false },
    ],
  },
} as const
