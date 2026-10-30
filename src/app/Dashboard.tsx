import { Route, Routes, useParams } from 'react-router'
import { ClipboardList, FileCheck, Image, Layers, LayoutDashboard, Users } from 'lucide-react'
import { useI18n } from '@/i18n'
import AppShell from './AppShell'
import ComingSoon from './ComingSoon'
import SettingsPage from './SettingsPage'

function OrderPage() {
  const { number } = useParams()
  const { m } = useI18n()
  return <ComingSoon icon={ClipboardList} title={number ?? m.nav.orders} line={m.empty.order} phase={1} />
}

// Routes under /app. 1.7b replaces the first three placeholders.
export default function Dashboard() {
  const { m } = useI18n()
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<ComingSoon icon={LayoutDashboard} title={m.nav.dashboard} line={m.empty.dashboard} phase={1} />} />
        <Route path="orders" element={<ComingSoon icon={ClipboardList} title={m.nav.orders} line={m.empty.orders} phase={1} />} />
        <Route path="orders/:number" element={<OrderPage />} />
        <Route path="customers" element={<ComingSoon icon={Users} title={m.nav.customers} line={m.empty.customers} phase={2} />} />
        <Route path="artwork" element={<ComingSoon icon={Image} title={m.nav.artwork} line={m.empty.artwork} phase={3} />} />
        <Route path="purchase-orders" element={<ComingSoon icon={FileCheck} title={m.nav.purchaseOrders} line={m.empty.purchaseOrders} phase={3} />} />
        <Route path="production" element={<ComingSoon icon={Layers} title={m.nav.production} line={m.empty.production} phase={5} />} />
        <Route path="settings" element={<SettingsPage />} />
      </Route>
    </Routes>
  )
}
