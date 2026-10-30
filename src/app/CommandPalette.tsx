import { useState } from 'react'
import { useNavigate } from 'react-router'
import { CornerDownLeft } from 'lucide-react'
import { Command, CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { useI18n } from '@/i18n'
import { SECTIONS } from './sections'

const ORDER_NUMBER = /^\d{4}-\d{4}$/

export default function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { m } = useI18n()
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const typed = query.trim()

  const go = (to: string) => {
    onOpenChange(false)
    setQuery('')
    void navigate(to)
  }

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} title={m.palette.title} description={m.palette.placeholder}>
      <Command>
        <CommandInput value={query} onValueChange={setQuery} placeholder={m.palette.placeholder} />
        <CommandList>
          <CommandEmpty>{m.palette.noResults}</CommandEmpty>
          {ORDER_NUMBER.test(typed) && (
            <CommandGroup>
              <CommandItem value={`open-order ${typed}`} onSelect={() => go(`/app/orders/${typed}`)}>
                <CornerDownLeft aria-hidden />
                {m.palette.openOrder(typed)}
              </CommandItem>
            </CommandGroup>
          )}
          <CommandGroup heading={m.palette.goTo}>
            {SECTIONS.map((s) => (
              <CommandItem key={s.key} value={m.nav[s.key]} onSelect={() => go(s.to)}>
                <s.icon aria-hidden />
                {m.nav[s.key]}
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      </Command>
    </CommandDialog>
  )
}
