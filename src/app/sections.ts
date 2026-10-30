import { ClipboardList, FileCheck, Image, Layers, LayoutDashboard, SlidersHorizontal, Users, type LucideIcon } from 'lucide-react'
import type { Messages } from '@shared/i18n/en'

export type SectionKey = Exclude<keyof Messages['nav'], 'main' | 'account'>

export const SECTIONS: { key: SectionKey; to: string; icon: LucideIcon }[] = [
  { key: 'dashboard', to: '/app', icon: LayoutDashboard },
  { key: 'orders', to: '/app/orders', icon: ClipboardList },
  { key: 'customers', to: '/app/customers', icon: Users },
  { key: 'artwork', to: '/app/artwork', icon: Image },
  { key: 'purchaseOrders', to: '/app/purchase-orders', icon: FileCheck },
  { key: 'production', to: '/app/production', icon: Layers },
  { key: 'settings', to: '/app/settings', icon: SlidersHorizontal },
]
