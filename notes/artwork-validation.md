# Validating the artwork analysis on real jobs

Customer prices stay off until this is done and Arturo approves. **Real artwork and job results never go in this repo**, which is public. `validation/` is ignored by git if you need a local folder.

## What to collect
At least 30 past jobs, each with the original artwork file and the number of screens actually used. Include the hard ones on purpose: gradients, photos, transparent backgrounds, thin lines, low-quality JPEGs. Choosing only clean logos would flatter the result.

## How to run it
1. Settings → Pricing Management → Artwork check, as an owner. Files stay in the browser and are never uploaded.
2. Choose the files, type each job's screens used.
3. Download results. The results are kept only in that browser until cleared, so keep the CSV somewhere private.

## How to read it
- **Would have priced a job with the wrong count** is the number that matters: the analysis gave a count, the customer would have seen a price, and the count was wrong.
- **Sent to manual review** is safe but costs staff time. The notes list shows which kinds of artwork end up there.
- The exact-match range is a 95% interval. 30 out of 30 still only means roughly 89% or better.

## Rules
- Don't tune thresholds until they pass this sample, and then quote this sample's numbers. If settings change, measure again on jobs the change wasn't based on.
- No accuracy claim anywhere without these numbers and their range.
- Passing is Arturo's decision, not a threshold in the code. The switch is `customerEstimates` in `shared/business.ts`: a code change and a deploy, on purpose.
