import axios, { AxiosInstance } from 'axios';
import { dbQuery } from '../lib/db';

export interface JetConnectionStatus {
  configured: boolean;
  authorized: boolean;
  apiBaseUrl: string | null;
  message: string;
}

type JetConfiguration = {
  companyId: string;
  integrationEnabled: boolean;
  apiBaseUrl: string | null;
  apiVersion: string;
  integrationKey: string | null;
  storeId: string | null;
  username: string | null;
  password: string | null;
  bearerToken: string | null;
};

const readEnv = (value: string | undefined | null) =>
  String(value || '')
    .trim()
    .replace(/^['"]+|['"]+$/g, '');

const HEADER_API_KEY =
  readEnv(process.env.JET_OPENAPI_HEADER_API_KEY) ||
  readEnv(process.env.JET_OPENAPI_HEADER_INTEGRATION_KEY) ||
  'apiKey';
const HEADER_STORE_ID = readEnv(process.env.JET_OPENAPI_HEADER_STORE_ID) || 'storeId';
const HEADER_USERNAME = readEnv(process.env.JET_OPENAPI_HEADER_USERNAME) || 'username';
const HEADER_PASSWORD = readEnv(process.env.JET_OPENAPI_HEADER_PASSWORD) || 'password';

const applyApiKeyHeader = (headers: Record<string, string>, apiKey: string) => {
  headers.apiKey = apiKey;
  if (HEADER_API_KEY.toLowerCase() !== 'apikey') {
    headers[HEADER_API_KEY] = apiKey;
  }
};

const normalizeText = (value: unknown) => String(value || '').trim();
const normalizeDigits = (value: unknown) =>
  String(value || '')
    .replace(/\D/g, '')
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

const pickFirstString = (...values: unknown[]) => {
  for (const value of values) {
    const normalized = safeString(value);
    if (normalized) return normalized;
  }

  return null;
};

const resolveApiBaseUrl = () =>
  readEnv(process.env.JET_OPENAPI_BASE_URL) || 'https://openapi.plataformaneo.com.br';

const resolveApiVersion = () => readEnv(process.env.JET_OPENAPI_VERSION) || '1';

const mapJetStatusToInternal = (statusName: string | null, statusCode: string | null) => {
  const source = `${String(statusName || '')} ${String(statusCode || '')}`
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase();

  if (source.includes('ENTREG')) return 'DELIVERED';
  if (source.includes('CANCEL')) return 'CANCELED';
  if (source.includes('DEVOL')) return 'RETURNED';
  if (source.includes('FALHA') || source.includes('NAO ENTREG')) return 'FAILURE';
  if (
    source.includes('ROTA') ||
    source.includes('SAIU PARA ENTREGA') ||
    source.includes('OUT_FOR_DELIVERY')
  ) {
    return 'DELIVERY_ATTEMPT';
  }
  if (source.includes('TRANSITO') || source.includes('TRANSPORTE') || source.includes('SHIP')) {
    return 'SHIPPED';
  }
  if (
    source.includes('APROVADO') ||
    source.includes('PAGO') ||
    source.includes('FATURADO') ||
    source.includes('SEPAR')
  ) {
    return 'CREATED';
  }

  return 'PENDING';
};

const buildTrackingHistory = (orderPayload: any, mappedStatus: string) => {
  const sourceHistory = Array.isArray(orderPayload?.historyListOrderStatus)
    ? orderPayload.historyListOrderStatus
    : [];
  const fallbackDate =
    safeDate(orderPayload?.dateOrder) ||
    safeDate(orderPayload?.paymentDate) ||
    new Date();

  if (sourceHistory.length === 0) {
    return [
      {
        status: mappedStatus,
        description: `Pedido JET em status ${pickFirstString(orderPayload?.nameStatus) || mappedStatus}.`,
        date: fallbackDate,
        city: pickFirstString(orderPayload?.address?.city),
        state: pickFirstString(orderPayload?.address?.state),
      },
    ];
  }

  return sourceHistory.map((item: any) => {
    const statusCode = pickFirstString(item?.statusCode);
    const statusName = pickFirstString(
      item?.statusExhibitionName,
      item?.statusName,
      item?.message,
    );
    const mapped = mapJetStatusToInternal(statusName, statusCode);

    return {
      status: mapped,
      description:
        pickFirstString(item?.message, item?.statusExhibitionName, item?.statusName) ||
        `Atualizacao JET (${statusCode || '-'})`,
      date: safeDate(item?.dateRegisterStatus) || fallbackDate,
      city: pickFirstString(orderPayload?.address?.city),
      state: pickFirstString(orderPayload?.address?.state),
    };
  });
};

const unwrapJetOrderResult = (payload: any) => {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  if (payload.result && typeof payload.result === 'object') {
    return payload.result;
  }

  return payload;
};

export class JetApiService {
  constructor(private readonly companyId: string) {}

  async getConfiguration(): Promise<JetConfiguration> {
    const companyResult = await dbQuery<any>(
      `
        SELECT
          c."jetIntegrationEnabled",
          c."jetIntegrationKey",
          c."jetStoreId",
          c."jetUsername",
          c."jetPassword",
          c."jetBearerToken"
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
      integrationEnabled: company.jetIntegrationEnabled === true,
      apiBaseUrl: resolveApiBaseUrl(),
      apiVersion: resolveApiVersion(),
      integrationKey: safeString(company.jetIntegrationKey),
      storeId: safeString(company.jetStoreId),
      username: safeString(company.jetUsername),
      password: safeString(company.jetPassword),
      bearerToken: safeString(company.jetBearerToken),
    };
  }

  private async getClient(): Promise<{
    client: AxiosInstance;
    configuration: JetConfiguration;
  }> {
    const configuration = await this.getConfiguration();

    if (!configuration.integrationEnabled) {
      throw new Error('A integracao JET esta desativada para esta empresa.');
    }

    if (!configuration.apiBaseUrl) {
      throw new Error('JET sem URL base configurada.');
    }

    if (!configuration.integrationKey) {
      throw new Error(
        'JET sem credencial apiKey configurada. Informe a Credencial de Integracao JET.',
      );
    }

    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    };

    if (configuration.integrationKey) {
      applyApiKeyHeader(headers, configuration.integrationKey);
    }
    if (configuration.storeId) {
      headers[HEADER_STORE_ID] = configuration.storeId;
    }
    if (configuration.username) {
      headers[HEADER_USERNAME] = configuration.username;
    }
    if (configuration.password) {
      headers[HEADER_PASSWORD] = configuration.password;
    }
    if (configuration.bearerToken) {
      headers.Authorization = `Bearer ${configuration.bearerToken}`;
    } else if (configuration.username || configuration.password) {
      const encoded = Buffer.from(
        `${configuration.username || ''}:${configuration.password || ''}`,
        'utf8',
      ).toString('base64');
      headers.Authorization = `Basic ${encoded}`;
    }

    const client = axios.create({
      baseURL: configuration.apiBaseUrl,
      timeout: 45_000,
      headers,
    });

    return { client, configuration };
  }

  async getConnectionStatus(): Promise<JetConnectionStatus> {
    const configuration = await this.getConfiguration();

    if (!configuration.integrationEnabled) {
      return {
        configured: false,
        authorized: false,
        apiBaseUrl: configuration.apiBaseUrl,
        message: 'Integracao JET desativada para esta empresa.',
      };
    }

    if (
      !configuration.apiBaseUrl ||
      !configuration.integrationKey
    ) {
      return {
        configured: false,
        authorized: false,
        apiBaseUrl: configuration.apiBaseUrl,
        message: 'JET sem configuracao completa de apiKey para consulta de pedidos.',
      };
    }

    return {
      configured: true,
      authorized: true,
      apiBaseUrl: configuration.apiBaseUrl,
      message: 'Integracao JET configurada.',
    };
  }

  async getOrderById(idOrder: string) {
    const { client, configuration } = await this.getClient();
    const id = normalizeDigits(idOrder);

    if (!id) {
      throw new Error('idOrder invalido para consulta na JET.');
    }

    const path = `/order/api/v${encodeURIComponent(configuration.apiVersion)}/id/${encodeURIComponent(
      id,
    )}`;

    try {
      const response = await client.get(path, {
        headers: {
          accept: 'application/json',
        },
      });
      const orderPayload = unwrapJetOrderResult(response.data);
      if (!orderPayload || typeof orderPayload !== 'object') {
        throw new Error('Resposta invalida da JET para consulta do pedido.');
      }

      return orderPayload;
    } catch (error: any) {
      const details =
        error?.response?.data?.message ||
        error?.response?.data?.error ||
        error?.message ||
        'Erro desconhecido na API JET.';
      throw new Error(`Erro ao consultar pedido ${id} na JET: ${details}`);
    }
  }

  mapJetOrderToSystem(jetOrder: any): any {
    const order = unwrapJetOrderResult(jetOrder) || jetOrder;
    const orderId = safeString(order?.idOrder);

    if (!orderId) {
      throw new Error('Pedido JET sem idOrder para importacao.');
    }

    const document = normalizeDigits(order?.cpf_cnpj || '');
    const isCpf = document.length === 11;
    const isCnpj = document.length === 14;
    const statusName = pickFirstString(order?.nameStatus);
    const mappedStatus = mapJetStatusToInternal(statusName, null);
    const historyList = Array.isArray(order?.historyListOrderStatus)
      ? order.historyListOrderStatus
      : [];
    const latestHistory = historyList[historyList.length - 1] || null;
    const historyOrderInfo = latestHistory?.orderInfo || {};
    const invoiceNumber = pickFirstString(
      order?.billNumber,
      historyOrderInfo?.noteNumber,
    );
    const trackingCode = pickFirstString(
      historyOrderInfo?.trackingNumber,
      order?.codigoExternoFrete,
      order?.shippingRegister,
    );
    const trackingUrl = pickFirstString(
      latestHistory?.trackingLink,
      order?.trackingLink,
    );
    const invoiceAccessKey = pickFirstString(
      historyOrderInfo?.key,
      order?.proofOfSale,
    );
    const freightType = pickFirstString(
      order?.nameCarrying,
      order?.shippingCompany,
      order?.nameShipping,
    );
    const city = pickFirstString(order?.address?.city, order?.billingAddress?.city);
    const state = pickFirstString(order?.address?.state, order?.billingAddress?.state);
    const shippingDate =
      safeDate(order?.dateOrder) ||
      safeDate(order?.paymentDate) ||
      safeDate(order?.marketPlaceDateCreated) ||
      new Date();
    const estimatedDeliveryDate = safeDate(order?.deliveryShipping);

    return {
      orderNumber: orderId,
      invoiceNumber,
      invoiceAccessKey,
      invoiceXmlUrl: null,
      trackingCode,
      customerName: pickFirstString(order?.nameCustomer) || 'Desconhecido',
      corporateName: isCnpj ? pickFirstString(order?.nameCustomer) : null,
      cpf: isCpf ? document : null,
      cnpj: isCnpj ? document : null,
      phone: pickFirstString(order?.phone1, order?.phone2),
      mobile: pickFirstString(order?.phone2, order?.phone1),
      salesChannel: ['JET', pickFirstString(order?.marketPlaceName), pickFirstString(order?.marketPlaceStore)]
        .filter(Boolean)
        .join(' - '),
      freightType: freightType || 'Nao informado',
      freightValue: safeNumber(order?.totalShipping) || 0,
      quotedFreightValue: null,
      quotedFreightDate: null,
      quotedFreightDetails: null,
      originalQuotedFreightValue: null,
      originalQuotedFreightDate: null,
      originalQuotedFreightDetails: null,
      originalQuotedFreightQuotationId: null,
      recalculatedFreightValue: null,
      recalculatedFreightDate: null,
      recalculatedFreightDetails: null,
      shippingDate,
      address: pickFirstString(order?.address?.streetAddress) || '',
      number: pickFirstString(order?.address?.number) || '',
      complement: pickFirstString(order?.address?.complement),
      neighborhood: pickFirstString(order?.address?.neighbourhood) || '',
      city: city || '',
      state: state || '',
      zipCode: normalizeDigits(pickFirstString(order?.address?.zipCode) || ''),
      totalValue: safeNumber(order?.total) || 0,
      recipient: pickFirstString(order?.address?.receiver, order?.nameCustomer),
      maxShippingDeadline: estimatedDeliveryDate,
      estimatedDeliveryDate,
      carrierEstimatedDeliveryDate: estimatedDeliveryDate,
      status: mappedStatus,
      isDelayed: false,
      apiRawPayload: {
        ...order,
        source: 'JET',
        jetMeta: {
          idOrder: orderId,
          marketPlaceNumberOrder: pickFirstString(order?.marketPlaceNumberOrder),
          marketPlaceStore: pickFirstString(order?.marketPlaceStore),
          marketPlaceName: pickFirstString(order?.marketPlaceName),
        },
        extractedTrackingUrl: trackingUrl,
      },
      trackingHistory: buildTrackingHistory(order, mappedStatus),
    };
  }
}
