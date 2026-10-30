import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'
import type { Lang } from '@shared/i18n/en'

export default function LanguageToggle({ className }: { className?: string }) {
  const { lang, setLang, m } = useI18n()
  return (
    <div role="group" aria-label={m.shell.language} className={cn('inline-flex rounded-md border border-input bg-card p-0.5', className)}>
      {(['en', 'es'] as Lang[]).map((l) => (
        <button
          key={l}
          type="button"
          lang={l}
          aria-pressed={lang === l}
          aria-label={m.shell.languageName[l]}
          onClick={() => setLang(l)}
          className={cn(
            'h-6 min-w-8 rounded-[5px] px-1.5 text-[11.5px] font-semibold',
            lang === l ? 'bg-brand-tint text-primary' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {m.shell.languageShort[l]}
        </button>
      ))}
    </div>
  )
}
