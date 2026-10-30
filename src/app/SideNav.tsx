import { NavLink } from 'react-router'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'
import { SECTIONS } from './sections'

// Sidebar links, exactly the mockup's: 34px rows, 7px radius, active = white chip with ring.
function Item({ s, onNavigate }: { s: (typeof SECTIONS)[number]; onNavigate?: () => void }) {
  const { m } = useI18n()
  return (
    <NavLink
      to={s.to}
      end={s.to === '/app'}
      onClick={onNavigate}
      className={({ isActive }) =>
        cn(
          'flex h-[34px] items-center gap-2.5 rounded-[7px] px-2.5 text-[13.5px] font-medium text-[#4A4741] no-underline hover:bg-secondary hover:text-foreground',
          isActive && 'bg-card text-foreground shadow-[0_0_0_1px_#E4E1DB,0_1px_2px_rgba(28,27,25,.05)] hover:bg-card',
        )
      }
    >
      {({ isActive }) => (
        <>
          <s.icon className={cn('size-4 shrink-0', isActive ? 'text-primary' : 'text-[#7A766E]')} strokeWidth={1.75} aria-hidden />
          {m.nav[s.key]}
        </>
      )}
    </NavLink>
  )
}

export default function SideNav({ onNavigate }: { onNavigate?: () => void }) {
  const { m } = useI18n()
  return (
    <>
      <nav aria-label={m.nav.main} className="flex flex-col gap-0.5">
        {SECTIONS.filter((s) => s.key !== 'settings').map((s) => <Item key={s.key} s={s} onNavigate={onNavigate} />)}
      </nav>
      <div className="grow" />
      <nav aria-label={m.nav.account} className="flex flex-col gap-0.5">
        {SECTIONS.filter((s) => s.key === 'settings').map((s) => <Item key={s.key} s={s} onNavigate={onNavigate} />)}
      </nav>
    </>
  )
}
