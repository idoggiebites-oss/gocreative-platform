import { useEffect } from 'react'

const FOCUSABLE = 'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled)'

/** Make an element a valid, non-tab-stop focus target and focus it. */
const focusEl = (el: HTMLElement) => {
  if (!el.matches(FOCUSABLE) && !el.hasAttribute('tabindex')) el.tabIndex = -1
  el.focus({ preventScroll: true })
}

/**
 * When the focused control goes away (a button that disappears or changes into another after its action succeeds, a banner that
 * clears, a move button that becomes disabled), the browser drops focus to the page body and a keyboard user starts over from
 * the top. This puts it back on something stable: the first enabled control next to where it was, else the surrounding
 * section or tab panel, else <main>. It only acts when focus is on the body, so anything that manages its own focus
 * (dialogs, menus, StatusMenu) wins. Phase 1 carry-over, closed in M6.
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
    const check = () => {
      if (document.activeElement && document.activeElement !== document.body) return
      if (!last || (last.isConnected && !last.matches(':disabled'))) return
      const lost = last
      last = null
      for (let i = 0; i < chain.length; i++) {
        const a = chain[i]
        if (!a.isConnected) continue
        if (i === 0) return focusEl(a.querySelector<HTMLElement>(FOCUSABLE) ?? a)
        if (a.matches('section, [role=tabpanel], main')) return focusEl(a)
      }
      const main = document.querySelector<HTMLElement>('main')
      if (main && lost !== main) focusEl(main)
    }
    const schedule = () => {
      clearTimeout(timer)
      timer = setTimeout(check, 120)
    }
    document.addEventListener('focusin', onIn)
    const obs = new MutationObserver(schedule)
    obs.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled'] })
    return () => {
      document.removeEventListener('focusin', onIn)
      obs.disconnect()
      clearTimeout(timer)
    }
  }, [])
}
