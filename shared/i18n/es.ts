import type { Messages } from './en'

// Neutral Latin American Spanish. Needs a read-through by a native speaker (DECISIONS.md).
export const es: Messages = {
  nav: {
    main: 'Principal',
    account: 'Cuenta',
    dashboard: 'Panel',
    orders: 'Pedidos',
    customers: 'Clientes',
    artwork: 'Diseños',
    purchaseOrders: 'Órdenes de compra',
    production: 'Producción',
    settings: 'Configuración',
  },
  shell: {
    searchPlaceholder: 'Buscar pedidos, clientes, números de orden',
    search: 'Buscar',
    newOrder: 'Nuevo pedido',
    notifications: 'Notificaciones',
    menu: 'Menú',
    close: 'Cerrar',
    owner: 'Propietario',
    language: 'Idioma',
    languageName: { en: 'English', es: 'Español' },
    languageShort: { en: 'EN', es: 'ES' },
  },
  palette: {
    title: 'Paleta de comandos',
    placeholder: 'Escribe un comando o un número de pedido',
    goTo: 'Ir a',
    openOrder: (n) => `Abrir pedido ${n}`,
    noResults: 'Sin resultados.',
  },
  empty: {
    arrivesIn: (phase) => `Llega en la Fase ${phase}`,
    dashboard: 'Las cifras de hoy y lo que requiere atención.',
    orders: 'Todos los pedidos, con su estado y filtros.',
    order: 'Artículos, diseño, cotización, orden de compra, producción y actividad de un pedido.',
    customers: 'Distritos, organizaciones y las personas con las que trabajas.',
    artwork: 'Diseños subidos, versiones y aprobaciones.',
    purchaseOrders: 'Órdenes de compra pendientes de revisión y aprobación.',
    production: 'La cola de producción por etapa.',
    settings: 'Datos del taller, usuarios y preferencias.',
  },
  settings: {
    languageHelp: 'Se aplica a este dispositivo.',
  },
  time: {
    overdueDays: (n) => `Atrasado ${n} ${n === 1 ? 'día' : 'días'}`,
  },
  labels: {
    role: { owner: 'Propietario', staff: 'Personal' },
    customerKind: { district: 'Distrito escolar', organization: 'Organización', individual: 'Particular' },
    orderSource: { phone: 'Teléfono', email: 'Correo', portal: 'Sitio web' },
    orderState: { active: 'Activo', completed: 'Completado', cancelled: 'Cancelado' },
    method: {
      screen: 'Serigrafía', embroidery: 'Bordado', dtg: 'DTG', laser_engrave: 'Grabado láser', laser_cut: 'Corte láser', other: 'Otro',
    },
    artworkStatus: { none: 'Sin diseño', pending: 'Pendiente de aprobación', approved: 'Aprobado', changes_requested: 'Cambios solicitados' },
    approvalStatus: { pending: 'Pendiente', approved: 'Aprobado', changes_requested: 'Cambios solicitados' },
    estimateStatus: { draft: 'Borrador', sent: 'Enviada', accepted: 'Aceptada', declined: 'Rechazada' },
    poStatus: {
      requested: 'Solicitada', received: 'Recibida', under_review: 'En revisión', approved: 'Aprobada', rejected: 'Rechazada', correction_required: 'Requiere corrección',
    },
    productionStatus: {
      awaiting_authorization: 'Esperando autorización', awaiting_artwork: 'Esperando diseño', ready: 'Listo', in_production: 'En producción',
      quality_control: 'Control de calidad', ready_for_pickup: 'Listo para recoger', completed: 'Completado',
    },
    inquiryStatus: { new: 'Nueva', converted: 'Convertida', spam: 'Spam' },
  },
}
