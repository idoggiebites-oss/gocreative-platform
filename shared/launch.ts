// What must be true before anyone outside staff can see the storefront (S4). A placeholder must never reach the public.
import { business } from './business.ts'

export function launchBlockers(b: Pick<typeof business.storefront, 'contact' | 'launch'> = business.storefront): string[] {
  const out: string[] = []
  for (const [field, value] of Object.entries(b.contact)) if (!value) out.push(`Contact detail missing: ${field}`)
  if (!b.launch.photosSupplied) out.push('Placeholder photos are still in place')
  if (!b.launch.privacyReviewed) out.push('The privacy page is still a draft')
  if (!b.launch.servicesConfirmed) out.push('The services shown have not been confirmed by the shop')
  return out
}
