// npm run check:launch: run before the S4 Access cut-over and before opening intake. Exits 1 while any placeholder remains.
import { launchBlockers } from '../shared/launch.ts'

const blockers = launchBlockers()
for (const b of blockers) console.log(`BLOCKED: ${b}`)
console.log(blockers.length === 0 ? 'Ready: no placeholders remain.' : `${blockers.length} item(s) block launch.`)
process.exit(blockers.length === 0 ? 0 : 1)
