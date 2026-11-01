import { useEffect } from 'react'

const FOCUSABLE = 'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled)'

/** Make an element a valid, non-tab-stop focus target and focus it. */
const focusEl = (el: HTMLElement) => {
  if (!el.matches(FOCUSABLE) && !el.hasAttribute('tabindex')) el.tabIndex = -1
  el.focus({ preventScroll: true })
}

const usable = (el: HTMLElement) =>
  el.isConnected && !el.matches(':disabled') && !el.closest('[inert], [aria-hidden=true]') &&
  getComputedStyle(el).visibility !== 'hidden' && el.getClientRects().length > 0

const DIALOG = '[role=dialog], [role=alertdialog], dialog[open]'
const RECOVERY_MS = 100

/**
 * When the focused control goes away (a button that disappears or changes into another after its action succeeds, a banner that
 * clears, a move button that becomes disabled), the browser drops focus to the page body and a keyboard user starts over from
 * the top. This puts it back on something stable: the first usable control next to where it was, else the surrounding
 * section or tab panel, else <main>. One bounded check is scheduled per focus loss (later mutations do not postpone it). It
 * only acts when focus is on the body (or still on the disabled control) and no dialog is open, so anything that manages its own
 * focus (dialogs, menus, StatusMenu, a field being typed in) wins. Phase 1 carry-over, closed in M6.
 */
export function useKeepFocus() {
  useEffect(() => {
    let last: HTMLElement | null = null
    let chain: HTMLElement[] = []
    let timer: ReturnType<typeof setTimeout> | undefined
    const onIn = (e: FocusEvent) => {
      const t = e.target
      if (!(t instanceof HTMLElement) || t === document.body) return
      last = t
      chain = []
      for (let a = t.parentElement; a && a !== document.body; a = a.parentElement) chain.push(a)
    }
    const lostFocus = () => {
      if (!last || document.querySelector(DIALOG)) return false
      const a = document.activeElement
      const gone = !last.isConnected || last.matches(':disabled')
      return gone && (!a || a === document.body || a === last)
    }
    const tryFocus = (cands: HTMLElement[]) => {
      for (const el of cands) {
        if (!usable(el)) continue
        focusEl(el)
        if (document.activeElement === el) return true
      }
      return false
    }
    const check = () => {
      timer = undefined
      if (!lostFocus()) return
      const lost = last!
      const cands: HTMLElement[] = []
      chain.forEach((a, i) => {
        if (!a.isConnected) return
        if (i === 0) cands.push(...a.querySelectorAll<HTMLElement>(FOCUSABLE), a)
        else if (a.matches('section, [role=tabpanel], main')) cands.push(a)
      })
      const main = document.querySelector<HTMLElement>('main')
      if (main && main !== lost) cands.push(main)
      tryFocus(cands) // focusin makes the new target `last`, so if it too goes away (a transient container) it is recovered again
    }
    const schedule = () => {
      if (timer === undefined && lostFocus()) timer = setTimeout(check, RECOVERY_MS)
    }
    document.addEventListener('focusin', onIn)
    const obs = new MutationObserver(schedule)
    obs.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'hidden', 'inert', 'aria-hidden'] })
    return () => {
      document.removeEventListener('focusin', onIn)
      obs.disconnect()
      clearTimeout(timer)
    }
  }, [])
}
