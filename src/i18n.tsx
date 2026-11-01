import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { en, type Lang, type Messages } from '@shared/i18n/en'
import { es } from '@shared/i18n/es'
import { businessToday } from '@shared/businessDate'

const MESSAGES: Record<Lang, Messages> = { en, es }
const LOCALES: Record<Lang, string> = { en: 'en-US', es: 'es-US' }
const KEY = 'lang'

function initialLang(): Lang {
  try {
    const saved = localStorage.getItem(KEY)
    if (saved === 'en' || saved === 'es') return saved
  } catch { /* storage blocked: fall through */ }
  return navigator.language?.toLowerCase().startsWith('es') ? 'es' : 'en'
}

export function makeFormat(lang: Lang) {
  const locale = LOCALES[lang]
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
  return {
    money: (cents: number) =>
      new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD' }).format(cents / 100),
    // 'YYYY-MM-DD' is a calendar date: build it in local time so it never shifts a day.
    date: (isoDate: string) => {
      const [y, m, d] = isoDate.slice(0, 10).split('-').map(Number)
      return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(new Date(y, m - 1, d))
    },
    /** Today in shop time ('YYYY-MM-DD', the same shape as an order's due date), not the browser's or UTC's. */
    todayIso: () => businessToday(new Date()),
    longDate: (d: Date) => new Intl.DateTimeFormat(locale, { weekday: 'long', month: 'long', day: 'numeric' }).format(d),
    weekdayDate: (isoDate: string) => {
      const [y, m, d] = isoDate.slice(0, 10).split('-').map(Number)
      return new Intl.DateTimeFormat(locale, { weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(y, m - 1, d))
    },
    /** 'Sun 1': weekday and day of month, for grouping a week. */
    dayLabel: (isoDate: string) => {
      const [y, m, d] = isoDate.slice(0, 10).split('-').map(Number)
      const date = new Date(y, m - 1, d)
      return `${new Intl.DateTimeFormat(locale, { weekday: 'short' }).format(date)} ${d}`
    },
    relative: (iso: string) => {
      const s = (new Date(iso).getTime() - Date.now()) / 1000
      const steps: [Intl.RelativeTimeFormatUnit, number][] = [['day', 86400], ['hour', 3600], ['minute', 60]]
      for (const [unit, size] of steps) if (Math.abs(s) >= size) return rtf.format(Math.round(s / size), unit)
      return rtf.format(0, 'second')
    },
  }
}

type I18n = { lang: Lang; setLang: (l: Lang) => void; m: Messages; fmt: ReturnType<typeof makeFormat> }
const Ctx = createContext<I18n | null>(null)

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [lang, set] = useState<Lang>(initialLang)
  useEffect(() => { document.documentElement.lang = lang }, [lang])
  const setLang = useCallback((l: Lang) => {
    set(l)
    try { localStorage.setItem(KEY, l) } catch { /* not persisted */ }
  }, [])
  const value = useMemo(() => ({ lang, setLang, m: MESSAGES[lang], fmt: makeFormat(lang) }), [lang, setLang])
  return <Ctx value={value}>{children}</Ctx>
}

export function useI18n(): I18n {
  const v = useContext(Ctx)
  if (!v) throw new Error('useI18n outside LanguageProvider')
  return v
}
