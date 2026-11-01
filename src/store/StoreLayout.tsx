import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Link, NavLink, Outlet, useLocation } from 'react-router'
import { Menu, X } from 'lucide-react'
import { business } from '@shared/business'

/** A fact the business hasn't supplied yet: labelled, never guessed. */
export function Contact({ field, label }: { field: keyof typeof business.storefront.contact; label: string }) {
  const value = business.storefront.contact[field]
  return value ? <>{value}</> : <span className="s-pending">[{label}]</span>
}

export const usePageTitle = (title: string) => useEffect(() => { document.title = `${title} | ${business.shortName}` }, [title])

const NAV = [{ to: '/services', label: 'Services' }, { to: '/#how', label: 'How it works' }, { to: '/#schools', label: 'Schools' }]

export function CtaLink({ children = 'Start an order', to = '/order', className = 's-btn' }: { children?: ReactNode; to?: string; className?: string }) {
  return <Link to={to} viewTransition className={className}>{children}</Link>
}

function Header() {
  const [open, setOpen] = useState(false)
  const toggle = useRef<HTMLButtonElement>(null)
  const { pathname, hash } = useLocation()
  useEffect(() => setOpen(false), [pathname, hash])
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false)
        toggle.current?.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])
  return (
    <header className="s-header">
      <div className="s-wrap s-header-row">
        <Link to="/" viewTransition className="s-logo">{business.shortName}</Link>
        <nav aria-label="Main" className="s-nav">
          {NAV.map((n) => (n.to.includes('#') ? <Link key={n.to} to={n.to} viewTransition>{n.label}</Link> : <NavLink key={n.to} to={n.to} viewTransition end>{n.label}</NavLink>))}
          <CtaLink className="s-btn s-btn-small" />
        </nav>
        <button ref={toggle} type="button" className="s-menu-button" aria-expanded={open} aria-controls="s-mobile-nav" aria-label={open ? 'Close menu' : 'Open menu'} onClick={() => setOpen(!open)}>
          {open ? <X aria-hidden /> : <Menu aria-hidden />}
        </button>
      </div>
      {open && (
        <nav id="s-mobile-nav" aria-label="Main" className="s-mobile-nav">
          {NAV.map((n) => <Link key={n.to} to={n.to} viewTransition>{n.label}</Link>)}
        </nav>
      )}
    </header>
  )
}

function Footer() {
  return (
    <footer className="s-footer">
      <div className="s-wrap s-footer-grid">
        <div className="s-stack-8">
          <span className="s-logo">{business.shortName}</span>
          <span>{business.storefront.tagline}</span>
        </div>
        <div className="s-stack-8">
          <strong>Visit or call</strong>
          <span><Contact field="address" label="Shop address" /></span>
          <span><Contact field="phone" label="Phone number" /></span>
          <span><Contact field="email" label="Email address" /></span>
        </div>
        <div className="s-stack-8">
          <strong>Hours</strong>
          <span><Contact field="hours" label="Opening hours" /></span>
          <Link to="/privacy" viewTransition>Privacy</Link>
        </div>
      </div>
    </footer>
  )
}

/** Route changes land at the top, or at the #section asked for, and hand focus to the page's heading. */
function useRouteLanding() {
  const { pathname, hash } = useLocation()
  const first = useRef(true)
  useEffect(() => {
    if (hash) {
      document.getElementById(hash.slice(1))?.scrollIntoView()
      return
    }
    window.scrollTo(0, 0)
    if (first.current) first.current = false
    else if (!pathname.startsWith('/order')) document.querySelector<HTMLElement>('main h1')?.focus({ preventScroll: true })
  }, [pathname, hash])
}

export default function StoreLayout() {
  useRouteLanding()
  const { pathname } = useLocation()
  const inOrder = pathname.startsWith('/order')
  return (
    <div className="store">
      <a href="#s-main" className="s-skip">Skip to content</a>
      {!inOrder && <Header />}
      <div id="s-main"><Outlet /></div>
      {!inOrder && <Footer />}
      {!inOrder && (
        <div className="s-sticky-cta"><CtaLink className="s-btn s-btn-block" /></div>
      )}
    </div>
  )
}
