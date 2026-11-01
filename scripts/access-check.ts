// node scripts/access-check.ts <https://host>: proves from outside, with no cookie, which paths Access challenges. Exits 1 on any surprise.
// Used for the S0c rehearsal and again at the S4 cut-over (notes/access-rescope.md).
const host = process.argv[2]?.replace(/\/+$/, '')
if (!host?.startsWith('https://')) throw new Error('Usage: node scripts/access-check.ts https://host')

const PUBLIC = ['/', '/services', '/inquire', '/some-page', '/api/health', '/api/public/ping', '/api/unknown']
const PROTECTED = [
  '/app', '/app/', '/app/orders', '/app/orders/2026-0001',
  '/api/app', '/api/app/', '/api/app/me', '/api/app/orders',
  // Spellings a path match might miss. The API behind them still re-verifies the JWT, but /app is only guarded by Access.
  '/APP', '/App/orders', '/API/APP/me', '//app', '//api/app/me', '/%61pp', '/%61pp/orders', '/api/%61pp/me', '/app%2Forders', '/public/../app', '/app?x=1', '/app/orders?x=1',
]

const challenged = async (path: string) => {
  let url = host + path
  for (let hop = 0; hop < 5; hop++) {
    const res = await fetch(url, { redirect: 'manual' })
    const to = res.headers.get('location') ?? ''
    if (res.status === 403 || (res.status >= 300 && res.status < 400 && /cloudflareaccess\.com/.test(to))) return { status: res.status, isAccess: true }
    if (res.status < 300 || res.status >= 400 || !to) return { status: res.status, isAccess: false }
    url = new URL(to, url).href // the asset layer normalises some spellings: what counts is where they land
  }
  throw new Error(`Too many redirects from ${path}`)
}

let wrong = 0
for (const [expected, paths] of [['open', PUBLIC], ['challenged', PROTECTED]] as const) {
  for (const path of paths) {
    const { status, isAccess } = await challenged(path)
    const got = isAccess ? 'challenged' : 'open'
    if (got !== expected) wrong++
    console.log(`${got === expected ? 'ok   ' : 'WRONG'} ${path}  expected ${expected}, got ${got} (${status})`)
  }
}
console.log(wrong === 0 ? 'All as expected.' : `${wrong} path(s) wrong.`)
process.exit(wrong === 0 ? 0 : 1)
