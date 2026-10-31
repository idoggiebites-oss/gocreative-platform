import { Route, Routes } from 'react-router'
import { FileCheck, Image } from 'lucide-react'
import { useI18n } from '@/i18n'
import AppShell from './AppShell'
import ComingSoon from './ComingSoon'
import CustomerDetail from './CustomerDetail'
import CustomerList from './CustomerList'
import NewOrder from './NewOrder'
import OrderDetail from './OrderDetail'
import OrderList from './OrderList'
import Overview from './Overview'
import PaymentsPage from './PaymentsPage'
import Production from './Production'
import SettingsPage from './SettingsPage'

// Routes under /app.
export default function Dashboard() {
  const { m } = useI18n()
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<Overview />} />
        <Route path="orders" element={<OrderList />} />
        <Route path="orders/new" element={<NewOrder />} />
        <Route path="orders/:number" element={<OrderDetail />} />
        <Route path="customers" element={<CustomerList />} />
        <Route path="customers/:id" element={<CustomerDetail />} />
        <Route path="artwork" element={<ComingSoon icon={Image} title={m.nav.artwork} line={m.empty.artwork} phase={3} />} />
        <Route path="purchase-orders" element={<ComingSoon icon={FileCheck} title={m.nav.purchaseOrders} line={m.empty.purchaseOrders} phase={3} />} />
        <Route path="production" element={<Production />} />
        <Route path="payments" element={<PaymentsPage />} />
        <Route path="settings" element={<SettingsPage />} />
      </Route>
    </Routes>
  )
}
