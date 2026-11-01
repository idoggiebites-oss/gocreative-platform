import { lazy, Suspense } from 'react'
import { Link, Navigate, Route, Routes } from 'react-router'
import '@fontsource-variable/bricolage-grotesque'
import '@fontsource-variable/figtree'
import { business } from '@shared/business'
import './store.css'
import HomePage from './HomePage'
import ServicesPage from './ServicesPage'
import StoreLayout, { usePageTitle } from './StoreLayout'
import PrivacyPage from './PrivacyPage'

const OrderPage = lazy(() => import('./OrderPage'))
const SentPage = lazy(() => import('./SentPage'))

function NotFound() {
  usePageTitle('Page not found')
  return (
    <main className="s-wrap s-prose">
      <h1 tabIndex={-1} className="s-display s-h-page">We could not find that page.</h1>
      <p><Link to="/" viewTransition>Back to home</Link></p>
    </main>
  )
}

export default function Store() {
  if (!business.modules.storefront) return <Navigate to="/app" replace />
  return (
    <Routes>
      <Route element={<StoreLayout />}>
        <Route index element={<HomePage />} />
        <Route path="services" element={<ServicesPage />} />
        <Route path="privacy" element={<PrivacyPage />} />
        <Route path="order" element={<Suspense fallback={<div className="s-order-loading" role="status">Loading the form</div>}><OrderPage /></Suspense>} />
        <Route path="order/sent/:ref" element={<Suspense fallback={<div className="s-order-loading" role="status">Loading</div>}><SentPage /></Suspense>} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  )
}
