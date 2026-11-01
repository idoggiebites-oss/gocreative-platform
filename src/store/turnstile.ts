// Loads the Turnstile widget only when a session is about to open, so browsing the site contacts no third party.
import { PublicError } from './publicApi'

type Turnstile = {
  render: (el: HTMLElement, opts: Record<string, unknown>) => string
  execute: (id: string) => void
  remove: (id: string) => void
}
declare global { interface Window { turnstile?: Turnstile } }

const SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
const refused = () => new PublicError('verification_failed', 'We could not verify your browser. Please try again.')
let loading: Promise<Turnstile> | undefined

function load() {
  loading ??= new Promise<Turnstile>((resolve, reject) => {
    if (window.turnstile) return resolve(window.turnstile)
    const fail = () => {
      loading = undefined // a blocked, failed or hung load can be retried
      s.remove()
      reject(refused())
    }
    const s = document.createElement('script')
    const deadline = setTimeout(fail, 20_000)
    s.src = SCRIPT
    s.async = true
    s.onload = () => {
      clearTimeout(deadline)
      if (window.turnstile) resolve(window.turnstile)
      else fail()
    }
    s.onerror = () => {
      clearTimeout(deadline)
      fail()
    }
    document.head.append(s)
  })
  return loading
}

/** One single-use token. Usually invisible; if a challenge is needed, it appears in #turnstile-slot. */
export async function runTurnstile(siteKey: string) {
  const turnstile = await load()
  const slot = document.getElementById('turnstile-slot')
  if (!slot) throw refused()
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => finish(() => reject(refused())), 120_000)
    const finish = (settle: () => void) => {
      clearTimeout(timer)
      turnstile.remove(id)
      settle()
    }
    const id: string = turnstile.render(slot, {
      sitekey: siteKey, action: 'inquiry', execution: 'execute', appearance: 'interaction-only',
      callback: (token: string) => finish(() => resolve(token)),
      'error-callback': () => finish(() => reject(refused())),
      'expired-callback': () => finish(() => reject(refused())),
    })
    turnstile.execute(id)
  })
}
