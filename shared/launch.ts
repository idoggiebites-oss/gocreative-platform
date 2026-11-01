// What must be true before anyone outside staff can see the storefront (S4). A placeholder must never reach the public.
import { business } from './business.ts'

const PLACEHOLDER = /^\s*$|^\[|placeholder|\btbd\b|example\.com/i

export function launchBlockers(b: Pick<typeof business.storefront, 'contact' | 'launch'> = business.storefront): string[] {
  const out: string[] = []
  for (const [field, value] of Object.entries(b.contact)) if (!value || PLACEHOLDER.test(value)) out.push(`Contact detail missing: ${field}`)
  if (!b.launch.photosSupplied) out.push('Placeholder photos are still in place')
  if (!b.launch.privacyReviewed) out.push('The privacy page is still a draft')
  if (!b.launch.servicesConfirmed) out.push('The services shown have not been confirmed by the shop')
  return out
}

/** The flags are a person's word; this checks the pages themselves, so setting a flag can't hide what is still there. */
export function sourceBlockers(src: { photo: string; privacy: string }): string[] {
  const out: string[] = []
  if (src.photo.includes('Placeholder photo:')) out.push('The photo component still renders placeholder labels')
  if (src.privacy.includes('to confirm]')) out.push('The privacy page still has an unconfirmed period')
  return out
}
