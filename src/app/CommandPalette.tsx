import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { ClipboardList, CornerDownLeft, Plus, UserPlus, Users } from 'lucide-react'
import { Command, CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { useI18n } from '@/i18n'
import { useCustomers, useOrders } from '@/lib/api'
import { SECTIONS } from './sections'

const ORDER_NUMBER = /^\d{4}-\d{4}$/

export default function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { m } = useI18n()
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const typed = query.trim()
  // Search as you type (debounced) over the same list endpoints the pages use; only while the palette is open.
  const [term, setTerm] = useState('')
  useEffect(() => {
    const t = setTimeout(() => setTerm(typed.length >= 2 ? typed : ''), 200)
    return () => clearTimeout(t)
  }, [typed])
  const customers = useCustomers(term, '', open && term !== '')
  const orders = useOrders('active', open ? term : '')
  const foundCustomers = term ? (customers.data?.rows ?? []).slice(0, 5) : []
  const foundOrders = term && orders.data?.view !== 'inquiries' ? (orders.data?.rows ?? []).slice(0, 5) : []

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
          <CommandGroup heading={m.palette.actions}>
            <CommandItem value={`action new order ${m.shell.newOrder}`} onSelect={() => go('/app/orders/new')}><Plus aria-hidden />{m.shell.newOrder}</CommandItem>
            <CommandItem value={`action new customer ${m.palette.newCustomer}`} onSelect={() => go('/app/customers?new=1')}><UserPlus aria-hidden />{m.palette.newCustomer}</CommandItem>
          </CommandGroup>
          {foundCustomers.length > 0 && (
            <CommandGroup heading={m.nav.customers}>
              {foundCustomers.map((c) => (
                <CommandItem key={c.id} value={`customer ${c.id} ${c.name} ${typed}`} onSelect={() => go(`/app/customers/${c.id}`)}><Users aria-hidden />{c.name}</CommandItem>
              ))}
            </CommandGroup>
          )}
          {foundOrders.length > 0 && (
            <CommandGroup heading={m.nav.orders}>
              {foundOrders.map((o) => (
                <CommandItem key={o.number} value={`order ${o.number} ${o.title} ${typed}`} onSelect={() => go(`/app/orders/${o.number}`)}>
                  <ClipboardList aria-hidden /><span className="num">{o.number}</span><span className="truncate text-muted-foreground">{o.customerName} · {o.title}</span>
                </CommandItem>
              ))}
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
