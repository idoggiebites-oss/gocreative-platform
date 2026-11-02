// Limits and small pure rules for public inquiries. Numbers beyond the plan's are logged in DECISIONS.md for Arturo to change.
const MB = 2 ** 20

export const SESSION_HOURS = 2
export const SESSION_MAX_FILES = 5
export const SESSION_MAX_BYTES = 60 * MB
export const SESSION_MAX_ATTEMPTS = 20 // refused and removed uploads count: they return their bytes, but not forever
export const FILE_MAX_BYTES = 20 * MB
export const UPLOAD_DEADLINE_MINUTES = 10 // enough for 20 MB on a slow phone connection; a stalled request can't hold capacity longer
export const JSON_MAX_BYTES = 64 * 1024
export const IP_SESSIONS_PER_HOUR = 20 // cautious: a school shares one address
export const DAILY_MAX_SESSIONS = 300
export const DAILY_MAX_BYTES = 3 * 2 ** 30
export const OPEN_SESSIONS_MAX = 200
export const OUTSTANDING_MAX_BYTES = 2 * 2 ** 30
export const ORPHAN_GRACE_HOURS = 24
export const CLEANUP_BATCH = 500
export const ORPHAN_PAGES_PER_RUN = 10
export const USAGE_KEEP_DAYS = 7
export const SESSION_MAX_ESTIMATES = 20 // slows walking the price list; it doesn't hide what any one answer shows (plan §8)

// No 0/O or 1/I: this gets read aloud over the phone.
const REF_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'
export const newRef = (bytes: Uint8Array = crypto.getRandomValues(new Uint8Array(6))) =>
  `INQ-${Array.from(bytes, (b) => REF_ALPHABET[b % 32]).join('')}`

export const usageDay = (now: Date) => now.toISOString().slice(0, 10)
