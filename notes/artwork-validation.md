# Validating the artwork analysis on real jobs

Customer prices stay off until this is done and Arturo approves. **Real artwork and job results never go in this repo**, which is public. `validation/` is ignored by git if you need a local folder.

## What to collect
At least 30 past jobs, each with the original artwork file, the number of screens actually used, the garment color, and whether an underbase was printed. Include the hard ones on purpose: gradients, photos, transparent backgrounds, thin lines, low-quality JPEGs. Choosing only clean logos would flatter the result.

## How to run it
1. Settings → Pricing Management → Artwork check, as an owner. Files stay in the browser and are never uploaded.
2. Choose the files, set each job's item color (white, light, dark), and type its screens used. A dark item never gets a count, so record the underbase in your own notes.
3. Download results. The results are kept only in that browser until cleared, so keep the CSV somewhere private.

## How to read it
- **Gave a count, and it was wrong** is the number that matters. It measures the colour count only: rates, limits and margin checks can still send a job to a person, so it isn't a count of customers shown a wrong price.
- **Sent to manual review** is safe but costs staff time. The notes list shows which kinds of artwork end up there.
- The exact-match range is a 95% interval. 30 out of 30 still only means roughly 89% or better.

## Rules
- Each file counts once, by its bytes: one file chosen thirty times is one job.
- Don't tune thresholds until they pass this sample, and then quote this sample's numbers. If settings change, measure again on jobs the change wasn't based on.
- No accuracy claim anywhere without these numbers and their range.
- Passing is Arturo's decision, not a threshold in the code. The switch is `customerEstimates` in `shared/business.ts`: a code change and a deploy, on purpose.
