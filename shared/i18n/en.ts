import type {
  ApprovalStatus, ArtworkStatus, CustomerKind, EstimateStatus, InquiryStatus, Method,
  OrderSource, OrderState, PoStatus, ProductionStatus, Role,
} from '../enums'

export type Lang = 'en' | 'es'

// Source of truth for copy. es.ts is typed `Messages`, so a missing key or a
// wrong function signature fails tsc.
export const en = {
  nav: {
    main: 'Main',
    account: 'Account',
    dashboard: 'Dashboard',
    orders: 'Orders',
    customers: 'Customers',
    artwork: 'Artwork',
    purchaseOrders: 'Purchase orders',
    production: 'Production',
    settings: 'Settings',
  },
  shell: {
    searchPlaceholder: 'Search orders, customers, PO numbers',
    search: 'Search',
    newOrder: 'New order',
    notifications: 'Notifications',
    menu: 'Menu',
    close: 'Close',
    owner: 'Owner',
    language: 'Language',
    languageName: { en: 'English', es: 'Español' } satisfies Record<Lang, string>,
    languageShort: { en: 'EN', es: 'ES' } satisfies Record<Lang, string>,
  },
  palette: {
    title: 'Command palette',
    placeholder: 'Type a command or an order number',
    goTo: 'Go to',
    openOrder: (n: string) => `Open order ${n}`,
    noResults: 'No results.',
  },
  empty: {
    arrivesIn: (phase: number) => `Arrives in Phase ${phase}`,
    dashboard: 'Today’s numbers and what needs attention.',
    orders: 'Every order, with status tracks and filters.',
    order: 'One order’s items, artwork, quote, PO, production and activity.',
    customers: 'Districts, organizations and the people you work with.',
    artwork: 'Uploaded artwork, versions and approvals.',
    purchaseOrders: 'Purchase orders waiting for review and approval.',
    production: 'The production queue by stage.',
    settings: 'Shop details, users and preferences.',
  },
  settings: {
    languageHelp: 'Applies to this device.',
  },
  time: {
    overdueDays: (n: number) => `Overdue ${n} ${n === 1 ? 'day' : 'days'}`,
  },
  labels: {
    role: { owner: 'Owner', staff: 'Staff' } satisfies Record<Role, string>,
    customerKind: { district: 'School district', organization: 'Organization', individual: 'Individual' } satisfies Record<CustomerKind, string>,
    orderSource: { phone: 'Phone', email: 'Email', portal: 'Website' } satisfies Record<OrderSource, string>,
    orderState: { active: 'Active', completed: 'Completed', cancelled: 'Cancelled' } satisfies Record<OrderState, string>,
    method: {
      screen: 'Screen print', embroidery: 'Embroidery', dtg: 'DTG', laser_engrave: 'Laser engraving', laser_cut: 'Laser cutting', other: 'Other',
    } satisfies Record<Method, string>,
    artworkStatus: { none: 'No artwork', pending: 'Pending approval', approved: 'Approved', changes_requested: 'Changes requested' } satisfies Record<ArtworkStatus, string>,
    approvalStatus: { pending: 'Pending', approved: 'Approved', changes_requested: 'Changes requested' } satisfies Record<ApprovalStatus, string>,
    estimateStatus: { draft: 'Draft', sent: 'Sent', accepted: 'Accepted', declined: 'Declined' } satisfies Record<EstimateStatus, string>,
    poStatus: {
      requested: 'Requested', received: 'Received', under_review: 'Under review', approved: 'Approved', rejected: 'Rejected', correction_required: 'Correction required',
    } satisfies Record<PoStatus, string>,
    productionStatus: {
      awaiting_authorization: 'Awaiting authorization', awaiting_artwork: 'Awaiting artwork', ready: 'Ready', in_production: 'In production',
      quality_control: 'Quality control', ready_for_pickup: 'Ready for pickup', completed: 'Completed',
    } satisfies Record<ProductionStatus, string>,
    inquiryStatus: { new: 'New', converted: 'Converted', spam: 'Spam' } satisfies Record<InquiryStatus, string>,
  },
}

type Widen<T> = T extends string
  ? string
  : T extends (...a: infer A) => string
    ? (...a: A) => string
    : { [K in keyof T]: Widen<T[K]> }

export type Messages = Widen<typeof en>
