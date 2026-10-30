import { useEffect, useState } from 'react'
import { Link, Outlet } from 'react-router'
import { Bell, Menu, Plus, Search } from 'lucide-react'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import { useI18n } from '@/i18n'
import AccountBlock from './AccountBlock'
import CommandPalette from './CommandPalette'
import ShopIdentity from './ShopIdentity'
import SideNav from './SideNav'

const isMac = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform)

const btn = 'inline-flex h-8 items-center justify-center gap-1.5 rounded-[7px] border border-input bg-card text-[13px] font-medium text-foreground hover:bg-secondary'

export default function AppShell() {
  const { m } = useI18n()
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        setPaletteOpen((o) => !o)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className="flex min-h-screen bg-background text-foreground">
      <aside className="sticky top-0 hidden h-screen w-[232px] shrink-0 flex-col gap-5 border-r border-border bg-sidebar px-3 py-4 lg:flex">
        <Link to="/app" aria-label={m.nav.dashboard} className="text-foreground no-underline"><ShopIdentity /></Link>
        <SideNav />
        <AccountBlock />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="sticky top-0 z-30 flex h-12 items-center gap-2 border-b border-border bg-sidebar px-3 lg:hidden">
          <button type="button" aria-label={m.shell.menu} onClick={() => setMenuOpen(true)} className={`${btn} w-8 shrink-0`}>
            <Menu className="size-4" strokeWidth={1.75} aria-hidden />
          </button>
          <ShopIdentity />
        </div>
        <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
          <SheetContent side="left" showCloseButton={false} className="w-[260px] gap-5 bg-sidebar px-3 py-4">
            <SheetTitle className="sr-only">{m.shell.menu}</SheetTitle>
            <SheetDescription className="sr-only">{m.nav.main}</SheetDescription>
            <ShopIdentity />
            <SideNav onNavigate={() => setMenuOpen(false)} />
            <AccountBlock />
          </SheetContent>
        </Sheet>

        <header className="flex flex-wrap items-center gap-3 border-b border-border bg-header px-4 py-3 sm:px-8">
          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            aria-label={m.shell.search}
            className="flex h-[34px] max-w-[480px] flex-[1_1_280px] items-center gap-2 rounded-lg border border-input bg-card px-2.5 text-left text-[13px] text-muted-foreground"
          >
            <Search className="size-[15px] shrink-0" strokeWidth={1.75} aria-hidden />
            <span className="min-w-0 flex-1 truncate">{m.shell.searchPlaceholder}</span>
            <kbd className="hidden rounded border border-input px-[5px] py-px font-sans text-[11px] font-medium sm:inline">{isMac ? '⌘K' : 'Ctrl K'}</kbd>
          </button>
          <div className="hidden grow sm:block" />
          <button type="button" aria-label={m.shell.notifications} className={`${btn} relative w-8 shrink-0 max-sm:ml-auto`}>
            <Bell className="size-4" strokeWidth={1.75} aria-hidden />
          </button>
          <button type="button" className={`${btn} px-3 border-primary bg-primary text-primary-foreground hover:bg-(--brand-hover)`}>
            <Plus className="size-[15px]" strokeWidth={2} aria-hidden />
            {m.shell.newOrder}
          </button>
        </header>

        <main className="flex min-w-0 flex-1 flex-col"><Outlet /></main>
      </div>

      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
    </div>
  )
}
