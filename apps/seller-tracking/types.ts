
export type PageView = 'dashboard' | 'monitoring-panel' | 'orders' | 'monitored-orders' | 'upload' | 'alerts' | 'delivery-failures' | 'admin' | 'no-movement' | 'latest-updates';

export enum OrderStatus {
  PENDING = 'PENDING', // Importado, aguardando info
  CREATED = 'CREATED', // Criado na transportadora
  SHIPPED = 'SHIPPED', // Em trânsito
  DELIVERY_ATTEMPT = 'DELIVERY_ATTEMPT', // Saiu para entrega
  DELIVERED = 'DELIVERED', // Entregue
  FAILURE = 'FAILURE', // Falha
  RETURNED = 'RETURNED', // Devolvido
  CANCELED = 'CANCELED', // Cancelado
  CHANNEL_LOGISTICS = 'CHANNEL_LOGISTICS' // Logistica do Canal (Shopee/ME2)
}

export interface TrackingEvent {
  status: string;
  description: string;
  date: Date;
  city?: string;
  state?: string;
}

export interface SyncLogEntry {
  timestamp: string;
  level: "info" | "success" | "error";
  message: string;
}

export interface SyncJobStatus {
  jobId: string;
  companyId: string;
  userId: string;
  status: "running" | "completed" | "failed" | "canceled";
  total: number;
  processed: number;
  success: number;
  failed: number;
  currentOrderNumber: string | null;
  startedAt: string;
  finishedAt: string | null;
  lastUpdatedAt: string;
  error: string | null;
  cancelRequested?: boolean;
  warnings: string[];
  logs: SyncLogEntry[];
}

export interface SyncScheduleStatus {
  enabled: boolean;
  intervalMs: number;
  nextScheduledAt: string | null;
}

export interface TrayIntegrationStatus {
  authorized: boolean;
  status: "online" | "offline";
  storeId: string | null;
  storeName: string | null;
  updatedAt: string | null;
  message: string;
}

export interface TraySyncFilters {
  days: 7 | 15 | 30 | 60 | 90;
  statusMode: "all_except_canceled" | "selected";
  statuses: string[];
}

export type NotificationCategory = "GENERAL" | "MONITORED";

export interface AppNotification {
  id: string;
  category: NotificationCategory;
  type: string;
  title: string;
  message: string;
  createdAt: string;
  readAt?: string | null;
  reportId?: string | null;
  reportUrl?: string | null;
  csvUrl?: string | null;
  deliveredCount?: number;
  enteredDelayCount?: number;
  enteredFailureCount?: number;
  orderId?: string | null;
  orderNumber?: string | null;
  previousStatus?: string | null;
  currentStatus?: string | null;
}

export interface IntegrationOrderStatusOption {
  value: string;
  label: string;
  code?: number | null;
  category?: string | null;
}

export interface Order {
  // Identification
  id: string; // Internal ID or mapped from 'Pedido'
  orderNumber: string; // 'Pedido'
  invoiceNumber?: string | null;
  invoiceAccessKey?: string | null;
  invoiceXmlUrl?: string | null;
  trackingCode?: string; // 'Código de rastreio'
  trackingUrl?: string | null;
  trackingSourceLabel?: string | null;
  
  // Customer
  customerName: string; // 'Nome do Cliente'
  corporateName?: string; // 'Razão Social'
  cpf?: string; // 'CPF'
  cnpj?: string; // 'CNPJ'
  phone?: string; // 'Telefone'
  mobile?: string; // 'Celular'
  
  // Logistics
  salesChannel: string; // 'Canal de venda'
  freightType: string; // 'Frete tipo' (Transportadora) - Updated by API
  freightValue: number; // 'Frete valor'
  quotedFreightValue?: number | null;
  quotedFreightDate?: Date | string | null;
  quotedFreightDetails?: any;
  originalQuotedFreightValue?: number | null;
  originalQuotedFreightDate?: Date | string | null;
  originalQuotedFreightDetails?: any;
  originalQuotedFreightQuotationId?: string | null;
  originalQuotedCarrierName?: string | null;
  recalculatedFreightValue?: number | null;
  recalculatedFreightDate?: Date | string | null;
  recalculatedFreightDetails?: any;
  recalculatedQuotedCarrierName?: string | null;
  quotedCarrierName?: string | null;
  freightCarrierMatchesQuote?: boolean | null;
  freightCarrierMatchesOriginalQuote?: boolean | null;
  freightCarrierMatchesRecalculatedQuote?: boolean | null;
  shippingDate: Date; // 'Envio data'
  platformCreatedAt?: Date | string | null; // Data de criacao no marketplace/plataforma
  
  // Address
  address: string; // 'Endereço'
  number: string; // 'Número'
  complement?: string; // 'Complemento'
  neighborhood: string; // 'Bairro'
  city: string; // 'Cidade'
  state: string; // 'Estado'
  zipCode: string; // 'Cep'
  
  // Financial
  totalValue: number; // 'Total'
  
  // Delivery Constraints
  recipient?: string; // 'Destinatário'
  maxShippingDeadline: Date | null; // 'Prazo máximo de envio'
  estimatedDeliveryDate: Date | null; // 'Data estimada de entrega'
  carrierEstimatedDeliveryDate?: Date | null; // 'Previsão transportadora'
  
  // Tracking State (Mutable)
  status: OrderStatus;
  manualCustomStatus?: string | null;
  observation?: string | null;
  isArchived?: boolean;
  archivedAt?: Date | string | null;
  isDelayed: boolean; // Atraso pela previsao da transportadora
  isPlatformDelayed?: boolean; // Atraso pela previsao original do pedido
  trackingHistory: TrackingEvent[];
  lastApiSync: Date | null;
  lastUpdate: Date;
}

export interface ReleaseNoteSummary {
  id: string;
  version: string;
  title: string;
  summary: string;
  newFeatures: string[];
  adjustments: string[];
  recipientCount: number;
  createdAt: string;
  featureCount: number;
  adjustmentCount: number;
}

export interface ReleaseNoteDetail extends ReleaseNoteSummary {
  htmlContent: string;
}

export interface NotificationItem {
  id: string;
  category: "GENERAL" | "MONITORED";
  type: string;
  title: string;
  message: string;
  createdAt: string;
  readAt?: string | null;
  reportId?: string | null;
  reportUrl?: string | null;
  csvUrl?: string | null;
  deliveredCount?: number;
  enteredDelayCount?: number;
  enteredFailureCount?: number;
  orderId?: string | null;
  orderNumber?: string | null;
  previousStatus?: string | null;
  currentStatus?: string | null;
}

export interface MonitoredOrderItem {
  id: string;
  orderId: string;
  orderNumber: string;
  invoiceNumber: string | null;
  status: string;
  statusLabel: string;
  lastUpdate: string;
  createdAt: string;
}
