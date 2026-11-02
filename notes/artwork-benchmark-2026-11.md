# Artwork benchmark, 2026-11-02: public school and sports art

A technical benchmark, **not production accuracy**: no real screen counts exist for these files, so every "actual" is Unknown and none enters an accuracy figure. Files and the full table are private, in `~/gocreative-validation/` on Arturo's Mac (`results.csv`), never in this repo. Many are trademarks, used here only to test.

Thirty distinct files by hash, through the real Artwork Check page in real Chrome; nothing uploaded. **11 got a count; 19 went to manual review** (6 analyzed and flagged, 13 refused).

## What it does well
Clean one-color art and flat logos: stable, and JPEG damage mostly moves results to manual review rather than to a confident wrong count. Photos and gradients went to review every time.

## Where it looks unreliable (by eye, not proven against screens)
1. **Transparent art: an ink can be taken for background.** Run directly, #22 drops its navy outline and #27 calls its blue figure background, both at high confidence. Today the SVG allowlist happens to stop these two; the same art as a PNG would not be stopped.
2. **White.** The same logo reads 3 on transparency and 2 flattened on white (#2), also 2 and 1 (#13). White may be ink, garment or background, and a file can't say. #11 reads 3 at high confidence; it looks like 4.
3. **Shading counted as inks.** #18 alone gives 8 from a bevel effect, with no review.
4. **Over-caution.** 13 of 30 refused, mostly plain logos with harmless editor attributes. Anti-aliased edges on transparency send flat wordmarks to review (#5, #16).

## Proposals: none applied, each needs independent review
Don't tune to this set, and measure again on other jobs after any change.
- Never mark a color as background when the image has real transparency.
- Report white as a stated assumption tied to garment color, or lower confidence when white is counted.
- Send a count above 4 or 5, or several near-shades of one color, to review.
- Allow harmless SVG metadata; decide on style attributes separately, since they carry risk.
- Don't count anti-aliased edge pixels toward "partly transparent".
- WebP support and clearer handling of CMYK JPEGs, if real files use them.

## Still needed
At least 30 real past jobs with screens actually used, including garment color and underbase, plus files as customers really send them: phone photos, screenshots, low-res JPEGs, PDFs. See notes/artwork-validation.md.

## After analyzer 2 (same 30 files, same page)

Still not production accuracy: every actual is Unknown. Full comparison: `~/gocreative-validation/before-after.txt`. Variants are stress tests, not extra examples.

- Refused: 13 before, 6 after (#3 and #28 gradients, #4 WebP, #10 CMYK, #17 a typo in the file, #27 a dash pattern).
- Counts given: 11 before; now 18 on a white item, 17 on a light one, **0 on a dark or unknown one**.
- Fixed confident errors, run directly: #22 2 to 3 (navy kept), #27 1 to 2 (figure kept, though its dash pattern now refuses it on the page). #18 8 to review.
- Garment changes the count on #1, #2, #13 and #22 (white ink), and #11 counts only on white.
- #8 lost its count: dropped details now mean review.
- JPEG and small-size variants: no count rose, none became confident where it wasn't. Heavier compression still goes to review.

Newly accepted and only plausible by eye, not proven: #5, #14, #16, #19, #20, #21, #22, #30.

