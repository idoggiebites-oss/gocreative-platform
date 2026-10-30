import { useI18n } from '@/i18n'
import LanguageToggle from './LanguageToggle'

// No user data until the API exists: shows the role only.
export default function AccountBlock() {
  const { m } = useI18n()
  return (
    <div className="flex items-center gap-2.5 border-t border-border px-1.5 py-2">
      <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-brand-tint text-[11.5px] font-semibold text-primary">
        {m.shell.owner[0]}
      </div>
      <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{m.shell.owner}</span>
      <LanguageToggle />
    </div>
  )
}
