import { Request, Response } from 'express';
import { OrderStatus } from '../types/orderStatus';
import { syncJobService } from '../services/syncJobService';
import { TrackingService } from '../services/trackingService';
import { importOrdersForCompany } from '../services/orderImportService';
import { correiosTrackingService } from '../services/correiosTrackingService';
import { matchSswTrackingToOrder, sswTrackingService } from '../services/sswTrackingService';
import { syncReportService } from '../services/syncReportService';
import { notificationService } from '../services/notificationService';
import { isDemoCompanyById } from '../services/demoCompanyService';
import { toUserFacingDatabaseErrorMessage } from '../utils/prismaError';
import { resolvePlatformCreatedDate } from '../utils/orderDates';
import {
  deleteMonitoredOrderByCompanyAndOrder,
  deleteOrdersByCompany,
  deleteOrdersByCompanyAndStatus,
  deleteOrdersByIds,
  findActiveOrderByIdentifier,
  findLatestOrderByNumberForCompany,
  findTrayCheckoutQuoteByQuotationId,
  getCompanyBasicById,
  getCompanyTrackingSettings,
  getOrderById as getOrderByIdFromDb,
  listCompanyCustomOrderStatuses,
  listOrderCleanupBatch,
  listOrdersForCompany,
  listTrayCheckoutQuotesByQuotationIds,
  markOrderDeliveredManuallyById,
  updateOrderArchivedStateById,
  updateOrderFreightTypeById,
  updateOrderManualFieldsById,
  upsertCompanyCustomOrderStatus,
} from '../lib/orderDb';
const trackingService = new TrackingService();
const DEMO_SYNC_DISABLED_MESSAGE =
  'Sincronizacao desabilitada para empresa demonstrativa.';
const NON_ADMIN_MANUAL_GENERAL_SYNC_LIMIT_MESSAGE =
  'Sincronizacao geral de rastreio limitada a 1 execucao simultanea para usuarios nao administradores.';

const isAdminUser = (user: any) =>
  String(user?.role || '')
    .trim()
    .toUpperCase() === 'ADMIN';

const hasReachedManualGeneralSyncLimit = (user: any) =>
  !isAdminUser(user) && syncJobService.getRunningJobsCount() >= 1;

const safeString = (value: any): string | null => {
  if (value === null || value === undefined || value === '') return null;
  return String(value).trim();
};

const resolveJetOrderId = (order: { apiRawPayload?: any }) => {
  const rawPayload = order.apiRawPayload;
  if (!rawPayload || typeof rawPayload !== 'object') return null;

  return (
    safeString(rawPayload.jetOrderId) ||
    safeString(rawPayload.jetMeta?.idOrder) ||
    safeString(rawPayload.jetMeta?.jetOrderId) ||
    null
  );
};

type ArchivedFilterMode = 'exclude' | 'only' | 'include';

const resolveArchivedFilterMode = (value: unknown): ArchivedFilterMode => {
  const normalized = String(value || '').trim().toLowerCase();

  if (normalized === 'only' || normalized === 'archived') {
    return 'only';
  }

  if (normalized === 'include' || normalized === 'all') {
    return 'include';
  }

  return 'exclude';
};

const safeDate = (value: any): Date | null => {
  if (!value) return null;

  try {
    const date = new Date(value);
    const year = date.getFullYear();
    if (Number.isNaN(year) || year < 1900 || year > 2100) {
      return null;
    }
    return date;
  } catch {
    return null;
  }
};

const splitDocumentFields = (value: unknown) => {
  const normalized = normalizeDigits(value);
  if (!normalized) {
    return {
      cpf: null as string | null,
      cnpj: null as string | null,
    };
  }

  if (normalized.length === 14) {
    return {
      cpf: null,
      cnpj: normalized,
    };
  }

  return {
    cpf: normalized,
    cnpj: null,
  };
};

const mapTrackingEventsToHistory = (trackingEvents: any[] | undefined) => {
  if (!Array.isArray(trackingEvents)) return [];

  return trackingEvents.map((event) => ({
    status: safeString(event.status) || 'UNKNOWN',
    description: safeString(event.description) || 'Evento de rastreamento',
    date: safeDate(event.eventDate) || new Date(),
    city: safeString(event.city) || '',
    state: safeString(event.state) || '',
  }));
};

const normalizeEventLocation = (value: unknown) =>
  String(value || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[.;:,]+$/g, '')
    .trim();

const extractEventLocationFromText = (text: unknown) => {
  const normalizedText = normalizeEventLocation(text);
  if (!normalizedText) {
    return { city: null as string | null, state: null as string | null };
  }

  const slashMatch = normalizedText.match(
    /\b([A-ZÀ-Ú0-9' -]+)\s*\/\s*([A-Z]{2})\b/i,
  );
  if (slashMatch?.[1]) {
    return {
      city: normalizeEventLocation(slashMatch[1]),
      state: normalizeEventLocation(slashMatch[2]).slice(0, 2).toUpperCase(),
    };
  }

  const patterns = [
    /na cidade de\s+([A-ZÀ-Ú0-9' -]+?)(?:\s+em\b|[.;]|$)/i,
    /cidade de\s+([A-ZÀ-Ú0-9' -]+?)(?:\s+em\b|[.;]|$)/i,
    /na unidade\s+([A-ZÀ-Ú0-9' -]+?)(?:\s+em\b|[.;]|$)/i,
    /da unidade\s+([A-ZÀ-Ú0-9' -]+?)(?:\s+em\b|[.;]|$)/i,
    /unidade\s+([A-ZÀ-Ú0-9' -]+?)(?:\s+em\b|[.;]|$)/i,
  ];

  for (const pattern of patterns) {
    const match = normalizedText.match(pattern);
    if (match?.[1]) {
      return {
        city: normalizeEventLocation(match[1]),
        state: null,
      };
    }
  }

  return { city: null, state: null };
};

const parseCarrierForecastFromTrackingText = (text: string | null | undefined) => {
  const normalizedText = String(text || '').trim();
  if (!normalizedText) return null;

  const match = normalizedText.match(
    /previs[aã]o\s+de\s+entrega\s*:\s*(\d{2})\/(\d{2})\/(\d{2,4})/i,
  );

  if (!match) {
    return null;
  }

  const day = Number(match[1]);
  const month = Number(match[2]) - 1;
  const rawYear = Number(match[3]);
  const year = rawYear < 100 ? 2000 + rawYear : rawYear;
  const parsedDate = new Date(year, month, day);

  if (Number.isNaN(parsedDate.getTime())) {
    return null;
  }

  parsedDate.setHours(23, 59, 59, 999);
  return parsedDate;
};

const isActiveDelayedByDate = (
  status: OrderStatus,
  targetDate: Date | null | undefined,
) => {
  if (!targetDate) return false;

  const closedStatuses: OrderStatus[] = [
    OrderStatus.DELIVERED,
    OrderStatus.FAILURE,
    OrderStatus.RETURNED,
    OrderStatus.CANCELED,
    OrderStatus.CHANNEL_LOGISTICS,
  ];

  return !closedStatuses.includes(status) && new Date() > targetDate;
};

const resolveCarrierEstimatedDateFromTrackingEvents = (trackingEvents: any[] | undefined) => {
  if (!Array.isArray(trackingEvents)) return null;

  const orderedEvents = [...trackingEvents].sort((left, right) => {
    const leftDate = safeDate(left?.eventDate)?.getTime() || 0;
    const rightDate = safeDate(right?.eventDate)?.getTime() || 0;
    return rightDate - leftDate;
  });

  for (const event of orderedEvents) {
    const parsedDate = parseCarrierForecastFromTrackingText(event?.description);
    if (parsedDate) {
      return parsedDate;
    }
  }

  return null;
};

const getMovementDate = (order: any) => {
  const latestTrackingEvent = Array.isArray(order.trackingEvents)
    ? order.trackingEvents[0]
    : null;

  return (
    latestTrackingEvent?.eventDate ||
    order.shippingDate ||
    resolvePlatformCreatedDate(order) ||
    order.lastUpdate
  );
};

const normalizeDigits = (value: unknown) =>
  String(value || '')
    .replace(/\D/g, '')
    .trim();

const normalizeAlphaNumeric = (value: unknown) =>
  String(value || '')
    .replace(/[^A-Za-z0-9]/g, '')
    .toUpperCase()
    .trim();

const normalizeComparableText = (value: unknown) =>
  String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();

const isXmlTrackingKey = (value: unknown) => {
  const normalized = normalizeAlphaNumeric(value);
  if (!normalized) return false;
  if (/^\d{44}$/.test(normalized)) return true;
  return normalized.length >= 20 && /[A-Z]/.test(normalized) && /\d/.test(normalized);
};

const looksLikeCorreiosObjectCode = (value: unknown) =>
  /^[A-Z]{2}\d{9}[A-Z]{2}$/.test(normalizeAlphaNumeric(value));

const shouldExcludeOrderFromPlatform = (_order: any) => false;

const buildSswTrackingUrl = (identifier: string, cnpj?: string | null) =>
  cnpj
    ? `https://ssw.inf.br/app/tracking/${cnpj}/${identifier}`
    : `https://ssw.inf.br/app/tracking/${identifier}`;

const buildIntelipostTrackingUrl = (
  intelipostClientId: string | null | undefined,
  orderNumber: string | null | undefined,
) => {
  const normalizedClientId = normalizeDigits(intelipostClientId);
  const normalizedOrderNumber = safeString(orderNumber);

  if (!normalizedClientId || !normalizedOrderNumber) {
    return null;
  }

  return `https://status.ondeestameupedido.com/tracking/${normalizedClientId}/${encodeURIComponent(normalizedOrderNumber)}`;
};

const buildCorreiosTrackingUrl = (trackingCode: string | null | undefined) =>
  correiosTrackingService.buildTrackingUrl(trackingCode);

const isCorreiosTrackingUrl = (value: string | null | undefined) =>
  /rastreamento\.correios\.com\.br/i.test(String(value || ''));

const getStoredTrackingUrl = (
  order: {
    invoiceNumber?: string | null;
    trackingCode?: string | null;
    freightType?: string | null;
    apiRawPayload?: any;
  },
) =>
  safeString(order.apiRawPayload?.manualTrackingUrl) ||
  safeString(order.apiRawPayload?.trackingUrl) ||
  safeString(order.apiRawPayload?.logistic_provider?.live_tracking_url) ||
  safeString(order.apiRawPayload?.tracking_url) ||
  null;

const hasIntelipostWebhookUpdate = (order: { apiRawPayload?: any }) =>
  Boolean(order.apiRawPayload?.intelipostWebhook);

const mergeApiRawPayload = (currentPayload: any, updates: Record<string, any>) => {
  const basePayload =
    currentPayload && typeof currentPayload === 'object' && !Array.isArray(currentPayload)
      ? { ...currentPayload }
      : {};

  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined) {
      continue;
    }

    if (value === null || value === '') {
      delete basePayload[key];
      continue;
    }

    basePayload[key] = value;
  }

  return Object.keys(basePayload).length > 0 ? basePayload : null;
};

const resolveTrackingSourceLabel = (
  order: {
    invoiceNumber?: string | null;
    trackingCode?: string | null;
    orderNumber?: string | null;
    freightType?: string | null;
    apiRawPayload?: any;
  },
  sswRequireCnpjs: string[] = [],
  intelipostClientId?: string | null,
  correiosIntegrationEnabled = true,
) => {
  const rawPayload = order.apiRawPayload;
  if (hasIntelipostWebhookUpdate(order)) {
    return 'Intelipost';
  }

  const source = safeString(rawPayload?.source)?.toUpperCase();
  const lookupMode = safeString(rawPayload?.lookupMode)?.toUpperCase();

  if (source === 'SSW') {
    if (lookupMode === 'TRACKING_CODE') {
      return 'SSW com codigo envio/NF';
    }

    if (lookupMode === 'XML_KEY') {
      return 'SSW com Codigo XML';
    }

    return 'SSW com NF';
  }

  if (
    correiosIntegrationEnabled &&
    (source === 'CORREIOS' ||
      correiosTrackingService.shouldUseForCarrier(order.freightType))
  ) {
    const correiosTrackingUrl = buildCorreiosTrackingUrl(order.trackingCode);
    if (correiosTrackingUrl) {
      return 'Correios';
    }
  }

  if (
    source === 'INTELIPOST' ||
    rawPayload?.tracking ||
    rawPayload?.logistic_provider
  ) {
    return 'Intelipost';
  }

  if (/ssw\.inf\.br/i.test(String(rawPayload?.trackingUrl || ''))) {
    if (lookupMode === 'TRACKING_CODE') {
      return 'SSW com codigo envio/NF';
    }
    if (lookupMode === 'XML_KEY') {
      return 'SSW com Codigo XML';
    }
    return 'SSW com NF';
  }

  const resolvedTrackingUrl = resolveOrderTrackingUrl(
    order,
    sswRequireCnpjs,
    intelipostClientId,
    correiosIntegrationEnabled,
  );

  if (/ssw\.inf\.br/i.test(String(resolvedTrackingUrl || ''))) {
    const normalizedInvoiceNumber = normalizeDigits(order.invoiceNumber);
    const normalizedTrackingCode = normalizeDigits(order.trackingCode);
    const normalizedTrackingKey = normalizeAlphaNumeric(order.trackingCode);

    if (!normalizedInvoiceNumber && normalizedTrackingKey && isXmlTrackingKey(normalizedTrackingKey)) {
      return 'SSW com Codigo XML';
    }

    if (!normalizedInvoiceNumber && normalizedTrackingCode) {
      return 'SSW com codigo envio/NF';
    }

    return 'SSW com NF';
  }

  if (
    /rastreamento\.correios\.com\.br/i.test(String(resolvedTrackingUrl || '')) &&
    buildCorreiosTrackingUrl(order.trackingCode)
  ) {
    return 'Correios';
  }

  if (
    /ondeestameupedido\.com/i.test(String(resolvedTrackingUrl || '')) &&
    buildIntelipostTrackingUrl(intelipostClientId, order.orderNumber)
  ) {
    return 'Intelipost';
  }

  return null;
};

const extractQuoteCarrierName = (quoteDetails: any): string | null => {
  if (!quoteDetails || typeof quoteDetails !== 'object') {
    return null;
  }

  const normalizeComparableText = (value: unknown) =>
    String(value || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, ' ')
      .trim();

  const isIntegratorLabel = (value: unknown) => {
    const normalized = normalizeComparableText(value);
    if (!normalized) return false;

    return [
      'INTELIPOST',
      'FRETE FACIL',
      'FRETEFACIL',
      'MELHOR ENVIO',
      'KANGU',
      'FRENET',
    ].some((token) => normalized === token || normalized.includes(token));
  };

  const isGenericServiceLabel = (value: unknown) => {
    const normalized = normalizeComparableText(value);
    if (!normalized) return false;

    return [
      'EMISSAO DE NOTA FISCAL',
      'EMISSAO NOTA FISCAL',
      'NOTA FISCAL',
      'DOCUMENTO FISCAL',
      'COTACAO DE FRETE',
      'FRETE',
    ].some((token) => normalized === token || normalized.includes(token));
  };

  const pickCarrierCandidate = (...candidates: unknown[]) => {
    for (const candidate of candidates) {
      const normalized = safeString(candidate);
      if (!normalized) continue;
      if (isIntegratorLabel(normalized)) continue;
      if (isGenericServiceLabel(normalized)) continue;
      return normalized;
    }

    return null;
  };

  return (
    (quoteDetails.matchedByCarrier ? safeString(quoteDetails.requestedCarrier) : null) ||
    pickCarrierCandidate(
      quoteDetails.selectedCarrierName,
      quoteDetails.selectedOption?.carrier_name,
      quoteDetails.selectedOption?.carrier,
      quoteDetails.selectedOption?.transportadora,
      quoteDetails.selectedOption?.shipping_company,
      quoteDetails.selectedOption?.delivery_method?.carrier_name,
      quoteDetails.selectedOption?.taxe?.name,
      quoteDetails.raw?.taxe?.name,
      quoteDetails.carrierName,
      quoteDetails.shipmentType,
      quoteDetails.selectedOption?.delivery_method?.name,
      quoteDetails.selectedServiceName,
      quoteDetails.raw?.service_name,
      quoteDetails.selectedOption?.service_name,
      quoteDetails.selectedOption?.service,
      quoteDetails.selectedOption?.identifier,
      quoteDetails.selectedOption?.name,
      quoteDetails.raw?.name,
      quoteDetails.serviceName,
      quoteDetails.serviceCode,
    ) ||
    null
  );
};

const extractOrderQuotationId = (order: any) =>
  safeString(order.originalQuotedFreightQuotationId) ||
  safeString(order.apiRawPayload?.id_quotation) ||
  safeString(order.apiRawPayload?.quotation_id) ||
  null;

const mergeQuoteDetails = (primary: any, fallback: any) => {
  if (!primary && !fallback) {
    return null;
  }

  if (!primary) {
    return fallback;
  }

  if (!fallback) {
    return primary;
  }

  return {
    ...fallback,
    ...primary,
    selectedOption: {
      ...(fallback?.selectedOption || {}),
      ...(primary?.selectedOption || {}),
    },
    raw: {
      ...(fallback?.raw || {}),
      ...(primary?.raw || {}),
    },
  };
};

const loadCheckoutQuotesMap = async (
  companyId: string | null | undefined,
  orders: any[],
) => {
  const quotationIds = Array.from(
    new Set(
      orders
        .map((order) => extractOrderQuotationId(order))
        .filter((value) => Boolean(value)),
    ),
  );

  if (!companyId || quotationIds.length === 0) {
    return new Map();
  }

  const rows = await listTrayCheckoutQuotesByQuotationIds(companyId, quotationIds).catch(
    () => [],
  );

  return new Map(rows.map((row) => [String(row.quotationId), row]));
};

const loadCheckoutQuoteForOrder = async (
  companyId: string | null | undefined,
  order: any,
) => {
  const quotationId = extractOrderQuotationId(order);

  if (!companyId || !quotationId) {
    return null;
  }

  return findTrayCheckoutQuoteByQuotationId(companyId, quotationId).catch(() => null);
};

const resolveOrderTrackingUrl = (
  order: {
    invoiceNumber?: string | null;
    trackingCode?: string | null;
    orderNumber?: string | null;
    freightType?: string | null;
    apiRawPayload?: any;
  },
  sswRequireCnpjs: string[] = [],
  intelipostClientId?: string | null,
  correiosIntegrationEnabled = true,
) => {
  const intelipostTrackingUrlForWebhookOrder = hasIntelipostWebhookUpdate(order)
    ? buildIntelipostTrackingUrl(intelipostClientId, order.orderNumber)
    : null;

  if (intelipostTrackingUrlForWebhookOrder) {
    return intelipostTrackingUrlForWebhookOrder;
  }

  const storedTrackingUrl = getStoredTrackingUrl(order);
  if (
    storedTrackingUrl &&
    (!isCorreiosTrackingUrl(storedTrackingUrl) || correiosIntegrationEnabled)
  ) {
    return storedTrackingUrl;
  }

  const invoiceIdentifier = normalizeDigits(order.invoiceNumber);
  const trackingDigits = normalizeDigits(order.trackingCode);
  const trackingKey = normalizeAlphaNumeric(order.trackingCode);

  if (invoiceIdentifier && sswRequireCnpjs.length > 0) {
    return buildSswTrackingUrl(invoiceIdentifier, sswRequireCnpjs[0]);
  }

  if (!invoiceIdentifier && trackingDigits && sswRequireCnpjs.length > 0) {
    return buildSswTrackingUrl(trackingDigits, sswRequireCnpjs[0]);
  }

  if (!invoiceIdentifier && trackingKey && isXmlTrackingKey(trackingKey)) {
    return buildSswTrackingUrl(trackingKey);
  }

  const correiosTrackingUrl =
    correiosIntegrationEnabled &&
    correiosTrackingService.shouldUseForCarrier(order.freightType)
    ? buildCorreiosTrackingUrl(order.trackingCode)
    : null;

  if (correiosTrackingUrl) {
    return correiosTrackingUrl;
  }

  const intelipostTrackingUrl =
    safeString(order.apiRawPayload?.source)?.toUpperCase() === 'INTELIPOST' ||
    order.apiRawPayload?.tracking ||
    order.apiRawPayload?.logistic_provider
      ? buildIntelipostTrackingUrl(intelipostClientId, order.orderNumber)
      : null;

  return intelipostTrackingUrl;
};

const resolveVerifiedOrderTrackingUrl = async (
  order: {
    invoiceNumber?: string | null;
    trackingCode?: string | null;
    orderNumber?: string | null;
    freightType?: string | null;
    apiRawPayload?: any;
    customerName?: string | null;
    cpf?: string | null;
    cnpj?: string | null;
    city?: string | null;
    state?: string | null;
    zipCode?: string | null;
  },
  sswRequireCnpjs: string[] = [],
  intelipostClientId?: string | null,
  correiosIntegrationEnabled = true,
) => {
  const intelipostTrackingUrlForWebhookOrder = hasIntelipostWebhookUpdate(order)
    ? buildIntelipostTrackingUrl(intelipostClientId, order.orderNumber)
    : null;

  if (intelipostTrackingUrlForWebhookOrder) {
    return intelipostTrackingUrlForWebhookOrder;
  }

  const storedTrackingUrl = getStoredTrackingUrl(order);
  const trackingSource = safeString(order.apiRawPayload?.source)?.toUpperCase();
  const storedUrlLooksLikeSsw = /ssw\.inf\.br/i.test(storedTrackingUrl || '');
  const canUseStoredTrackingUrl =
    storedTrackingUrl &&
    (!isCorreiosTrackingUrl(storedTrackingUrl) || correiosIntegrationEnabled)
      ? storedTrackingUrl
      : null;

  if (canUseStoredTrackingUrl && trackingSource !== 'SSW' && !storedUrlLooksLikeSsw) {
    return storedTrackingUrl;
  }

  const invoiceIdentifier = normalizeDigits(order.invoiceNumber);
  const trackingDigits = normalizeDigits(order.trackingCode);
  const trackingKey = normalizeAlphaNumeric(order.trackingCode);
  const shouldValidateAgainstOrder = Boolean(
    order.customerName || order.cpf || order.cnpj || order.city || order.state,
  );
  const standardCandidates = [
    invoiceIdentifier
      ? { identifier: invoiceIdentifier, lookupPriority: 2 }
      : null,
    trackingDigits && trackingDigits !== invoiceIdentifier
      ? { identifier: trackingDigits, lookupPriority: 1 }
      : null,
  ].filter(Boolean) as Array<{ identifier: string; lookupPriority: number }>;

  const acceptedSswUrls: Array<{
    score: number;
    lookupPriority: number;
    url: string;
  }> = [];

  for (const candidate of standardCandidates) {
    for (const cnpj of sswRequireCnpjs) {
      const result = await sswTrackingService.fetchTrackingByInvoice(
        cnpj,
        candidate.identifier,
      );

      if (!result) {
        continue;
      }

      if (!shouldValidateAgainstOrder) {
        return buildSswTrackingUrl(candidate.identifier, cnpj);
      }

      const match = matchSswTrackingToOrder(order, result);
      if (!match.isMatch) {
        continue;
      }

      acceptedSswUrls.push({
        score: match.score,
        lookupPriority: candidate.lookupPriority,
        url: buildSswTrackingUrl(candidate.identifier, cnpj),
      });
    }
  }

  if (acceptedSswUrls.length > 0) {
    acceptedSswUrls.sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return right.lookupPriority - left.lookupPriority;
    });
    return acceptedSswUrls[0].url;
  }

  if (!invoiceIdentifier && trackingKey && isXmlTrackingKey(trackingKey)) {
    const xmlResult = await sswTrackingService.fetchTrackingByKey(trackingKey);
    if (xmlResult) {
      const match = shouldValidateAgainstOrder
        ? matchSswTrackingToOrder(order, xmlResult)
        : null;
      if (!shouldValidateAgainstOrder || match?.isMatch) {
        return buildSswTrackingUrl(trackingKey);
      }
    }
  }

  const correiosTrackingUrl =
    correiosIntegrationEnabled &&
    correiosTrackingService.shouldUseForCarrier(order.freightType)
    ? buildCorreiosTrackingUrl(order.trackingCode)
    : null;

  if (correiosTrackingUrl) {
    return correiosTrackingUrl;
  }

  const intelipostTrackingUrl =
    safeString(order.apiRawPayload?.source)?.toUpperCase() === "INTELIPOST" ||
    order.apiRawPayload?.tracking ||
    order.apiRawPayload?.logistic_provider
      ? buildIntelipostTrackingUrl(intelipostClientId, order.orderNumber)
      : null;

  return (
    canUseStoredTrackingUrl ||
    safeString(order.apiRawPayload?.logistic_provider?.live_tracking_url) ||
    safeString(order.apiRawPayload?.tracking_url) ||
    intelipostTrackingUrl ||
    null
  );
};

const getCompanySswRequireCnpjs = async (companyId: string | null | undefined) => {
  const settings = await getCompanyTrackingSettings(companyId);
  if (!settings.sswRequireEnabled) {
    return [];
  }

  return Array.isArray(settings.sswRequireCnpjs)
    ? settings.sswRequireCnpjs
        .map((cnpj: unknown) => normalizeDigits(cnpj))
        .filter(Boolean)
    : [];
};

const getCompanyIntelipostClientId = async (
  companyId: string | null | undefined,
) => {
  const settings = await getCompanyTrackingSettings(companyId);
  if (!settings.intelipostIntegrationEnabled) {
    return null;
  }

  return safeString(settings.intelipostClientId);
};

const getCompanyCorreiosIntegrationEnabled = async (
  companyId: string | null | undefined,
) => {
  const settings = await getCompanyTrackingSettings(companyId);
  return settings.correiosIntegrationEnabled;
};

const mapIntelipostStatusToEnum = (status: string): OrderStatus => {
  const normalizedStatus = status ? status.toUpperCase() : '';

  if (
    normalizedStatus.includes('SAIU PARA ENTREGA') ||
    normalizedStatus.includes('DELIVERY_ATTEMPT') ||
    normalizedStatus.includes('TO_BE_DELIVERED')
  ) {
    return OrderStatus.DELIVERY_ATTEMPT;
  }
  if (
    normalizedStatus.includes('ENTREGUE') ||
    normalizedStatus.includes('DELIVERED')
  ) {
    return OrderStatus.DELIVERED;
  }
  if (
    normalizedStatus.includes('FALHA') ||
    normalizedStatus.includes('FAILURE') ||
    normalizedStatus.includes('SINISTR') ||
    normalizedStatus.includes('ROUBO') ||
    normalizedStatus.includes('AVARIA')
  ) {
    return OrderStatus.FAILURE;
  }
  if (normalizedStatus.includes('DEVOL') || normalizedStatus.includes('RETURN')) {
    return OrderStatus.RETURNED;
  }
  if (normalizedStatus.includes('CANCEL')) {
    return OrderStatus.CANCELED;
  }
  if (
    normalizedStatus.includes('SHIPPED') ||
    normalizedStatus.includes('TRANSIT') ||
    normalizedStatus.includes('EM TR')
  ) {
    return OrderStatus.SHIPPED;
  }
  if (
    normalizedStatus.includes('CRIADO') ||
    normalizedStatus.includes('CREATED') ||
    normalizedStatus.includes('NEW')
  ) {
    return OrderStatus.CREATED;
  }

  return OrderStatus.PENDING;
};

const buildExternalOrderResponse = (
  identifier: string,
  source: 'SSW' | 'INTELIPOST' | 'INTELIPOST_INVOICE_KEY' | 'CORREIOS',
  result: any,
  intelipostClientId?: string | null,
) => {
  if (source === 'SSW') {
    const events = Array.isArray(result.events) ? result.events : [];
    const orderedEvents = events
      .slice()
      .sort((left, right) => right.eventDate.getTime() - left.eventDate.getTime());
    const latestEvent = orderedEvents[0] || null;
    const lookupMode = safeString(result.lookupMode) || 'INVOICE';
    const recipientName =
      safeString(result.matchMetadata?.recipientName) ||
      safeString(result.matchMetadata?.deliveredToName) ||
      'Consulta externa';
    const recipientDocument =
      safeString(result.matchMetadata?.deliveredToDocument) ||
      safeString(result.matchMetadata?.recipientDocument);
    const documentFields = splitDocumentFields(recipientDocument);
    const trackingUrl = safeString(result.rawPayload?.trackingUrl);

    return {
      id: `external-${normalizeAlphaNumeric(identifier) || normalizeDigits(identifier) || Date.now()}` ,
      orderNumber: String(identifier),
      invoiceNumber: lookupMode === 'INVOICE' ? normalizeDigits(identifier) : null,
      trackingCode: lookupMode === 'XML_KEY' ? identifier : null,
      trackingUrl,
      trackingSourceLabel:
        lookupMode === 'XML_KEY'
          ? 'SSW com Codigo XML'
          : lookupMode === 'TRACKING_CODE'
            ? 'SSW com codigo envio/NF'
            : 'SSW com NF',
      customerName: recipientName,
      corporateName: null,
      cpf: documentFields.cpf,
      cnpj: documentFields.cnpj,
      phone: null,
      mobile: null,
      salesChannel: 'Externo',
      freightType: result.freightType || 'SSW',
      freightValue: 0,
      quotedFreightValue: null,
      quotedFreightDate: null,
      quotedFreightDetails: null,
      quotedCarrierName: null,
      freightCarrierMatchesQuote: null,
      shippingDate: latestEvent?.eventDate || new Date(),
      address: '',
      number: '',
      complement: null,
      neighborhood: '',
      city:
        safeString(result.matchMetadata?.destinationCity) ||
        latestEvent?.city ||
        '',
      state:
        safeString(result.matchMetadata?.destinationState) ||
        latestEvent?.state ||
        '',
      zipCode: '',
      totalValue: 0,
      recipient: recipientName,
      maxShippingDeadline: null,
      estimatedDeliveryDate: result.carrierEstimatedDate || null,
      carrierEstimatedDeliveryDate: result.carrierEstimatedDate || null,
      status: result.status as OrderStatus,
      isDelayed: false,
      trackingHistory: events.map((event: any) => ({
        status: safeString(event.status) || 'UNKNOWN',
        description: safeString(event.description) || 'Evento de rastreamento',
        date: safeDate(event.eventDate) || new Date(),
        city: safeString(event.city) || '',
        state: safeString(event.state) || '',
      })),
      lastApiSync: new Date(),
      lastUpdate: latestEvent?.eventDate || new Date(),
      apiRawPayload: {
        source: 'SSW',
        lookupMode,
        trackingUrl,
        matchMetadata: result.matchMetadata ?? null,
        rawPayload: result.rawPayload ?? null,
      },
    };
  }

  if (source === 'CORREIOS') {
    const events = Array.isArray(result.events) ? result.events : [];
    const latestEvent = events[0] || null;
    const trackingCode = normalizeAlphaNumeric(result.objectCode || identifier);
    const trackingUrl = buildCorreiosTrackingUrl(result.objectCode || identifier);

    return {
      id: `external-${normalizeAlphaNumeric(identifier) || Date.now()}`,
      orderNumber: String(identifier),
      invoiceNumber: null,
      trackingCode,
      trackingUrl,
      trackingSourceLabel: 'Correios',
      customerName: 'Consulta externa',
      corporateName: null,
      cpf: null,
      cnpj: null,
      phone: null,
      mobile: null,
      salesChannel: 'Externo',
      freightType: 'Correios',
      freightValue: 0,
      quotedFreightValue: null,
      quotedFreightDate: null,
      quotedFreightDetails: null,
      quotedCarrierName: null,
      freightCarrierMatchesQuote: null,
      shippingDate: latestEvent?.eventDate || new Date(),
      address: '',
      number: '',
      complement: null,
      neighborhood: '',
      city: safeString(latestEvent?.city) || '',
      state: safeString(latestEvent?.state) || '',
      zipCode: '',
      totalValue: 0,
      recipient: null,
      maxShippingDeadline: null,
      estimatedDeliveryDate: result.carrierEstimatedDate || null,
      carrierEstimatedDeliveryDate: result.carrierEstimatedDate || null,
      status: result.status as OrderStatus,
      isDelayed: false,
      trackingHistory: events.map((event: any) => ({
        status: safeString(event.status) || 'UNKNOWN',
        description: safeString(event.description) || 'Evento de rastreamento',
        date: safeDate(event.eventDate) || new Date(),
        city: safeString(event.city) || '',
        state: safeString(event.state) || '',
      })),
      lastApiSync: new Date(),
      lastUpdate: latestEvent?.eventDate || new Date(),
      apiRawPayload: {
        source: 'CORREIOS',
        trackingUrl,
        objectCode: trackingCode,
        rawPayload: result.rawPayload ?? null,
      },
    };
  }

  const trackingHistory = (result?.tracking?.history || []).map((historyItem: any) => {
    const description =
      historyItem.provider_message ||
      historyItem.status_label ||
      'Evento de rastreamento';
    const parsedLocation = extractEventLocationFromText(description);

    return {
      status: historyItem.macro_state?.code || 'UNKNOWN',
      description,
      date: safeDate(historyItem.event_date) || new Date(),
      city: parsedLocation.city || '',
      state: parsedLocation.state || '',
    };
  });

  const latestTrackingEvent =
    trackingHistory.length > 0
      ? trackingHistory.reduce((latest: any, current: any) =>
          new Date(latest.date).getTime() > new Date(current.date).getTime()
            ? latest
            : current,
        )
      : null;

  const status = mapIntelipostStatusToEnum(
    [
      safeString(result?.tracking?.status),
      safeString(result?.tracking?.status_label),
      safeString(latestTrackingEvent?.status),
      safeString(latestTrackingEvent?.description),
    ]
      .filter(Boolean)
      .join(' '),
  );

  const resolvedOrderNumber = safeString(result?.order?.order_number) || identifier;
  const trackingUrl = buildIntelipostTrackingUrl(
    intelipostClientId,
    resolvedOrderNumber,
  );

  return {
    id: `external-${normalizeAlphaNumeric(resolvedOrderNumber) || Date.now()}` ,
    orderNumber: resolvedOrderNumber,
    invoiceNumber: null,
    trackingCode: null,
    trackingUrl,
    trackingSourceLabel: 'Intelipost',
    customerName: 'Consulta externa',
    corporateName: null,
    cpf: null,
    cnpj: null,
    phone: null,
    mobile: null,
    salesChannel: 'Externo',
    freightType: safeString(result?.logistic_provider?.name) || 'Desconhecida',
    freightValue: 0,
    quotedFreightValue: null,
    quotedFreightDate: null,
    quotedFreightDetails: null,
    quotedCarrierName: null,
    freightCarrierMatchesQuote: null,
    shippingDate: new Date(),
    address: '',
    number: '',
    complement: null,
    neighborhood: '',
    city: safeString(result?.end_customer?.address?.city) || '',
    state: safeString(result?.end_customer?.address?.state) || '',
    zipCode: '',
    totalValue: 0,
    recipient: null,
    maxShippingDeadline: null,
    estimatedDeliveryDate: safeDate(result?.tracking?.estimated_delivery_date_lp),
    carrierEstimatedDeliveryDate: safeDate(result?.tracking?.estimated_delivery_date_lp),
    status,
    isDelayed: false,
    trackingHistory,
    lastApiSync: new Date(),
    lastUpdate: safeDate(latestTrackingEvent?.date) || new Date(),
    apiRawPayload: {
      source: source === 'INTELIPOST_INVOICE_KEY' ? 'INTELIPOST_INVOICE_KEY' : 'INTELIPOST',
      trackingUrl,
      tracking: result?.tracking ?? null,
      logistic_provider: result?.logistic_provider ?? null,
      end_customer: result?.end_customer ?? null,
      rawPayload: result ?? null,
    },
  };
};

const formatOrderForResponse = (
  order: any,
  sswRequireCnpjs: string[] = [],
  intelipostClientId?: string | null,
  correiosIntegrationEnabled = true,
  checkoutQuote?: any,
) => {
  const carrierEstimatedDeliveryDate =
    resolveCarrierEstimatedDateFromTrackingEvents(order.trackingEvents) ||
    order.carrierEstimatedDeliveryDate ||
    null;
  const legacyQuotedValue = order.quotedFreightValue ?? null;
  const legacyQuotedDate = order.quotedFreightDate ?? null;
  const legacyQuotedDetails = order.quotedFreightDetails ?? null;
  const originalQuotedFreightValue =
    order.originalQuotedFreightValue ??
    checkoutQuote?.quotedValue ??
    legacyQuotedValue;
  const originalQuotedFreightDate =
    order.originalQuotedFreightDate ??
    checkoutQuote?.createdAt ??
    legacyQuotedDate;
  const originalQuotedFreightDetails = mergeQuoteDetails(
    mergeQuoteDetails(order.originalQuotedFreightDetails, checkoutQuote?.snapshotData),
    legacyQuotedDetails,
  );
  const originalQuotedFreightQuotationId =
    extractOrderQuotationId(order) || safeString(checkoutQuote?.quotationId);
  const recalculatedFreightValue = order.recalculatedFreightValue ?? null;
  const recalculatedFreightDate = order.recalculatedFreightDate ?? null;
  const recalculatedFreightDetails = order.recalculatedFreightDetails ?? null;
  const isPlatformDelayed = isActiveDelayedByDate(
    order.status as OrderStatus,
    order.estimatedDeliveryDate,
  );
  const originalQuotedCarrierName = extractQuoteCarrierName(
    originalQuotedFreightDetails,
  );
  const recalculatedQuotedCarrierName = extractQuoteCarrierName(
    recalculatedFreightDetails,
  );
  const freightCarrierMatchesOriginalQuote =
    originalQuotedCarrierName && order.freightType
      ? normalizeComparableText(order.freightType) ===
        normalizeComparableText(originalQuotedCarrierName)
      : null;
  const freightCarrierMatchesRecalculatedQuote =
    recalculatedQuotedCarrierName && order.freightType
      ? normalizeComparableText(order.freightType) ===
        normalizeComparableText(recalculatedQuotedCarrierName)
      : null;

  return {
    ...order,
    orderNumber: String(order.orderNumber),
    status: order.status as OrderStatus,
    platformCreatedAt: resolvePlatformCreatedDate(order),
    carrierEstimatedDeliveryDate,
    trackingSourceLabel: resolveTrackingSourceLabel(
      order,
      sswRequireCnpjs,
      intelipostClientId,
      correiosIntegrationEnabled,
    ),
    quotedFreightValue: legacyQuotedValue,
    quotedFreightDate: legacyQuotedDate,
    quotedFreightDetails: legacyQuotedDetails,
    quotedCarrierName: originalQuotedCarrierName,
    originalQuotedFreightValue,
    originalQuotedFreightDate,
    originalQuotedFreightDetails,
    originalQuotedFreightQuotationId,
    originalQuotedCarrierName,
    recalculatedFreightValue,
    recalculatedFreightDate,
    recalculatedFreightDetails,
    recalculatedQuotedCarrierName,
    isPlatformDelayed,
    freightCarrierMatchesQuote: freightCarrierMatchesOriginalQuote,
    freightCarrierMatchesOriginalQuote,
    freightCarrierMatchesRecalculatedQuote,
    trackingHistory: mapTrackingEventsToHistory(order.trackingEvents),
    lastUpdate: getMovementDate(order),
    jetOrderId: resolveJetOrderId(order),
    trackingUrl: resolveOrderTrackingUrl(
      order,
      sswRequireCnpjs,
      intelipostClientId,
      correiosIntegrationEnabled,
    ),
  };
};

const formatOrderListResponse = (order: any) => {
  const carrierEstimatedDeliveryDate =
    resolveCarrierEstimatedDateFromTrackingEvents(order.trackingEvents) ||
    order.carrierEstimatedDeliveryDate ||
    null;
  const quotedFreightValue = order.quotedFreightValue ?? null;
  const originalQuotedFreightValue =
    order.originalQuotedFreightValue ?? quotedFreightValue;
  const originalQuotedFreightDate =
    order.originalQuotedFreightDate ?? order.quotedFreightDate ?? null;
  const recalculatedFreightValue = order.recalculatedFreightValue ?? null;
  const recalculatedFreightDate = order.recalculatedFreightDate ?? null;

  return {
    ...order,
    orderNumber: String(order.orderNumber),
    status: order.status as OrderStatus,
    platformCreatedAt: resolvePlatformCreatedDate(order),
    carrierEstimatedDeliveryDate,
    trackingSourceLabel: null,
    quotedFreightValue,
    quotedFreightDate: order.quotedFreightDate ?? null,
    quotedFreightDetails: null,
    quotedCarrierName: null,
    originalQuotedFreightValue,
    originalQuotedFreightDate,
    originalQuotedFreightDetails: null,
    originalQuotedFreightQuotationId: null,
    originalQuotedCarrierName: null,
    recalculatedFreightValue,
    recalculatedFreightDate,
    recalculatedFreightDetails: null,
    recalculatedQuotedCarrierName: null,
    isPlatformDelayed: isActiveDelayedByDate(
      order.status as OrderStatus,
      order.estimatedDeliveryDate,
    ),
    freightCarrierMatchesQuote: null,
    freightCarrierMatchesOriginalQuote: null,
    freightCarrierMatchesRecalculatedQuote: null,
    trackingHistory: mapTrackingEventsToHistory(order.trackingEvents),
    lastUpdate: getMovementDate(order),
    jetOrderId: resolveJetOrderId(order),
    trackingUrl: null,
  };
};

export const importOrders = async (req: Request, res: Response) => {
  console.log('Importando pedidos em lote...');

  try {
    const { orders } = req.body;
    // @ts-ignore
    const user = req.user;

    if (!user || !user.companyId) {
      return res.status(403).json({
        error: 'Usuario nao vinculado a uma empresa. Contate o administrador.',
      });
    }

    if (!Array.isArray(orders) || orders.length === 0) {
      return res.status(400).json({ error: 'Nenhum pedido valido para importar' });
    }

    const { message, results } = await importOrdersForCompany(
      user.companyId,
      orders,
    );

    return res.json({
      success: true,
      message,
      results,
    });
  } catch (error) {
    console.error('Erro na importacao:', error);
    return res.status(500).json({
      error: 'Erro ao importar pedidos',
      details: error instanceof Error ? error.message : 'Erro desconhecido',
    });
  }
};

export const getOrders = async (req: Request, res: Response) => {
  try {
    // @ts-ignore
    const user = req.user;
    if (!user || !user.companyId) {
      return res.status(403).json({ error: 'Acesso negado. Usuario sem empresa.' });
    }

    const archivedMode = resolveArchivedFilterMode(req.query?.archived);

    const orders = await listOrdersForCompany(user.companyId, archivedMode);

    return res.json(
      orders
        .filter((order) => !shouldExcludeOrderFromPlatform(order))
        .map((order) => formatOrderListResponse(order)),
    );
  } catch (error) {
    console.error('Erro ao buscar pedidos:', error);
    return res.status(500).json({ error: 'Erro ao buscar pedidos' });
  }
};

export const getOrderById = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    // @ts-ignore
    const user = req.user;

    if (typeof id !== 'string') {
      return res.status(400).json({ error: 'ID invalido' });
    }

    if (!user?.companyId) {
      return res.status(403).json({ error: 'Acesso negado. Usuario sem empresa.' });
    }

    const order = await getOrderByIdFromDb(id);

    if (!order) {
      return res.status(404).json({ error: 'Pedido nao encontrado' });
    }

    if (order.companyId !== user.companyId) {
      return res.status(404).json({ error: 'Pedido nao encontrado' });
    }

    if (shouldExcludeOrderFromPlatform(order)) {
      return res.status(404).json({ error: 'Pedido nao encontrado' });
    }

    const sswRequireCnpjs = await getCompanySswRequireCnpjs(order.companyId);
    const intelipostClientId = await getCompanyIntelipostClientId(order.companyId);
    const correiosIntegrationEnabled =
      await getCompanyCorreiosIntegrationEnabled(order.companyId);
    const checkoutQuote = await loadCheckoutQuoteForOrder(order.companyId, order);

    return res.json(
      formatOrderForResponse(
        order,
        sswRequireCnpjs,
        intelipostClientId,
        correiosIntegrationEnabled,
        checkoutQuote,
      ),
    );
  } catch (error) {
    console.error('Erro ao buscar pedido:', error);
    return res.status(500).json({ error: 'Erro ao buscar pedido' });
  }
};

export const updateOrderFreightType = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const freightType = safeString(req.body?.freightType);
    // @ts-ignore
    const user = req.user;

    if (typeof id !== 'string') {
      return res.status(400).json({ error: 'ID invalido' });
    }

    if (!user?.companyId) {
      return res.status(403).json({ error: 'Acesso negado. Usuario sem empresa.' });
    }

    if (!freightType) {
      return res.status(400).json({ error: 'Informe o nome da transportadora.' });
    }

    const order = await getOrderByIdFromDb(id);

    if (!order || order.companyId !== user.companyId) {
      return res.status(404).json({ error: 'Pedido nao encontrado' });
    }

    const updatedOrderBase = await updateOrderFreightTypeById(id, freightType);
    const updatedOrder = updatedOrderBase
      ? await getOrderByIdFromDb(String(updatedOrderBase.id))
      : null;

    if (!updatedOrder) {
      return res.status(404).json({ error: 'Pedido nao encontrado' });
    }

    const sswRequireCnpjs = await getCompanySswRequireCnpjs(user.companyId);
    const intelipostClientId = await getCompanyIntelipostClientId(user.companyId);
    const correiosIntegrationEnabled =
      await getCompanyCorreiosIntegrationEnabled(user.companyId);
    const checkoutQuote = await loadCheckoutQuoteForOrder(user.companyId, updatedOrder);

    return res.json({
      success: true,
      message: 'Transportadora atualizada com sucesso.',
      order: formatOrderForResponse(
        updatedOrder,
        sswRequireCnpjs,
        intelipostClientId,
        correiosIntegrationEnabled,
        checkoutQuote,
      ),
    });
  } catch (error) {
    console.error('Erro ao atualizar transportadora do pedido:', error);
    return res.status(500).json({
      error: toUserFacingDatabaseErrorMessage(
        error,
        'Erro ao atualizar transportadora do pedido',
      ),
    });
  }
};

export const updateOrderManualData = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    // @ts-ignore
    const user = req.user;

    if (typeof id !== 'string') {
      return res.status(400).json({ error: 'ID invalido' });
    }

    if (!user?.companyId) {
      return res.status(403).json({ error: 'Acesso negado. Usuario sem empresa.' });
    }

    const order = await getOrderByIdFromDb(id);

    if (!order || order.companyId !== user.companyId) {
      return res.status(404).json({ error: 'Pedido nao encontrado' });
    }

    const customerName = safeString(req.body?.customerName);
    if (!customerName) {
      return res.status(400).json({ error: 'Informe o nome do cliente.' });
    }

    const trackingUrl = safeString(req.body?.trackingUrl);
    const manualCustomStatus = safeString(req.body?.manualCustomStatus);
    const observation = safeString(req.body?.observation);
    const updatedOrderBase = await updateOrderManualFieldsById({
      id,
      customerName,
      corporateName: safeString(req.body?.corporateName),
      cpf: safeString(req.body?.cpf),
      cnpj: safeString(req.body?.cnpj),
      phone: safeString(req.body?.phone),
      mobile: safeString(req.body?.mobile),
      invoiceNumber: safeString(req.body?.invoiceNumber),
      trackingCode: safeString(req.body?.trackingCode),
      address: safeString(req.body?.address) || '',
      number: safeString(req.body?.number) || '',
      complement: safeString(req.body?.complement),
      neighborhood: safeString(req.body?.neighborhood) || '',
      city: safeString(req.body?.city) || '',
      state: safeString(req.body?.state) || '',
      zipCode: safeString(req.body?.zipCode) || '',
      recipient: safeString(req.body?.recipient),
      salesChannel: safeString(req.body?.salesChannel) || order.salesChannel,
      manualCustomStatus,
      observation,
      apiRawPayload: mergeApiRawPayload(order.apiRawPayload, {
        manualTrackingUrl: trackingUrl,
        manualTrackingUpdatedAt: new Date().toISOString(),
      }),
    });
    const updatedOrder = updatedOrderBase
      ? await getOrderByIdFromDb(String(updatedOrderBase.id))
      : null;

    if (!updatedOrder) {
      return res.status(404).json({ error: 'Pedido nao encontrado' });
    }

    const sswRequireCnpjs = await getCompanySswRequireCnpjs(user.companyId);
    const intelipostClientId = await getCompanyIntelipostClientId(user.companyId);
    const correiosIntegrationEnabled =
      await getCompanyCorreiosIntegrationEnabled(user.companyId);
    const checkoutQuote = await loadCheckoutQuoteForOrder(user.companyId, updatedOrder);

    return res.json({
      success: true,
      message: 'Dados do pedido atualizados com sucesso.',
      order: formatOrderForResponse(
        updatedOrder,
        sswRequireCnpjs,
        intelipostClientId,
        correiosIntegrationEnabled,
        checkoutQuote,
      ),
    });
  } catch (error) {
    console.error('Erro ao atualizar dados manuais do pedido:', error);
    return res.status(500).json({
      error: toUserFacingDatabaseErrorMessage(
        error,
        'Erro ao atualizar dados do pedido',
      ),
    });
  }
};

export const markOrderDeliveredManually = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    // @ts-ignore
    const user = req.user;

    if (typeof id !== 'string') {
      return res.status(400).json({ error: 'ID invalido' });
    }

    if (!user?.companyId) {
      return res.status(403).json({ error: 'Acesso negado. Usuario sem empresa.' });
    }

    const order = await getOrderByIdFromDb(id);

    if (!order || order.companyId !== user.companyId) {
      return res.status(404).json({ error: 'Pedido nao encontrado' });
    }

    if (order.isArchived) {
      return res.status(400).json({ error: 'Pedido arquivado. Desarquive antes de alterar.' });
    }

    if (order.status === OrderStatus.DELIVERED) {
      return res.status(400).json({ error: 'Pedido ja esta com status entregue.' });
    }

    const updatedOrderBase = await markOrderDeliveredManuallyById({
      id,
      description: 'Status alterado manualmente para ENTREGUE.',
      city: safeString(order.city),
      state: safeString(order.state),
      eventDate: new Date(),
    });

    const updatedOrder = updatedOrderBase
      ? await getOrderByIdFromDb(String(updatedOrderBase.id))
      : null;

    if (!updatedOrder) {
      return res.status(404).json({ error: 'Pedido nao encontrado' });
    }

    const sswRequireCnpjs = await getCompanySswRequireCnpjs(user.companyId);
    const intelipostClientId = await getCompanyIntelipostClientId(user.companyId);
    const correiosIntegrationEnabled =
      await getCompanyCorreiosIntegrationEnabled(user.companyId);
    const checkoutQuote = await loadCheckoutQuoteForOrder(user.companyId, updatedOrder);

    return res.json({
      success: true,
      message: `Pedido ${updatedOrder.orderNumber} marcado como entregue.`,
      order: formatOrderForResponse(
        updatedOrder,
        sswRequireCnpjs,
        intelipostClientId,
        correiosIntegrationEnabled,
        checkoutQuote,
      ),
    });
  } catch (error) {
    console.error('Erro ao marcar pedido como entregue manualmente:', error);
    return res.status(500).json({
      error: toUserFacingDatabaseErrorMessage(
        error,
        'Erro ao marcar pedido como entregue',
      ),
    });
  }
};

export const listCustomOrderStatuses = async (req: Request, res: Response) => {
  try {
    // @ts-ignore
    const user = req.user;

    if (!user?.companyId) {
      return res.status(403).json({ error: 'Acesso negado. Usuario sem empresa.' });
    }

    const rows = await listCompanyCustomOrderStatuses(user.companyId);

    return res.json({
      success: true,
      statuses: rows,
    });
  } catch (error) {
    console.error('Erro ao listar status personalizados:', error);
    return res.status(500).json({
      error: toUserFacingDatabaseErrorMessage(
        error,
        'Erro ao listar status personalizados',
      ),
    });
  }
};

export const createCustomOrderStatus = async (req: Request, res: Response) => {
  try {
    // @ts-ignore
    const user = req.user;

    if (!user?.companyId) {
      return res.status(403).json({ error: 'Acesso negado. Usuario sem empresa.' });
    }

    const label = safeString(req.body?.label);
    if (!label) {
      return res.status(400).json({ error: 'Informe o nome do status personalizado.' });
    }

    const created = await upsertCompanyCustomOrderStatus({
      companyId: user.companyId,
      label,
      createdById: user.id || null,
    });

    return res.json({
      success: true,
      message: 'Status personalizado salvo com sucesso.',
      status: created,
    });
  } catch (error) {
    console.error('Erro ao criar status personalizado:', error);
    return res.status(500).json({
      error: toUserFacingDatabaseErrorMessage(
        error,
        'Erro ao criar status personalizado',
      ),
    });
  }
};

const setOrderArchivedState = async (
  req: Request,
  res: Response,
  archived: boolean,
) => {
  try {
    const { id } = req.params;
    // @ts-ignore
    const user = req.user;

    if (typeof id !== 'string') {
      return res.status(400).json({ error: 'ID invalido' });
    }

    if (!user?.companyId) {
      return res.status(403).json({ error: 'Acesso negado. Usuario sem empresa.' });
    }

    const order = await getOrderByIdFromDb(id);

    if (!order || order.companyId !== user.companyId) {
      return res.status(404).json({ error: 'Pedido nao encontrado' });
    }

    const updatedOrderBase = await updateOrderArchivedStateById(id, archived);
    const updatedOrder = updatedOrderBase
      ? await getOrderByIdFromDb(String(updatedOrderBase.id))
      : null;

    if (!updatedOrder) {
      return res.status(404).json({ error: 'Pedido nao encontrado' });
    }

    if (archived) {
      await deleteMonitoredOrderByCompanyAndOrder(user.companyId, id);
    }

    const sswRequireCnpjs = await getCompanySswRequireCnpjs(user.companyId);
    const intelipostClientId = await getCompanyIntelipostClientId(user.companyId);
    const correiosIntegrationEnabled =
      await getCompanyCorreiosIntegrationEnabled(user.companyId);
    const checkoutQuote = await loadCheckoutQuoteForOrder(user.companyId, updatedOrder);

    return res.json({
      success: true,
      message: archived
        ? 'Pedido arquivado com sucesso.'
        : 'Pedido removido do arquivo com sucesso.',
      order: formatOrderForResponse(
        updatedOrder,
        sswRequireCnpjs,
        intelipostClientId,
        correiosIntegrationEnabled,
        checkoutQuote,
      ),
    });
  } catch (error) {
    console.error('Erro ao atualizar arquivo do pedido:', error);
    return res.status(500).json({
      error: toUserFacingDatabaseErrorMessage(
        error,
        'Erro ao atualizar arquivo do pedido',
      ),
    });
  }
};

export const archiveOrder = async (req: Request, res: Response) =>
  setOrderArchivedState(req, res, true);

export const unarchiveOrder = async (req: Request, res: Response) =>
  setOrderArchivedState(req, res, false);

export const openOrderTracking = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    // @ts-ignore
    const user = req.user;

    if (typeof id !== 'string') {
      return res.status(400).json({ error: 'ID invalido' });
    }

    if (!user || !user.companyId) {
      return res.status(403).json({ error: 'Acesso negado. Usuario sem empresa.' });
    }

    const order = await getOrderByIdFromDb(id);

    if (!order || order.companyId !== user.companyId || shouldExcludeOrderFromPlatform(order)) {
      return res.status(404).json({ error: 'Pedido nao encontrado' });
    }

    const sswRequireCnpjs = await getCompanySswRequireCnpjs(user.companyId);
    const intelipostClientId = await getCompanyIntelipostClientId(user.companyId);
    const correiosIntegrationEnabled =
      await getCompanyCorreiosIntegrationEnabled(user.companyId);
    const trackingUrl = await resolveVerifiedOrderTrackingUrl(
      order,
      sswRequireCnpjs,
      intelipostClientId,
      correiosIntegrationEnabled,
    );

    if (!trackingUrl) {
      return res.status(404).json({
        error: 'Nenhum link direto de rastreio disponivel para este pedido.',
      });
    }

    if (
      req.query.resolve === '1' ||
      String(req.headers.accept || '').includes('application/json')
    ) {
      return res.json({ trackingUrl });
    }

    return res.redirect(trackingUrl);
  } catch (error) {
    console.error('Erro ao abrir link de rastreio:', error);
    return res.status(500).json({ error: 'Erro ao abrir rastreio do pedido' });
  }
};

export const searchExternalOrder = async (req: Request, res: Response) => {
  try {
    // @ts-ignore
    const user = req.user;
    const identifier = safeString(req.body?.identifier);

    if (!user || !user.companyId) {
      return res.status(403).json({ error: 'Acesso negado. Usuario sem empresa.' });
    }

    if (!identifier) {
      return res.status(400).json({ error: 'Informe pedido, NF ou chave XML.' });
    }

    const normalizedDigits = normalizeDigits(identifier);
    const normalizedAlphaNumeric = normalizeAlphaNumeric(identifier);
    const isCorreiosIdentifier = looksLikeCorreiosObjectCode(identifier);

    const existingOrder = await findActiveOrderByIdentifier({
      companyId: user.companyId,
      identifier,
      normalizedDigits,
      normalizedAlphaNumeric,
    });

    if (existingOrder && !shouldExcludeOrderFromPlatform(existingOrder)) {
      const syncResult = await trackingService.syncOrder(existingOrder.id, user.companyId);

      if (
        !syncResult.success &&
        syncResult.message !== 'Pedido ja finalizado' &&
        syncResult.message !== 'Pedido ja entregue'
      ) {
        return res.status(400).json({
          error: syncResult.message || 'Nao foi possivel atualizar o pedido local.',
        });
      }

      if (syncResult.change) {
        await notificationService
          .registerMonitoredOrderChanges(user.companyId, [syncResult.change])
          .catch((notificationError) => {
            console.error(
              'Falha ao registrar notificacao monitorada na busca externa local:',
              notificationError,
            );
          });
      }

      const refreshedOrder = await getOrderByIdFromDb(existingOrder.id);

      const sswRequireCnpjs = await getCompanySswRequireCnpjs(user.companyId);
      const intelipostClientId = await getCompanyIntelipostClientId(user.companyId);
      const correiosIntegrationEnabled =
        await getCompanyCorreiosIntegrationEnabled(user.companyId);

      return res.json({
        source: 'LOCAL',
        order: refreshedOrder
          ? formatOrderForResponse(
              refreshedOrder,
              sswRequireCnpjs,
              intelipostClientId,
              correiosIntegrationEnabled,
            )
          : null,
      });
    }

    const externalResult = await trackingService.searchExternalIdentifier(
      identifier,
      user.companyId,
    );

    if (!externalResult) {
      if (isCorreiosIdentifier) {
        return res.status(404).json({
          error:
            'Nao encontrei rastreio nos Correios para este codigo de objeto. Verifique o codigo informado e se a integracao dos Correios esta habilitada para a empresa ativa.',
        });
      }

      return res.status(404).json({
        error: 'Nenhum rastreio encontrado nas integradoras ativas.',
      });
    }

    const intelipostClientId = await getCompanyIntelipostClientId(user.companyId);
    const externalOrderPayload = buildExternalOrderResponse(
      identifier,
      externalResult.source,
      externalResult.result,
      intelipostClientId,
    );

    await importOrdersForCompany(user.companyId, [externalOrderPayload]);

    const savedOrder = await findLatestOrderByNumberForCompany(
      user.companyId,
      String(externalOrderPayload.orderNumber),
    );

    const sswRequireCnpjs = await getCompanySswRequireCnpjs(user.companyId);
    const correiosIntegrationEnabled =
      await getCompanyCorreiosIntegrationEnabled(user.companyId);
    const checkoutQuote = savedOrder
      ? await loadCheckoutQuoteForOrder(user.companyId, savedOrder)
      : null;

    return res.json({
      source: externalResult.source,
      order: savedOrder
        ? formatOrderForResponse(
            savedOrder,
            sswRequireCnpjs,
            intelipostClientId,
            correiosIntegrationEnabled,
            checkoutQuote,
          )
        : externalOrderPayload,
    });
  } catch (error) {
    console.error('Erro na busca externa:', error);
    const message =
      error instanceof Error
        ? error.message
        : 'Erro ao consultar pedido externamente';

    if (/correios/i.test(message)) {
      return res.status(400).json({ error: message });
    }

    return res.status(500).json({ error: 'Erro ao consultar pedido externamente' });
  }
};

export const syncSingleOrder = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    // @ts-ignore
    const user = req.user;

    if (typeof id !== 'string') {
      return res.status(400).json({ error: 'ID invalido' });
    }

    if (!user || !user.companyId) {
      return res.status(403).json({ error: 'Acesso negado. Usuario sem empresa.' });
    }

    if (await isDemoCompanyById(user.companyId)) {
      return res.status(400).json({ error: DEMO_SYNC_DISABLED_MESSAGE });
    }

    const result = await trackingService.syncOrder(id, user.companyId, {
      forceFinalized: true,
    });

    if (!result.success) {
      return res.status(400).json({
        success: false,
        message: result.message,
      });
    }

    if (result.change) {
      await notificationService
        .registerMonitoredOrderChanges(user.companyId, [result.change])
        .catch((notificationError) => {
          console.error(
            'Falha ao registrar notificacao monitorada no sync unitario:',
            notificationError,
          );
        });
    }

    const order = await getOrderByIdFromDb(id);

    if (order && shouldExcludeOrderFromPlatform(order)) {
      return res.status(404).json({
        success: false,
        message: 'Pedido tratado como logistica do canal.',
      });
    }

    const sswRequireCnpjs = await getCompanySswRequireCnpjs(user.companyId);
    const intelipostClientId = await getCompanyIntelipostClientId(user.companyId);
    const correiosIntegrationEnabled =
      await getCompanyCorreiosIntegrationEnabled(user.companyId);
    const checkoutQuote = order
      ? await loadCheckoutQuoteForOrder(user.companyId, order)
      : null;

    return res.json({
      success: true,
      message: result.message,
      order: order
        ? formatOrderForResponse(
            order,
            sswRequireCnpjs,
            intelipostClientId,
            correiosIntegrationEnabled,
            checkoutQuote,
          )
        : null,
    });
  } catch (error) {
    console.error('Erro ao sincronizar pedido:', error);
    return res.status(500).json({
      error: toUserFacingDatabaseErrorMessage(
        error,
        'Erro ao sincronizar pedido',
      ),
    });
  }
};

export const syncAllOrders = async (req: Request, res: Response) => {
  try {
    // @ts-ignore
    const user = req.user;

    if (!user || !user.companyId) {
      return res.status(403).json({ error: 'Acesso negado. Usuario sem empresa.' });
    }

    if (await isDemoCompanyById(user.companyId)) {
      return res.status(400).json({ error: DEMO_SYNC_DISABLED_MESSAGE });
    }

    if (hasReachedManualGeneralSyncLimit(user)) {
      return res.status(429).json({
        error: NON_ADMIN_MANUAL_GENERAL_SYNC_LIMIT_MESSAGE,
      });
    }

    const startedAt = new Date().toISOString();
    const results = await trackingService.syncAllActive(user.companyId);
    const finishedAt = new Date().toISOString();
    syncJobService.ensureSchedule(user.companyId, user.id);

    let report: any = null;
    try {
      report = await syncReportService.sendTrackingSyncReport({
        companyId: user.companyId,
        userId: user.id,
        userEmail: user.email,
        userName: user.email,
        trigger: 'manual',
        payload: results.report,
        startedAt,
        finishedAt,
      });
    } catch (reportError) {
      console.error('Falha ao enviar relatorio da sincronizacao direta:', reportError);
    }

    try {
      await notificationService.registerTrackingSyncNotifications({
        companyId: user.companyId,
        payload: results.report,
        reportId: report?.reportId || null,
        reportUrl: report?.reportUrl || null,
        csvUrl: report?.csvUrl || null,
        startedAt,
        finishedAt,
      });
    } catch (notificationError) {
      console.error(
        'Falha ao registrar notificacoes da sincronizacao direta:',
        notificationError,
      );
    }

    return res.json({
      success: true,
      message: `Sincronizacao concluida: ${results.success} sucessos, ${results.failed} falhas`,
      results,
      report,
      schedule: syncJobService.getSchedule(user.companyId),
    });
  } catch (error) {
    console.error('Erro ao sincronizar todos os pedidos:', error);
    return res.status(500).json({
      error: toUserFacingDatabaseErrorMessage(
        error,
        'Erro ao sincronizar pedidos',
      ),
    });
  }
};

export const startSyncAllOrders = async (req: Request, res: Response) => {
  try {
    // @ts-ignore
    const user = req.user;

    if (!user || !user.companyId) {
      return res.status(403).json({ error: 'Acesso negado. Usuario sem empresa.' });
    }

    if (await isDemoCompanyById(user.companyId)) {
      return res.status(400).json({ error: DEMO_SYNC_DISABLED_MESSAGE });
    }

    const existingJob = syncJobService.getJob(user.companyId);
    if (existingJob?.status === 'running') {
      return res.json({
        success: true,
        message: 'Sincronizacao em andamento',
        job: existingJob,
        schedule: syncJobService.getSchedule(user.companyId),
      });
    }

    if (hasReachedManualGeneralSyncLimit(user)) {
      return res.status(429).json({
        error: NON_ADMIN_MANUAL_GENERAL_SYNC_LIMIT_MESSAGE,
        schedule: syncJobService.getSchedule(user.companyId),
      });
    }

    const job = syncJobService.startJob(user.companyId, user.id, 'manual', {
      email: user.email,
      name: user.email,
    });

    return res.json({
      success: true,
      message: 'Sincronizacao em andamento',
      job,
      schedule: syncJobService.getSchedule(user.companyId),
    });
  } catch (error) {
    console.error('Erro ao iniciar sincronizacao:', error);
    return res.status(500).json({ error: 'Erro ao iniciar sincronizacao' });
  }
};

export const getSyncAllStatus = async (req: Request, res: Response) => {
  try {
    // @ts-ignore
    const user = req.user;

    if (!user || !user.companyId) {
      return res.status(403).json({ error: 'Acesso negado. Usuario sem empresa.' });
    }

    if (await isDemoCompanyById(user.companyId)) {
      return res.json({
        success: true,
        job: null,
        schedule: syncJobService.getDisabledSchedule(),
      });
    }

    syncJobService.ensureSchedule(user.companyId, user.id);

    return res.json({
      success: true,
      job: syncJobService.getJob(user.companyId),
      schedule: syncJobService.getSchedule(user.companyId),
    });
  } catch (error) {
    console.error('Erro ao obter status da sincronizacao:', error);
    return res.status(500).json({ error: 'Erro ao consultar status da sincronizacao' });
  }
};

export const cancelSyncAllOrders = async (req: Request, res: Response) => {
  try {
    // @ts-ignore
    const user = req.user;

    if (!user || !user.companyId) {
      return res.status(403).json({ error: 'Acesso negado. Usuario sem empresa.' });
    }

    const job = syncJobService.cancelJob(user.companyId);

    return res.json({
      success: true,
      message: job
        ? 'Solicitacao de cancelamento enviada para o sync de rastreio.'
        : 'Nenhum sync de rastreio em andamento para cancelar.',
      job,
      schedule: syncJobService.getSchedule(user.companyId),
    });
  } catch (error) {
    console.error('Erro ao cancelar sincronizacao:', error);
    return res.status(500).json({ error: 'Erro ao cancelar sincronizacao' });
  }
};

type CleanupPeriodWindow =
  | { type: 'ALL' }
  | { type: 'OLDER_THAN'; cutoffDate: Date }
  | { type: 'CUSTOM_RANGE'; startDate: Date; endDate: Date };

const CLEANUP_SCAN_BATCH_SIZE = 1000;
const CLEANUP_DELETE_BATCH_SIZE = 1000;

const resolveCleanupPeriodWindow = ({
  period,
  customStartDate,
  customEndDate,
}: {
  period: unknown;
  customStartDate: unknown;
  customEndDate: unknown;
}): { window?: CleanupPeriodWindow; error?: string } => {
  if (period === 'ALL') {
    return { window: { type: 'ALL' } };
  }

  if (period === '7_DAYS' || period === '15_DAYS' || period === '30_DAYS') {
    const days = Number(String(period).split('_')[0]);
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days);
    return { window: { type: 'OLDER_THAN', cutoffDate } };
  }

  if (period === 'CUSTOM') {
    const startDate = safeDate(customStartDate);
    const endDate = safeDate(customEndDate);

    if (!startDate || !endDate) {
      return {
        error: 'Informe as datas inicial e final do periodo personalizado.',
      };
    }

    startDate.setHours(0, 0, 0, 0);
    endDate.setHours(23, 59, 59, 999);

    if (startDate.getTime() > endDate.getTime()) {
      return { error: 'A data inicial nao pode ser maior que a data final.' };
    }

    return { window: { type: 'CUSTOM_RANGE', startDate, endDate } };
  }

  return { error: 'Periodo invalido' };
};

const resolveOrderCleanupReferenceDate = (order: any): Date | null => {
  const latestTrackingDate = safeDate(
    order?.trackingEvents?.[0]?.eventDate || order?.latestTrackingEventDate,
  );
  if (latestTrackingDate) {
    return latestTrackingDate;
  }

  const shippingDate = safeDate(order?.shippingDate);
  if (shippingDate) {
    return shippingDate;
  }

  const createdAt = safeDate(order?.createdAt);
  if (createdAt) {
    return createdAt;
  }

  return safeDate(order?.lastUpdate);
};

const matchesCleanupWindow = (
  referenceDate: Date | null,
  window: CleanupPeriodWindow,
): boolean => {
  if (window.type === 'ALL') {
    return true;
  }

  if (!referenceDate) {
    return false;
  }

  if (window.type === 'OLDER_THAN') {
    return referenceDate.getTime() < window.cutoffDate.getTime();
  }

  return (
    referenceDate.getTime() >= window.startDate.getTime() &&
    referenceDate.getTime() <= window.endDate.getTime()
  );
};

const collectOrderIdsForCleanup = async ({
  companyId,
  status,
  window,
}: {
  companyId: string;
  status?: OrderStatus;
  window: CleanupPeriodWindow;
}) => {
  if (window.type === 'ALL') {
    return null;
  }

  const orderIds: string[] = [];
  let cursor: string | undefined;

  while (true) {
    const rows = await listOrderCleanupBatch({
      companyId,
      status,
      cursor,
      limit: CLEANUP_SCAN_BATCH_SIZE,
    });

    if (rows.length === 0) {
      break;
    }

    for (const row of rows) {
      const referenceDate = resolveOrderCleanupReferenceDate(row);
      if (matchesCleanupWindow(referenceDate, window)) {
        orderIds.push(row.id);
      }
    }

    cursor = rows[rows.length - 1].id;
  }

  return orderIds;
};

const deleteOrdersByIdBatches = async (orderIds: string[]) => {
  if (orderIds.length === 0) {
    return 0;
  }

  let deletedCount = 0;

  for (let index = 0; index < orderIds.length; index += CLEANUP_DELETE_BATCH_SIZE) {
    const idsBatch = orderIds.slice(index, index + CLEANUP_DELETE_BATCH_SIZE);
    deletedCount += await deleteOrdersByIds(idsBatch);
  }

  return deletedCount;
};

export const clearOrdersDatabase = async (req: Request, res: Response) => {
  try {
    const {
      type,
      password,
      companyId,
      status,
      period,
      customStartDate,
      customEndDate,
    } = req.body;

    if (req.user?.email !== 'admin@avantracking.com.br') {
      return res.status(403).json({ error: 'Acesso negado' });
    }

    if (password !== '172839') {
      return res.status(403).json({ error: 'Senha incorreta' });
    }

    if (!companyId || typeof companyId !== 'string') {
      return res.status(400).json({ error: 'Empresa obrigatoria' });
    }

    const company = await getCompanyBasicById(companyId);

    if (!company) {
      return res.status(404).json({ error: 'Empresa nao encontrada' });
    }

    if (type === 'ALL') {
      const deletedCount = await deleteOrdersByCompany(company.id);
      return res.json({
        message: `Todos os ${deletedCount} pedidos da empresa ${company.name} foram apagados.`,
      });
    }

    if (type === 'DELIVERED_7_DAYS') {
      const deliveredWindow = resolveCleanupPeriodWindow({
        period: '7_DAYS',
        customStartDate,
        customEndDate,
      });

      if (!deliveredWindow.window) {
        return res
          .status(400)
          .json({ error: deliveredWindow.error || 'Periodo invalido' });
      }

      const eligibleOrderIds =
        (await collectOrderIdsForCleanup({
          companyId: company.id,
          status: OrderStatus.DELIVERED,
          window: deliveredWindow.window,
        })) || [];

      const deletedCount = await deleteOrdersByIdBatches(eligibleOrderIds);

      return res.json({
        message: `${deletedCount} pedidos entregues ha mais de 7 dias da empresa ${company.name} foram apagados.`,
      });
    }

    if (type === 'FILTERED') {
      const whereClause: Record<string, any> = {
        companyId: company.id,
      };

      if (status && status !== 'ALL') {
        if (!Object.values(OrderStatus).includes(status as OrderStatus)) {
          return res.status(400).json({ error: 'Status invalido' });
        }

        whereClause.status = status as OrderStatus;
      }

      const periodWindow = resolveCleanupPeriodWindow({
        period,
        customStartDate,
        customEndDate,
      });

      if (!periodWindow.window) {
        return res
          .status(400)
          .json({ error: periodWindow.error || 'Periodo invalido' });
      }

      let deletedCount = 0;

      if (periodWindow.window.type === 'ALL') {
        deletedCount = await deleteOrdersByCompanyAndStatus(
          company.id,
          (whereClause.status as string | undefined) || null,
        );
      } else {
        const eligibleOrderIds =
          (await collectOrderIdsForCleanup({
            companyId: company.id,
            status:
              status && status !== 'ALL'
                ? (status as OrderStatus)
                : undefined,
            window: periodWindow.window,
          })) || [];

        deletedCount = await deleteOrdersByIdBatches(eligibleOrderIds);
      }

      const statusLabel =
        status && status !== 'ALL' ? ` com status ${status}` : '';
      const periodLabel =
        period === 'ALL'
          ? ' sem recorte de periodo'
          : period === 'CUSTOM'
            ? ` no periodo de ${customStartDate} ate ${customEndDate}`
            : ` com ultima movimentacao acima de ${String(period).replace('_', ' ').toLowerCase()}`;

      return res.json({
        message: `${deletedCount} pedidos${statusLabel}${periodLabel} da empresa ${company.name} foram apagados.`,
      });
    }

    return res.status(400).json({ error: 'Tipo de limpeza invalido' });
  } catch (error) {
    console.error('Erro ao limpar banco de dados:', error);
    return res.status(500).json({ error: 'Erro ao limpar banco de dados' });
  }
};
