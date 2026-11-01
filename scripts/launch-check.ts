// npm run check:launch: run before the S4 Access cut-over and before opening intake. Exits 1 while any placeholder remains.
import { readFileSync } from 'node:fs'
import { launchBlockers, sourceBlockers } from '../shared/launch.ts'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const blockers = [...launchBlockers(), ...sourceBlockers({ photo: read('../src/store/Photo.tsx'), privacy: read('../src/store/PrivacyPage.tsx') })]
for (const b of blockers) console.log(`BLOCKED: ${b}`)
console.log(blockers.length === 0 ? 'Ready: no placeholders remain.' : `${blockers.length} item(s) block launch.`)
process.exit(blockers.length === 0 ? 0 : 1)
