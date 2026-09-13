import axios, { AxiosInstance } from 'axios';
import { dbQuery } from '../lib/db';
import { anymarketRateLimiter } from './anymarketRateLimiter';
import { SyncCancellationError } from '../utils/syncCancellation';
import { resolveOrderShippingAvailabilityFromAnymarket } from './orderShippingAvailabilityService';

export interface AnymarketPagingInfo {
  size?: number;
  totalElements?: number;
  totalPages?: number;
  number?: number;
}

export interface AnymarketOrdersResponse {
  links?: Array<{
    rel?: string;
    href?: string;
  }>;
  content?: any[];
  page?: AnymarketPagingInfo;
}

export interface AnymarketConnectionStatus {
  configured: boolean;
  authorized: boolean;
  apiBaseUrl: string;
  platform: string | null;
  message: string;
}

type AnymarketConfiguration = {
  companyId: string;
  integrationEnabled: boolean;
  apiBaseUrl: string;
  platform: string;
  token: string | null;
};

const ANYMARKET_PRODUCTION_BASE_URL = 'https://api.anymarket.com.br/v2';
const ANYMARKET_PLATFORM_HEADER = 'AVANTRACKING';

const normalizeText = (value: unknown) => String(value || '').trim();

const normalizeDigits = (value: unknown) =>
  String(value || '')
    .replace(/\D/g, '')
    .trim();

const normalizeComparableText = (value: unknown) =>
  String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

const normalizeAlphaNumeric = (value: unknown) =>
  String(value || '')
    .replace(/[^A-Za-z0-9]/g, '')
    .toUpperCase()
    .trim();

const safeString = (value: unknown) => {
  const normalized = normalizeText(value);
  return normalized || null;
};

const safeNumber = (value: unknown) => {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const parsed =
    typeof value === 'number'
      ? value
      : Number(String(value).replace(/[^\d.,-]/g, '').replace(',', '.'));

  return Number.isFinite(parsed) ? parsed : null;
};

const safeDate = (value: unknown) => {
  if (!value) return null;

  try {
    const parsed = new Date(String(value));
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  } catch {
    return null;
  }
};

const normalizeBaseUrl = (value: unknown) => {
  const normalized = normalizeText(value);
  return (normalized || ANYMARKET_PRODUCTION_BASE_URL).replace(/\/+$/, '');
};

const buildCleanParams = (params: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(params).filter(([, value]) => value !== undefined && value !== null && value !== ''),
  );

const pickFirstString = (...values: unknown[]) => {
  for (const value of values) {
    const normalized = safeString(value);
    if (normalized) {
      return normalized;
    }
  }

  return null;
};

const extractNfeAccessKeyFromXml = (xmlLike: unknown) => {
  const xml = String(xmlLike || '').trim();
  if (!xml) return null;

  const chNfeMatch = xml.match(/<\s*chNFe\s*>\s*(\d{44})\s*<\s*\/\s*chNFe\s*>/i);
  if (chNfeMatch?.[1]) {
    return chNfeMatch[1];
  }

  const idMatch = xml.match(/Id\s*=\s*["']\s*NFe(\d{44})\s*["']/i);
  if (idMatch?.[1]) {
    return idMatch[1];
  }

  const normalized = normalizeAlphaNumeric(xml);
  const direct44 = normalized.match(/\d{44}/);
  if (direct44?.[0]) {
    return direct44[0];
  }

  return null;
};

const resolvePersonDocument = (buyer: any, shippingLike: any) => {
  const buyerDocumentType = normalizeComparableText(buyer?.documentType).toUpperCase();
  const buyerDigits = normalizeDigits(buyer?.documentNumberNormalized || buyer?.document);
  const shippingDocumentType = normalizeComparableText(shippingLike?.shipmentUserDocumentType).toUpperCase();
  const shippingDigits = normalizeDigits(shippingLike?.shipmentUserDocument);

  if (buyerDocumentType === 'CPF' || buyerDigits.length === 11) {
    return { cpf: buyerDigits || null, cnpj: null };
  }

  if (buyerDocumentType === 'CNPJ' || buyerDigits.length === 14) {
    return { cpf: null, cnpj: buyerDigits || null };
  }

  if (shippingDocumentType === 'CPF' || shippingDigits.length === 11) {
    return { cpf: shippingDigits || null, cnpj: null };
  }

  if (shippingDocumentType === 'CNPJ' || shippingDigits.length === 14) {
    return { cpf: null, cnpj: shippingDigits || null };
  }

  return { cpf: null, cnpj: null };
};

const mapShipmentStatusToInternal = (value: unknown) => {
  const normalized = normalizeComparableText(value).toUpperCase();

  const map: Record<string, string> = {
    PENDING: 'PENDING',
    IN_TRANSIT: 'SHIPPED',
    SHIPPED: 'SHIPPED',
    DELIVERED: 'DELIVERED',
    DELIVERED_LATE: 'DELIVERED',
    NOT_DELIVERED: 'FAILURE',
    DELAYED: 'DELIVERY_ATTEMPT',
    HOLD_FOR_PICKUP: 'CREATED',
    HOLD_FOR_SHIPPED: 'CREATED',
    PACKING: 'CREATED',
    SHIP_CONFIRMED: 'CREATED',
    DELAYED_PICKUP: 'CREATED',
    DELAYED_SHIPPING: 'SHIPPED',
    QUARANTINE: 'CREATED',
    UNKNOWN: 'PENDING',
  };

  return map[normalized] || null;
};

const mapAnymarketStatusToInternal = (order: any) => {
  const normalizedStatus = normalizeComparableText(order?.status).toUpperCase();

  const primaryMap: Record<string, string> = {
    PENDING: 'PENDING',
    DELIVERY_ISSUE: 'FAILURE',
    PAID_WAITING_SHIP: 'CREATED',
    INVOICED: 'CREATED',
    PAID_WAITING_DELIVERY: 'SHIPPED',
    CONCLUDED: 'DELIVERED',
    CANCELED: 'CANCELED',
  };

  if (primaryMap[normalizedStatus]) {
    return primaryMap[normalizedStatus];
  }

  return (
    mapShipmentStatusToInternal(order?.tracking?.deliveryStatus) ||
    mapShipmentStatusToInternal(order?.deliveryStatus) ||
    mapShipmentStatusToInternal(order?.marketPlaceShipmentStatus) ||
    'PENDING'
  );
};

const collectOrderShippings = (order: any) => {
  const topLevelShippings = Array.isArray(order?.shippings) ? order.shippings : [];
  const itemLevelShippings = Array.isArray(order?.items)
    ? order.items.flatMap((item: any) =>
        Array.isArray(item?.shippings) ? item.shippings : [],
      )
    : [];

  return [...topLevelShippings, ...itemLevelShippings];
};

const buildTrackingHistory = (order: any, mappedStatus: string, address: any) => {
  const tracking = order?.tracking || {};
  const createdAt = safeDate(order?.createdAt);
  const shippedAt = safeDate(tracking?.shippedDate || tracking?.date);
  const deliveredAt = safeDate(tracking?.deliveredDate);
  const updatedAt = safeDate(order?.updatedAt || order?.lastUpdate);
  const shipmentStatusLabel = pickFirstString(
    tracking?.deliveryStatus,
    order?.deliveryStatus,
    order?.marketPlaceShipmentStatus,
  );
  const city = pickFirstString(address?.city);
  const state = pickFirstString(address?.state, address?.stateAcronymNormalized);

  const history: Array<{
    status: string;
    description: string;
    date: Date;
    city: string | null;
    state: string | null;
  }> = [];

  if (createdAt) {
    history.push({
      status: 'PENDING',
      description: `Pedido ANYMARKET criado com status ${pickFirstString(order?.status) || 'PENDING'}.`,
      date: createdAt,
      city,
      state,
    });
  }

  if (shippedAt) {
    history.push({
      status: mapShipmentStatusToInternal(tracking?.deliveryStatus) || 'SHIPPED',
      description:
        shipmentStatusLabel
          ? `Rastreamento ANYMARKET: ${shipmentStatusLabel}.`
          : 'Pedido enviado para a transportadora.',
      date: shippedAt,
      city,
      state,
    });
  }

  if (deliveredAt) {
    history.push({
      status: 'DELIVERED',
      description: 'Entrega confirmada no rastreamento do ANYMARKET.',
      date: deliveredAt,
      city,
      state,
    });
  }

  if (history.length === 0) {
    history.push({
      status: mappedStatus,
      description: `Pedido ANYMARKET em status ${pickFirstString(order?.status) || mappedStatus}.`,
      date: updatedAt || createdAt || new Date(),
      city,
      state,
    });
  }

  return history;
};

export class AnymarketApiService {
  constructor(private readonly companyId: string) {}

  async getConfiguration(): Promise<AnymarketConfiguration> {
    const companyResult = await dbQuery<any>(
      `
        SELECT
          c."anymarketIntegrationEnabled",
          c."anymarketToken"
        FROM "Company" c
        WHERE c."id" = $1
        LIMIT 1
      `,
      [this.companyId],
    );
    const company = companyResult.rows[0] || null;

    if (!company) {
      throw new Error('Empresa nao encontrada.');
    }

    return {
      companyId: this.companyId,
      integrationEnabled: company.anymarketIntegrationEnabled !== false,
      apiBaseUrl: normalizeBaseUrl(undefined),
      platform: ANYMARKET_PLATFORM_HEADER,
      token: safeString(company.anymarketToken),
    };
  }

  private async getClient(): Promise<{
    client: AxiosInstance;
    configuration: AnymarketConfiguration;
  }> {
    const configuration = await this.getConfiguration();

    if (!configuration.integrationEnabled) {
      throw new Error('A integracao ANYMARKET esta desativada para esta empresa.');
    }

    if (!configuration.token) {
      throw new Error('gumgaToken do ANYMARKET nao configurado para esta empresa.');
    }

    const client = axios.create({
      baseURL: configuration.apiBaseUrl,
      timeout: 45_000,
      headers: {
        'Content-Type': 'application/json',
        gumgaToken: configuration.token,
        platform: configuration.platform,
      },
    });

    return {
      client,
      configuration,
    };
  }

  async getConnectionStatus(): Promise<AnymarketConnectionStatus> {
    const configuration = await this.getConfiguration();

    if (!configuration.integrationEnabled) {
      return {
        configured: false,
        authorized: false,
        apiBaseUrl: configuration.apiBaseUrl,
        platform: configuration.platform,
        message: 'Integracao ANYMARKET desativada para esta empresa.',
      };
    }

    if (!configuration.token) {
      return {
        configured: false,
        authorized: false,
        apiBaseUrl: configuration.apiBaseUrl,
        platform: configuration.platform,
        message: 'ANYMARKET sem configuracao completa de gumgaToken.',
      };
    }

    try {
      const now = new Date();
      const sevenDaysAgo = new Date(now);
      sevenDaysAgo.setDate(now.getDate() - 1);

      await this.listOrders({
        limit: 5,
        offset: 0,
        updatedAfter: sevenDaysAgo.toISOString(),
        updatedBefore: now.toISOString(),
      });

      return {
        configured: true,
        authorized: true,
        apiBaseUrl: configuration.apiBaseUrl,
        platform: configuration.platform,
        message: 'Integracao ANYMARKET online.',
      };
    } catch (error: any) {
      return {
        configured: true,
        authorized: false,
        apiBaseUrl: configuration.apiBaseUrl,
        platform: configuration.platform,
        message:
          error instanceof Error
            ? error.message
            : 'Falha ao validar conexao com o ANYMARKET.',
      };
    }
  }

  async listOrders(params: {
    limit?: number;
    offset?: number;
    status?: string;
    createdAfter?: string;
    createdBefore?: string;
    updatedAfter?: string;
    updatedBefore?: string;
    marketplace?: string;
    marketplaceId?: string;
    partnerId?: string;
    shippingId?: string;
    sort?: string;
    sortDirection?: 'ASC' | 'DESC';
  } = {}): Promise<AnymarketOrdersResponse> {
    return anymarketRateLimiter.execute(async () => {
      const { client } = await this.getClient();

      try {
        const response = await client.get('/orders', {
          params: buildCleanParams({
            limit: params.limit ?? 100,
            offset: params.offset ?? 0,
            status: params.status,
            createdAfter: params.createdAfter,
            createdBefore: params.createdBefore,
            updatedAfter: params.updatedAfter,
            updatedBefore: params.updatedBefore,
            marketplace: params.marketplace,
            marketplaceId: params.marketplaceId,
            partnerId: params.partnerId,
            shippingId: params.shippingId,
            sort: params.sort,
            sortDirection: params.sortDirection,
          }),
        });

        return {
          data: response.data,
          headers: response.headers as Record<string, unknown>,
        };
      } catch (error: any) {
        const details =
          error?.response?.data?.message ||
          error?.response?.data?.error ||
          error?.message ||
          'Erro desconhecido na API ANYMARKET.';
        const wrappedError: any = new Error(`Erro na API ANYMARKET: ${details}`);
        wrappedError.response = error?.response;
        throw wrappedError;
      }
    });
  }

  async getOrderById(orderId: string): Promise<any | null> {
    const normalizedOrderId = normalizeText(orderId);
    if (!normalizedOrderId) {
      return null;
    }

    return anymarketRateLimiter.execute(async () => {
      const { client } = await this.getClient();

      try {
        const response = await client.get(`/orders/${encodeURIComponent(normalizedOrderId)}`);
        return {
          data: response.data || null,
          headers: response.headers as Record<string, unknown>,
        };
      } catch (error: any) {
        if (Number(error?.response?.status) === 404) {
          return {
            data: null,
            headers: error?.response?.headers || null,
          };
        }

        return {
          data: null,
          headers: error?.response?.headers || null,
        };
      }
    });
  }

  async getProductBySkuId(skuId: string): Promise<any | null> {
    const normalizedSkuId = normalizeText(skuId);
    if (!normalizedSkuId) {
      return null;
    }

    const matchesReference = (product: any) => {
      const reference = normalizedSkuId;
      if (!product || typeof product !== 'object') {
        return false;
      }

      const directCandidates = [
        product?.id,
        product?.sku?.id,
        product?.sku?.partnerId,
        product?.externalId,
      ]
        .map((value) => normalizeText(value))
        .filter(Boolean);

      if (directCandidates.includes(reference)) {
        return true;
      }

      const skus = Array.isArray(product?.skus) ? product.skus : [];
      return skus.some((sku: any) => {
        const skuCandidates = [
          sku?.id,
          sku?.partnerId,
          sku?.externalId,
          sku?.idInMarketplace,
        ]
          .map((value) => normalizeText(value))
          .filter(Boolean);

        return skuCandidates.includes(reference);
      });
    };

    const extractProductCandidate = (payload: any) => {
      if (!payload || typeof payload !== 'object') {
        return null;
      }

      if (Array.isArray(payload?.content)) {
        return payload.content.find((product: any) => matchesReference(product)) || null;
      }

      if (Array.isArray(payload?.result)) {
        return payload.result.find((product: any) => matchesReference(product)) || null;
      }

      if (payload?.result && typeof payload.result === 'object') {
        return matchesReference(payload.result) ? payload.result : null;
      }

      if (payload?.product && typeof payload.product === 'object') {
        return matchesReference(payload.product) ? payload.product : null;
      }

      return matchesReference(payload) ? payload : null;
    };

    return anymarketRateLimiter.execute(async () => {
      const { client } = await this.getClient();
      const candidates = [
        {
          method: 'get' as const,
          url: `/products/${encodeURIComponent(normalizedSkuId)}`,
          params: undefined as Record<string, unknown> | undefined,
        },
        {
          method: 'get' as const,
          url: `/products/sku/${encodeURIComponent(normalizedSkuId)}`,
          params: undefined as Record<string, unknown> | undefined,
        },
        {
          method: 'get' as const,
          url: '/products',
          params: { skuId: normalizedSkuId },
        },
        {
          method: 'get' as const,
          url: '/products',
          params: { id: normalizedSkuId },
        },
      ];

      for (const candidate of candidates) {
        try {
          const response = await client.request({
            method: candidate.method,
            url: candidate.url,
            params: candidate.params,
          });

          const payload = response?.data;
          if (!payload) {
            continue;
          }

          const matchedProduct = extractProductCandidate(payload);
          if (matchedProduct) {
            return {
              data: matchedProduct,
              headers: response.headers as Record<string, unknown>,
            };
          }
        } catch {
          // tenta proximo endpoint
        }
      }

      return {
        data: null,
        headers: null,
      };
    });
  }

  async getOrderNfeXmlAccessKey(
    orderId: string,
    nfeType = 'sale',
  ): Promise<{
    accessKey: string | null;
    endpoint: string;
  }> {
    return anymarketRateLimiter.execute(async () => {
      const { client } = await this.getClient();
      const normalizedOrderId = normalizeText(orderId);
      const normalizedType = normalizeText(nfeType) || 'sale';
      const endpoint = `/orders/${encodeURIComponent(normalizedOrderId)}/nfe/type/${encodeURIComponent(normalizedType)}`;

      if (!normalizedOrderId) {
        return {
          data: { accessKey: null, endpoint },
          headers: null,
        };
      }

      try {
        const response = await client.get(endpoint, {
          responseType: 'text',
          headers: {
            Accept: 'application/xml, text/xml, application/json, text/plain',
          },
        });

        const payload = response?.data;

        if (typeof payload === 'string') {
          return {
            data: {
              accessKey: extractNfeAccessKeyFromXml(payload),
              endpoint,
            },
            headers: response.headers as Record<string, unknown>,
          };
        }

        const accessKey = pickFirstString(
          (payload as any)?.accessKey,
          (payload as any)?.invoice?.accessKey,
          extractNfeAccessKeyFromXml((payload as any)?.xml),
          extractNfeAccessKeyFromXml(JSON.stringify(payload || {})),
        );

        return {
          data: {
            accessKey,
            endpoint,
          },
          headers: response.headers as Record<string, unknown>,
        };
      } catch {
        return {
          data: { accessKey: null, endpoint },
          headers: null,
        };
      }
    });
  }

  async syncAllOrders(
    params: {
      status?: string;
      createdAfter?: string;
      createdBefore?: string;
      updatedAfter?: string;
      updatedBefore?: string;
      marketplace?: string;
    },
    hooks?: {
      onLog?: (message: string) => void;
      onOrdersBatch?: (orders: any[]) => Promise<void> | void;
      shouldCancel?: () => boolean;
    },
  ): Promise<number> {
    const pageSize = 100;
    let offset = 0;
    let importedOrdersCount = 0;
    let pageNumber = 1;

    while (true) {
      if (hooks?.shouldCancel?.()) {
        throw new SyncCancellationError();
      }

      hooks?.onLog?.(
        `Buscando pagina ${pageNumber} do ANYMARKET com offset ${offset}${params.status ? ` para status "${params.status}"` : ''}.`,
      );

      const response = await this.listOrders({
        limit: pageSize,
        offset,
        status: params.status,
        createdAfter: params.createdAfter,
        createdBefore: params.createdBefore,
        updatedAfter: params.updatedAfter,
        updatedBefore: params.updatedBefore,
        marketplace: params.marketplace,
      });

      const orders = Array.isArray(response.content) ? response.content : [];
      if (orders.length === 0) {
        break;
      }

      if (hooks?.shouldCancel?.()) {
        throw new SyncCancellationError();
      }

      await hooks?.onOrdersBatch?.(orders);
      importedOrdersCount += orders.length;

      const totalElements = Number(response.page?.totalElements || 0);
      offset += orders.length;
      pageNumber += 1;

      if (orders.length < pageSize) {
        break;
      }

      if (totalElements > 0 && offset >= totalElements) {
        break;
      }
    }

    return importedOrdersCount;
  }

  mapAnymarketOrderToSystem(anymarketOrder: any): any {
    const buyer = anymarketOrder?.buyer || {};
    const shipping = anymarketOrder?.shipping || {};
    const billingAddress = anymarketOrder?.billingAddress || {};
    const anymarketAddress = anymarketOrder?.anymarketAddress || {};
    const tracking = anymarketOrder?.tracking || {};
    const invoice = anymarketOrder?.invoice || {};
    const quoteReconciliation = anymarketOrder?.quoteReconciliation || {};
    const payments = Array.isArray(anymarketOrder?.payments) ? anymarketOrder.payments : [];
    const items = Array.isArray(anymarketOrder?.items) ? anymarketOrder.items : [];
    const shippings = collectOrderShippings(anymarketOrder);
    const primaryShipping = shippings[0] || {};
    const primaryPayment = payments[0] || {};
    const primaryItem = items[0] || {};
    const primaryItemSku = primaryItem?.sku || {};
    const primaryItemProduct = primaryItem?.product || {};
    const document = resolvePersonDocument(buyer, billingAddress);
    const mappedStatus = mapAnymarketStatusToInternal(anymarketOrder);
    const primaryAddress = shipping?.street || shipping?.address ? shipping : anymarketAddress;
    const salesChannelParts = [
      'ANYMARKET',
      pickFirstString(anymarketOrder?.marketPlace),
      pickFirstString(anymarketOrder?.subChannelNormalized, anymarketOrder?.subChannel),
    ].filter(Boolean);
    const resolvedOrderNumber = pickFirstString(
      anymarketOrder?.id,
      anymarketOrder?.partnerId,
      anymarketOrder?.marketPlaceId,
    );

    const quotedFreightValue = safeNumber(quoteReconciliation?.price);
    const quotedFreightDate = safeDate(
      anymarketOrder?.updatedAt || anymarketOrder?.lastUpdate || anymarketOrder?.createdAt,
    );
    const shippingDate =
      safeDate(tracking?.shippedDate) ||
      safeDate(tracking?.date) ||
      safeDate(shipping?.promisedDispatchTime) ||
      safeDate(anymarketOrder?.paymentDate) ||
      safeDate(anymarketOrder?.lastUpdate) ||
      safeDate(anymarketOrder?.createdAt);
    const estimatedDeliveryDate =
      safeDate(tracking?.estimateDate) ||
      safeDate(shipping?.promisedShippingTime) ||
      safeDate(anymarketAddress?.promisedShippingTime);
    const shippingAvailability = resolveOrderShippingAvailabilityFromAnymarket(
      anymarketOrder,
      safeDate(anymarketOrder?.paymentDate) ||
        safeDate(anymarketOrder?.createdAt) ||
        new Date(),
    );
    const resolvedMaxShippingDeadline =
      shippingAvailability.sendDate ||
      safeDate(shipping?.promisedShippingTime) ||
      safeDate(anymarketAddress?.promisedShippingTime) ||
      estimatedDeliveryDate;

    if (!resolvedOrderNumber) {
      throw new Error('Pedido ANYMARKET sem identificador utilizavel para importacao.');
    }

    return {
      orderNumber: resolvedOrderNumber,
      invoiceNumber: pickFirstString(invoice?.number),
      invoiceAccessKey: pickFirstString(invoice?.accessKey),
      invoiceXmlUrl: pickFirstString(invoice?.invoiceLink, invoice?.linkNfe),
      trackingCode: pickFirstString(tracking?.number, anymarketOrder?.shippingId),
      customerName: pickFirstString(buyer?.name, shipping?.receiverName, anymarketAddress?.receiverName) || 'Desconhecido',
      corporateName:
        document.cnpj && buyer?.name && buyer?.name !== shipping?.receiverName
          ? pickFirstString(buyer?.name)
          : null,
      cpf: document.cpf,
      cnpj: document.cnpj,
      phone: pickFirstString(
        buyer?.phone,
        shipping?.receiverPhone,
        billingAddress?.receiverPhone,
      ),
      mobile: pickFirstString(
        buyer?.cellPhone,
        buyer?.phone,
        shipping?.receiverPhone,
        billingAddress?.receiverPhone,
      ),
      salesChannel: salesChannelParts.join(' - '),
      freightType:
        pickFirstString(
          tracking?.carrier,
          primaryShipping?.shippingtype,
          primaryShipping?.shippingCarrierNormalized,
          primaryShipping?.shippingCarrierTypeNormalized,
        ) || 'Nao informado',
      freightValue: safeNumber(anymarketOrder?.freight) || 0,
      quotedFreightValue,
      quotedFreightDate: quotedFreightValue !== null ? quotedFreightDate : null,
      quotedFreightDetails:
        quotedFreightValue !== null
          ? {
              quoteId: pickFirstString(quoteReconciliation?.quoteId),
              price: quotedFreightValue,
            }
          : null,
      originalQuotedFreightValue: quotedFreightValue,
      originalQuotedFreightDate: quotedFreightValue !== null ? quotedFreightDate : null,
      originalQuotedFreightDetails:
        quotedFreightValue !== null
          ? {
              quoteId: pickFirstString(quoteReconciliation?.quoteId),
              price: quotedFreightValue,
            }
          : null,
      originalQuotedFreightQuotationId: pickFirstString(quoteReconciliation?.quoteId),
      recalculatedFreightValue: null,
      recalculatedFreightDate: null,
      recalculatedFreightDetails: null,
      shippingDate,
      address: pickFirstString(
        primaryAddress?.street,
        primaryAddress?.address,
        billingAddress?.street,
        billingAddress?.address,
      ) || '',
      number: pickFirstString(primaryAddress?.number, billingAddress?.number) || '',
      complement: pickFirstString(primaryAddress?.comment, billingAddress?.comment),
      neighborhood:
        pickFirstString(primaryAddress?.neighborhood, billingAddress?.neighborhood) || '',
      city: pickFirstString(primaryAddress?.city, billingAddress?.city) || '',
      state:
        pickFirstString(
          primaryAddress?.stateAcronymNormalized,
          primaryAddress?.state,
          billingAddress?.stateAcronymNormalized,
          billingAddress?.state,
        ) || '',
      zipCode:
        normalizeDigits(
          pickFirstString(primaryAddress?.zipCode, billingAddress?.zipCode),
        ) || '',
      totalValue: safeNumber(anymarketOrder?.total) || 0,
      recipient:
        pickFirstString(
          billingAddress?.shipmentUserName,
          billingAddress?.receiverName,
          shipping?.shipmentUserName,
          shipping?.receiverName,
          anymarketAddress?.receiverName,
          buyer?.name,
        ) || null,
      maxShippingDeadline:
        resolvedMaxShippingDeadline,
      estimatedDeliveryDate,
      carrierEstimatedDeliveryDate: safeDate(tracking?.estimateDate),
      status: mappedStatus,
      isDelayed: false,
      apiRawPayload: {
        ...anymarketOrder,
        source: 'ANYMARKET',
        anymarketMeta: {
          lastUpdate: anymarketOrder?.lastUpdate || null,
          transmissionStatus: pickFirstString(anymarketOrder?.transmissionStatus),
          deliveryStatus: pickFirstString(
            anymarketOrder?.deliveryStatus,
            tracking?.deliveryStatus,
            anymarketOrder?.marketPlaceShipmentStatus,
          ),
          marketPlaceUrl: pickFirstString(anymarketOrder?.marketPlaceUrl),
          paymentSummary:
            primaryPayment && Object.keys(primaryPayment).length > 0
              ? {
                  method: pickFirstString(primaryPayment?.method),
                  normalizedMethod: pickFirstString(primaryPayment?.paymentMethodNormalized),
                  detail: pickFirstString(primaryPayment?.paymentDetailNormalized),
                  installments: safeNumber(primaryPayment?.installments),
                  value: safeNumber(primaryPayment?.value),
                }
              : null,
          primaryItem:
            primaryItem && Object.keys(primaryItem).length > 0
              ? {
                  orderItemId: pickFirstString(primaryItem?.orderItemId),
                  marketplaceItemId: pickFirstString(
                    primaryItem?.marketPlaceId,
                    primaryItem?.idInMarketPlace,
                  ),
                  skuPartnerId: pickFirstString(primaryItemSku?.partnerId),
                  skuId: pickFirstString(primaryItemSku?.id),
                  skuTitle: pickFirstString(primaryItemSku?.title),
                  productId: pickFirstString(primaryItemProduct?.id),
                  productTitle: pickFirstString(primaryItemProduct?.title),
                  quantity: safeNumber(primaryItem?.amount),
                }
              : null,
          shippingAvailability:
            shippingAvailability.maxDays !== null
              ? {
                  mode: shippingAvailability.mode,
                  maxDays: shippingAvailability.maxDays,
                  sendDate: shippingAvailability.sendDate
                    ? shippingAvailability.sendDate.toISOString()
                    : null,
                  items: shippingAvailability.items,
                }
              : null,
        },
      },
      trackingHistory: buildTrackingHistory(anymarketOrder, mappedStatus, primaryAddress),
    };
  }
}
