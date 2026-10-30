import { useI18n } from '@/i18n'
import LanguageToggle from './LanguageToggle'

export default function SettingsPage() {
  const { m } = useI18n()
  return (
    <div className="mx-auto flex w-full max-w-[1240px] flex-col gap-5 px-4 pt-6 pb-10 sm:px-8">
      <h1 className="text-xl font-semibold tracking-[-0.015em]">{m.nav.settings}</h1>
      <section className="flex flex-wrap items-center justify-between gap-3 rounded-[10px] border border-border bg-card px-4 py-3.5 shadow-[0_1px_2px_rgba(28,27,25,.04)]">
        <div className="flex flex-col">
          <h2 className="text-sm font-semibold">{m.shell.language}</h2>
          <span className="text-xs text-muted-foreground">{m.settings.languageHelp}</span>
        </div>
        <LanguageToggle />
      </section>
    </div>
  )
}
