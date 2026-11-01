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
    // What can be asked for, and how each can be made (STOREFRONT_PLAN §0c, confirmed by Arturo). `sized` shows the size grid.
    products: [
      { slug: 'tshirts', name: 'T-shirts', methods: ['screen', 'embroidery', 'dtg'], sized: true },
      { slug: 'hoodies', name: 'Hoodies', methods: ['screen', 'embroidery', 'dtg'], sized: true },
      { slug: 'polos', name: 'Polos', methods: ['screen', 'embroidery', 'dtg'], sized: true },
      { slug: 'bags', name: 'Bags', methods: ['screen', 'embroidery', 'dtg'], sized: false },
      { slug: 'hats', name: 'Hats', methods: ['embroidery'], sized: false },
      { slug: 'trophies', name: 'Trophies and awards', methods: ['laser_engrave'], sized: false },
      { slug: 'engraved', name: 'Engraved or cut items', methods: ['laser_engrave', 'laser_cut'], sized: false },
      { slug: 'other', name: 'Something else', methods: ['screen', 'embroidery', 'dtg', 'laser_engrave', 'laser_cut', 'other'], sized: false },
    ],
  },
} as const
