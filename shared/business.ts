// Everything specific to the business this deployment serves. Nothing else in
// the codebase may name it (AGENTS.md). Another business = another copy of this file.
export const business = {
  name: 'GoCreative Designs',
  shortName: 'GoCreative',
  timeZone: 'America/Chicago',
  orderNumberPrefix: '',
  // The columns of every size grid, in display order (youth then adult).
  sizes: ['YS', 'YM', 'YL', 'S', 'M', 'L', 'XL', '2XL', '3XL'],
} as const
