# Privacy and estimate wording, for review

Prepared for review. **No formal legal review has happened.** Arturo decides who reviews it; `privacyReviewed` stays false until then.

## Live wording to check
- Privacy page (`src/store/PrivacyPage.tsx`), shown with its Draft notice.
- Preliminary estimate, Arturo's wording: "This estimate is based on your selections and uploaded artwork. Our team will review your request and send you a final quote for approval. Pricing may change after review."
- Otherwise: "Manual review required. Our team will review your request and send you a final quote for approval."
- Assumptions shown with a figure (`worker/domain/pricing/facts.ts`): standard item; background not printed; very small details not counted; artwork still needs review.
- Next steps, corrected 2026-11-02 so a job with no artwork isn't promised a proof: "You get a final quote. If your order uses artwork, we show you a proof too. Nothing is made until you approve."
- Purchase orders: "We confirm every PO with you before production."

## Appears only when customer prices are on
"To give you a preliminary estimate, your browser checks your artwork for things like ink colors, and sends us the result along with the file. A person reviews it before any final quote."

## Questions for the reviewer
1. Is "preliminary" clear enough that a figure isn't an offer the customer can accept?
2. Does the site need terms of sale, and does it have any? Not in the notes.
3. Do minors' or school-district rules apply, given school customers? Not in the notes.
4. Is the Turnstile and hashed-IP wording enough?
5. Backup period: see notes/retention-rules.md.
