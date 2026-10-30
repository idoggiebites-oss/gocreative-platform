import type { LucideIcon } from 'lucide-react'
import { useI18n } from '@/i18n'

export default function ComingSoon({ icon: Icon, title, line, phase }: { icon: LucideIcon; title: string; line: string; phase: number }) {
  const { m } = useI18n()
  return (
    <div className="mx-auto flex w-full max-w-[1240px] flex-col gap-5 px-4 pt-6 pb-10 sm:px-8">
      <h1 className="text-xl font-semibold tracking-[-0.015em]">{title}</h1>
      <section className="flex flex-col items-center gap-3 rounded-[10px] border border-border bg-card px-6 py-16 text-center shadow-[0_1px_2px_rgba(28,27,25,.04)]">
        <div className="flex size-10 items-center justify-center rounded-full bg-secondary text-muted-foreground">
          <Icon className="size-5" strokeWidth={1.75} aria-hidden />
        </div>
        <p className="text-sm font-semibold">{m.empty.arrivesIn(phase)}</p>
        <p className="max-w-sm text-[13px] text-muted-foreground">{line}</p>
      </section>
    </div>
  )
}
