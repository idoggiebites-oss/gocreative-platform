import { business } from '@shared/business'
import { Contact, usePageTitle } from './StoreLayout'

// Retention follows Arturo's decisions (STOREFRONT_PLAN §0, §9). The backup period and this wording still need the legal check before launch.
export default function PrivacyPage() {
  usePageTitle('Privacy')
  return (
    <main className="s-wrap s-prose">
      <h1 tabIndex={-1} className="s-display s-h-page">Privacy</h1>
      {!business.storefront.launch.privacyReviewed && <p className="s-notice"><strong>Draft.</strong> This wording is pending review before the site opens.</p>}
      <h2 className="s-display">What we collect</h2>
      <p>When you send a request, we collect your name, your email or phone number, your organization if you give one, what you are asking for, and any files you upload.</p>
      <p>We do not ask for your address, date of birth or payment details on this site.</p>
      <h2 className="s-display">Why we collect it</h2>
      <p>Only to reply to your request, quote it and, if you go ahead, make your order.</p>
      {business.storefront.customerEstimates && <p>To give you a preliminary estimate, your browser checks your artwork for things like ink colors, and sends us the result along with the file. A person reviews it before any final quote.</p>}
      <h2 className="s-display">Keeping the site safe</h2>
      <p>We use Cloudflare Turnstile to check that a request comes from a person. We keep a scrambled version of your IP address to spot abuse, and never the address itself.</p>
      <h2 className="s-display">How long we keep it</h2>
      <ul>
        <li>Requests marked as spam: up to 30 days.</li>
        <li>Requests that do not become an order: up to 12 months.</li>
        <li>Requests that become an order: kept with that order's records.</li>
        <li>Backup copies expire within <span className="s-pending">[N weeks, to confirm]</span>.</li>
      </ul>
      <h2 className="s-display">Questions or deletion</h2>
      <p>To ask what we hold, or to have your request deleted sooner, contact {business.shortName} at <Contact field="email" label="email address" /> or <Contact field="phone" label="phone number" />.</p>
    </main>
  )
}
