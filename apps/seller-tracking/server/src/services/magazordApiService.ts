import axios, { AxiosInstance } from 'axios';
import { dbQuery } from '../lib/db';
import { SyncCancellationError } from '../utils/syncCancellation';

export interface MagazordPagingInfo {
  items?: any[];
  page_count?: number;
  page?: number;
  limit?: number;
  total?: number;
  total_pages?: number;
  has_more?: boolean;
}

export interface MagazordOrdersResponse {
  status?: string;
  data?: MagazordPagingInfo;
}

export interface MagazordConnectionStatus {
  configured: boolean;
  authorized: boolean;
  apiBaseUrl: string | null;
  message: string;
}

const DETAIL_BATCH_SIZE = 8;

type MagazordConfiguration = {
  companyId: string;
  integrationEnabled: boolean;
  apiBaseUrl: string | null;
  apiUser: string | null;
  apiPassword: string | null;
};

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
    .trim()
    .toLowerCase();

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

const toMagazordDateFilter = (value: string | undefined) => {
  if (!value) {
    return undefined;
  }

  const parsed = safeDate(value);
  if (!parsed) {
    return undefined;
  }

  const iso = parsed.toISOString();
  return `${iso.slice(0, 19)}+00:00`;
};

const parseOrderStatusCode = (value: unknown) => {
  const parsed = Number(String(value ?? '').trim());
  return Number.isFinite(parsed) ? parsed : null;
};

const unwrapOrderPayload = (value: any) => {
  if (value && typeof value === 'object' && !Array.isArray(value) && value.data) {
    return value.data;
  }

  return value;
};

const extractOrderCode = (value: any) =>
  pickFirstString(
    value?.codigo,
    value?.codigoPedido,
    value?.idPedido,
    value?.id,
    value?.codigoMarketplace,
  );

const tryParseJsonObject = (value: unknown) => {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value;
  }

  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const normalizeRastreioItems = (value: unknown) => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map((item) => unwrapOrderPayload(item)).filter(Boolean);
};

const collectValuesByKeys = (
  node: unknown,
  targetKeys: Set<string>,
  maxDepth = 6,
  depth = 0,
  visited = new WeakSet<object>(),
): unknown[] => {
  if (!node || depth > maxDepth) {
    return [];
  }

  if (Array.isArray(node)) {
    return node.flatMap((item) =>
      collectValuesByKeys(item, targetKeys, maxDepth, depth + 1, visited),
    );
  }

  if (typeof node !== 'object') {
    return [];
  }

  if (visited.has(node as object)) {
    return [];
  }
  visited.add(node as object);

  const values: unknown[] = [];
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    const normalizedKey = normalizeComparableText(key).replace(/[^a-z0-9]/g, '');
    if (targetKeys.has(normalizedKey)) {
      values.push(value);
    }

    if (value && typeof value === 'object') {
      values.push(
        ...collectValuesByKeys(value, targetKeys, maxDepth, depth + 1, visited),
      );
    }
  }

  return values;
};

const findFirstStringByKeys = (
  node: unknown,
  keys: string[],
  options?: {
    filter?: (value: string) => boolean;
  },
) => {
  const normalizedKeys = new Set(
    keys.map((key) => normalizeComparableText(key).replace(/[^a-z0-9]/g, '')),
  );
  const values = collectValuesByKeys(node, normalizedKeys);
  for (const value of values) {
    const parsed = safeString(value);
    if (!parsed) continue;
    if (options?.filter && !options.filter(parsed)) continue;
    return parsed;
  }

  return null;
};

const findFirstDateByKeys = (node: unknown, keys: string[]) => {
  const normalizedKeys = new Set(
    keys.map((key) => normalizeComparableText(key).replace(/[^a-z0-9]/g, '')),
  );
  const values = collectValuesByKeys(node, normalizedKeys);
  for (const value of values) {
    const parsed = safeDate(value);
    if (parsed) {
      return parsed;
    }
  }

  return null;
};

const parsePositiveDays = (value: unknown) => {
  const normalized = String(value ?? '').trim();
  if (!/^\d{1,3}$/.test(normalized)) {
    return null;
  }

  const days = Number(normalized);
  if (!Number.isFinite(days) || days <= 0 || days > 365) {
    return null;
  }

  return days;
};

const projectDateFromDays = (baseDate: Date | null, days: number | null) => {
  if (!baseDate || !days) {
    return null;
  }

  const projected = new Date(baseDate);
  projected.setDate(projected.getDate() + days);
  return Number.isNaN(projected.getTime()) ? null : projected;
};

const isLikelyCarrierName = (value: string) => {
  const normalized = normalizeComparableText(value);
  if (!normalized) {
    return false;
  }

  const blocked = new Set([
    'google',
    'google shopping',
    'facebook',
    'instagram',
    'meta',
    'bing',
    'yahoo',
    'site',
    'marketplace',
  ]);

  return !blocked.has(normalized);
};

const extractTrackingCodeFromOrder = (order: any) => {
  const parsedTrackingParams = tryParseJsonObject(order?.pedidoTrackingParams);
  const fromRastreioItems = normalizeRastreioItems(order?.arrayPedidoRastreio);

  for (const rastreio of fromRastreioItems) {
    const code = pickFirstString(
      rastreio?.codigoRastreio,
      rastreio?.codigo,
      rastreio?.trackingCode,
      rastreio?.rastreio,
      rastreio?.pedidoRastreioCodigo,
      rastreio?.codigoEnvio,
      rastreio?.codigoObjeto,
      rastreio?.objeto,
      rastreio?.pedras_codigo_rastreio,
    );
    if (code) {
      return code;
    }
  }

  return pickFirstString(
    order?.pedidoTrackingCodigo,
    order?.codigoRastreio,
    order?.codigoEnvio,
    order?.codigoObjeto,
    parsedTrackingParams?.codigoRastreio,
    parsedTrackingParams?.codigo,
    parsedTrackingParams?.trackingCode,
  );
};

const extractTrackingUrlFromOrder = (order: any) => {
  const parsedTrackingParams = tryParseJsonObject(order?.pedidoTrackingParams);
  const fromRastreioItems = normalizeRastreioItems(order?.arrayPedidoRastreio);

  for (const rastreio of fromRastreioItems) {
    const url = pickFirstString(
      rastreio?.url,
      rastreio?.link,
      rastreio?.linkRastreio,
      rastreio?.trackingUrl,
      rastreio?.urlRastreio,
      rastreio?.urlTracking,
      rastreio?.pedidoRastreioUrl,
      rastreio?.pedras_link_rastreio,
    );
    if (url) {
      return url;
    }
  }

  return pickFirstString(
    order?.trackingUrl,
    order?.pedidoTrackingUrl,
    order?.urlRastreio,
    order?.linkRastreio,
    parsedTrackingParams?.url,
    parsedTrackingParams?.link,
    parsedTrackingParams?.trackingUrl,
  );
};

const extractInvoiceNumberFromOrder = (order: any) => {
  const direct = pickFirstString(
    order?.numeroNotaFiscal,
    order?.notaFiscalNumero,
    order?.nfeNumero,
    order?.nfNumero,
    order?.numeroNf,
    order?.notaFiscalChave,
    order?.chaveNfe,
    order?.chaveAcessoNfe,
  );
  if (direct) {
    return direct;
  }

  return findFirstStringByKeys(order, [
    'numeroNotaFiscal',
    'notaFiscalNumero',
    'nfeNumero',
    'nfNumero',
    'numeroNf',
    'notaFiscalChave',
    'chaveNfe',
    'chaveAcessoNfe',
  ]);
};

const extractFreightTypeFromOrder = (order: any) => {
  const parsedTrackingParams = tryParseJsonObject(order?.pedidoTrackingParams);
  const fromRastreioItems = normalizeRastreioItems(order?.arrayPedidoRastreio);

  for (const rastreio of fromRastreioItems) {
    const candidate = pickFirstString(
      rastreio?.transportadoraNome,
      rastreio?.transportadora,
      rastreio?.nomeTransportadora,
      rastreio?.transportadoraServicoNome,
      rastreio?.transportadoraServico,
      rastreio?.servicoTransportadora,
      rastreio?.carrierName,
      rastreio?.carrier,
    );
    if (candidate && isLikelyCarrierName(candidate)) {
      return candidate;
    }
  }

  const direct = pickFirstString(
    order?.transportadoraNome,
    order?.transportadora,
    order?.nomeTransportadora,
    order?.transportadoraServicoNome,
    order?.transportadoraServico,
    parsedTrackingParams?.transportadoraNome,
    parsedTrackingParams?.transportadora,
    parsedTrackingParams?.carrierName,
  );
  if (direct && isLikelyCarrierName(direct)) {
    return direct;
  }

  const recursive = findFirstStringByKeys(
    order,
    [
      'transportadoraNome',
      'transportadora',
      'nomeTransportadora',
      'transportadoraServicoNome',
      'transportadoraServico',
      'servicoTransportadora',
      'carrierName',
      'carrier',
    ],
    {
      filter: isLikelyCarrierName,
    },
  );

  return recursive || 'Nao informado';
};

const extractEstimatedDeliveryDateFromOrder = (order: any) => {
  const parsedTrackingParams = tryParseJsonObject(order?.pedidoTrackingParams);
  const fromRastreioItems = normalizeRastreioItems(order?.arrayPedidoRastreio);

  const direct =
    safeDate(order?.pedidoTrackingPrevisaoEntrega) ||
    safeDate(order?.dataPrevisaoEntrega) ||
    safeDate(order?.dataEntregaPrevista) ||
    safeDate(order?.estimatedDeliveryDate);

  if (direct) {
    return direct;
  }

  for (const rastreio of fromRastreioItems) {
    const fromTracking =
      safeDate(rastreio?.dataPrevisaoEntrega) ||
      safeDate(rastreio?.previsaoEntrega) ||
      safeDate(rastreio?.estimatedDeliveryDate) ||
      safeDate(rastreio?.dataEntregaPrevista);
    if (fromTracking) {
      return fromTracking;
    }
  }

  const nestedDate =
    findFirstDateByKeys(parsedTrackingParams, [
      'dataPrevisaoEntrega',
      'previsaoEntrega',
      'estimatedDeliveryDate',
      'dataEntregaPrevista',
      'deliveryDate',
    ]) ||
    findFirstDateByKeys(order, [
      'dataPrevisaoEntrega',
      'previsaoEntrega',
      'estimatedDeliveryDate',
      'dataEntregaPrevista',
      'deliveryDate',
      'promessaEntrega',
    ]);
  if (nestedDate) {
    return nestedDate;
  }

  const prazoDias =
    parsePositiveDays(order?.prazoEntrega) ||
    parsePositiveDays(order?.prazoEntregaDias) ||
    parsePositiveDays(order?.pedidoPrazoEntrega) ||
    parsePositiveDays(parsedTrackingParams?.prazoEntrega) ||
    parsePositiveDays(parsedTrackingParams?.prazoDias);
  const baseDate = safeDate(order?.dataHora) || safeDate(order?.dataPreVenda);
  return projectDateFromDays(baseDate, prazoDias);
};

const mapMagazordStatusToInternal = (statusCode: number | null, statusText: string | null) => {
  const canceledStatuses = new Set([2, 13, 24]);
  const returnedStatuses = new Set([20, 21, 31]);
  const failureStatuses = new Set([16, 17, 22, 25, 28]);

  if (statusCode !== null) {
    if (statusCode === 8) return 'DELIVERED';
    if (statusCode === 7) return 'SHIPPED';
    if (statusCode === 6 || statusCode === 15 || statusCode === 23) return 'CREATED';
    if (canceledStatuses.has(statusCode)) return 'CANCELED';
    if (returnedStatuses.has(statusCode)) return 'RETURNED';
    if (failureStatuses.has(statusCode)) return 'FAILURE';
  }

  const normalized = normalizeComparableText(statusText).toUpperCase();
  if (!normalized) return 'PENDING';
  if (normalized.includes('ENTREG')) return 'DELIVERED';
  if (normalized.includes('TRANSPORTE')) return 'SHIPPED';
  if (normalized.includes('FATUR') || normalized.includes('SEPARA') || normalized.includes('EMBAL')) {
    return 'CREATED';
  }
  if (normalized.includes('CANCEL')) return 'CANCELED';
  if (normalized.includes('DEVOLV') || normalized.includes('REVERSA')) return 'RETURNED';
  if (
    normalized.includes('FRAUDE') ||
    normalized.includes('CHARGEBACK') ||
    normalized.includes('DISPUTA') ||
    normalized.includes('PROBLEMA')
  ) {
    return 'FAILURE';
  }

  return 'PENDING';
};

const pickFirstString = (...values: unknown[]) => {
  for (const value of values) {
    const normalized = safeString(value);
    if (normalized) {
      return normalized;
    }
  }

  return null;
};

const buildTrackingHistory = (
  order: any,
  mappedStatus: string,
  city: string | null,
  state: string | null,
) => {
  const sourceHistory = Array.isArray(order?.arrayPedidoRastreio)
    ? order.arrayPedidoRastreio
    : [];
  const fallbackDate =
    safeDate(order?.dataHoraUltimaAlteracaoSituacao) ||
    safeDate(order?.dataHora) ||
    new Date();

  if (sourceHistory.length > 0) {
    return sourceHistory.map((event: any) => {
      const eventStatusCode = parseOrderStatusCode(
        event?.pedidoRastreioSituacao || event?.situacao,
      );
      const eventStatusText = pickFirstString(
        event?.pedidoRastreioSituacaoDescricao,
        event?.situacaoDescricao,
        event?.descricao,
      );

      return {
        status: mapMagazordStatusToInternal(eventStatusCode, eventStatusText),
        description:
          eventStatusText ||
          `Atualizacao de rastreio Magazord (situacao ${eventStatusCode ?? '-'})`,
        date: safeDate(event?.dataHora || event?.createdAt || event?.updatedAt) || fallbackDate,
        city: pickFirstString(event?.cidadeNome, event?.cidade, city),
        state: pickFirstString(event?.estadoSigla, event?.estado, state),
      };
    });
  }

  return [
    {
      status: mappedStatus,
      description: `Pedido Magazord em status ${pickFirstString(order?.pedidoSituacaoDescricao) || mappedStatus}.`,
      date: fallbackDate,
      city,
      state,
    },
  ];
};

const buildCleanParams = (params: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(params).filter(([, value]) => value !== undefined && value !== null && value !== ''),
  );

const resolveCustomerDocument = (documentValue: unknown) => {
  const digits = normalizeDigits(documentValue);
  if (digits.length === 11) {
    return { cpf: digits, cnpj: null };
  }

  if (digits.length === 14) {
    return { cpf: null, cnpj: digits };
  }

  return { cpf: null, cnpj: null };
};

const normalizeBaseUrl = (value: unknown) => {
  const normalized = normalizeText(value);
  return normalized ? normalized.replace(/\/+$/, '') : null;
};

export class MagazordApiService {
  constructor(private readonly companyId: string) {}

  async getConfiguration(): Promise<MagazordConfiguration> {
    const companyResult = await dbQuery<any>(
      `
        SELECT
          c."magazordIntegrationEnabled",
          c."magazordApiBaseUrl",
          c."magazordApiUser",
          c."magazordApiPassword"
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
      integrationEnabled: company.magazordIntegrationEnabled !== false,
      apiBaseUrl: normalizeBaseUrl(company.magazordApiBaseUrl),
      apiUser: safeString(company.magazordApiUser),
      apiPassword: safeString(company.magazordApiPassword),
    };
  }

  private async getClient(): Promise<{
    client: AxiosInstance;
    configuration: MagazordConfiguration;
  }> {
    const configuration = await this.getConfiguration();

    if (!configuration.integrationEnabled) {
      throw new Error('A integracao Magazord esta desativada para esta empresa.');
    }

    if (!configuration.apiBaseUrl || !configuration.apiUser || !configuration.apiPassword) {
      throw new Error('Magazord sem configuracao completa de URL, usuario e senha.');
    }

    const client = axios.create({
      baseURL: configuration.apiBaseUrl,
      timeout: 45_000,
      auth: {
        username: configuration.apiUser,
        password: configuration.apiPassword,
      },
      headers: {
        'Content-Type': 'application/json',
      },
    });

    return {
      client,
      configuration,
    };
  }

  async getConnectionStatus(): Promise<MagazordConnectionStatus> {
    const configuration = await this.getConfiguration();

    if (!configuration.integrationEnabled) {
      return {
        configured: false,
        authorized: false,
        apiBaseUrl: configuration.apiBaseUrl,
        message: 'Integracao Magazord desativada para esta empresa.',
      };
    }

    if (!configuration.apiBaseUrl || !configuration.apiUser || !configuration.apiPassword) {
      return {
        configured: false,
        authorized: false,
        apiBaseUrl: configuration.apiBaseUrl,
        message: 'Magazord sem configuracao completa de URL, usuario e senha.',
      };
    }

    try {
      await this.listOrders({ limit: 1, page: 1 });
      return {
        configured: true,
        authorized: true,
        apiBaseUrl: configuration.apiBaseUrl,
        message: 'Integracao Magazord online.',
      };
    } catch (error) {
      return {
        configured: true,
        authorized: false,
        apiBaseUrl: configuration.apiBaseUrl,
        message:
          error instanceof Error
            ? error.message
            : 'Falha ao validar conexao com a Magazord.',
      };
    }
  }

  async listOrders(params: {
    limit?: number;
    page?: number;
    orderDirection?: 'asc' | 'desc';
    situacao?: string | string[];
    codigoMarketplace?: string;
    createdAfter?: string;
    createdBefore?: string;
    updatedAfter?: string;
    updatedBefore?: string;
  } = {}): Promise<MagazordOrdersResponse> {
    const { client } = await this.getClient();

    try {
      const situacaoParam = Array.isArray(params.situacao)
        ? params.situacao.filter(Boolean).join(',')
        : params.situacao;
      const createdAfter = toMagazordDateFilter(params.createdAfter);
      const createdBefore = toMagazordDateFilter(params.createdBefore);
      const updatedAfter = toMagazordDateFilter(params.updatedAfter);
      const updatedBefore = toMagazordDateFilter(params.updatedBefore);

      const response = await client.get('/v2/site/pedido', {
        params: buildCleanParams({
          limit: params.limit ?? 100,
          page: params.page ?? 1,
          orderDirection: params.orderDirection || 'asc',
          ...(situacaoParam ? { situacao: situacaoParam } : {}),
          codigoMarketplace: params.codigoMarketplace,
          ...(createdAfter ? { 'dataHora[gte]': createdAfter } : {}),
          ...(createdBefore ? { 'dataHora[lte]': createdBefore } : {}),
          ...(updatedAfter
            ? {
                'dataHoraUltimaAlteracaoSituacao[gte]': updatedAfter,
              }
            : {}),
          ...(updatedBefore
            ? {
                'dataHoraUltimaAlteracaoSituacao[lte]': updatedBefore,
              }
            : {}),
        }),
      });

      return response.data;
    } catch (error: any) {
      const details =
        error?.response?.data?.message ||
        error?.response?.data?.error ||
        error?.message ||
        'Erro desconhecido na API Magazord.';
      throw new Error(`Erro na API Magazord: ${details}`);
    }
  }

  async getOrderByCode(orderCode: string) {
    const { client } = await this.getClient();

    try {
      const response = await client.get(`/v2/site/pedido/${encodeURIComponent(orderCode)}`);
      return unwrapOrderPayload(response.data);
    } catch (error: any) {
      const details =
        error?.response?.data?.message ||
        error?.response?.data?.error ||
        error?.message ||
        'Erro desconhecido na API Magazord.';
      throw new Error(`Erro ao consultar pedido ${orderCode} na Magazord: ${details}`);
    }
  }

  async getOrderTrackingByCode(orderCode: string) {
    const { client } = await this.getClient();

    try {
      const response = await client.get(
        `/v2/site/pedido/${encodeURIComponent(orderCode)}/rastreio`,
      );
      const unwrapped = unwrapOrderPayload(response.data);
      const items = normalizeRastreioItems(unwrapped?.items || unwrapped);
      return items;
    } catch (error) {
      return [];
    }
  }

  private async loadDetailedOrders(
    orders: any[],
    hooks?: {
      onLog?: (message: string) => void;
      shouldCancel?: () => boolean;
    },
  ) {
    const entries = orders
      .map((order) => unwrapOrderPayload(order))
      .map((order) => ({
        raw: order,
        code: extractOrderCode(order),
      }))
      .filter((entry) => Boolean(entry.code)) as Array<{ raw: any; code: string }>;

    if (entries.length === 0) {
      return orders.map((order) => unwrapOrderPayload(order));
    }

    const detailed: any[] = [];

    for (let start = 0; start < entries.length; start += DETAIL_BATCH_SIZE) {
      if (hooks?.shouldCancel?.()) {
        throw new SyncCancellationError();
      }

      const chunk = entries.slice(start, start + DETAIL_BATCH_SIZE);
      const chunkResult = await Promise.all(
        chunk.map(async (entry) => {
          try {
            const detail = await this.getOrderByCode(entry.code);
            const trackingItems = await this.getOrderTrackingByCode(entry.code);
            const merged = {
              ...entry.raw,
              ...unwrapOrderPayload(detail),
            };

            if (trackingItems.length > 0) {
              merged.arrayPedidoRastreio = trackingItems;
            }

            return merged;
          } catch (error) {
            hooks?.onLog?.(
              `Falha ao carregar detalhe do pedido ${entry.code} na Magazord; usando dados resumidos da listagem.`,
            );
            return unwrapOrderPayload(entry.raw);
          }
        }),
      );

      detailed.push(...chunkResult);
    }

    return detailed;
  }

  async syncAllOrders(
    params: {
      situacao?: string | string[];
      createdAfter?: string;
      createdBefore?: string;
      updatedAfter?: string;
      updatedBefore?: string;
    },
    hooks?: {
      onLog?: (message: string) => void;
      onOrdersBatch?: (orders: any[]) => Promise<void> | void;
      shouldCancel?: () => boolean;
    },
  ): Promise<number> {
    const pageSize = 100;
    let page = 1;
    let importedOrdersCount = 0;

    while (true) {
      if (hooks?.shouldCancel?.()) {
        throw new SyncCancellationError();
      }

      hooks?.onLog?.(
        `Buscando pagina ${page} da Magazord${params.situacao ? ` para situacao "${Array.isArray(params.situacao) ? params.situacao.join(',') : params.situacao}"` : ''}.`,
      );

      const response = await this.listOrders({
        limit: pageSize,
        page,
        orderDirection: 'asc',
        situacao: params.situacao,
        createdAfter: params.createdAfter,
        createdBefore: params.createdBefore,
        updatedAfter: params.updatedAfter,
        updatedBefore: params.updatedBefore,
      });

      const data = response?.data || {};
      const listOrders = Array.isArray(data.items) ? data.items : [];

      if (listOrders.length === 0) {
        break;
      }

      if (hooks?.shouldCancel?.()) {
        throw new SyncCancellationError();
      }

      const detailedOrders = await this.loadDetailedOrders(listOrders, {
        onLog: hooks?.onLog,
        shouldCancel: hooks?.shouldCancel,
      });
      await hooks?.onOrdersBatch?.(detailedOrders);
      importedOrdersCount += detailedOrders.length;

      const hasMore = Boolean(data.has_more);
      const totalPages = Number(data.total_pages || 0);
      const currentPage = Number(data.page || page);

      if (!hasMore) {
        break;
      }

      page = currentPage + 1;

      if (totalPages > 0 && page > totalPages) {
        break;
      }
    }

    return importedOrdersCount;
  }

  mapMagazordOrderToSystem(magazordOrder: any): any {
    const order = unwrapOrderPayload(magazordOrder);
    const document = resolveCustomerDocument(order?.pessoaCpfCnpj);
    const pedidoSituacaoCodigo = parseOrderStatusCode(
      order?.pedidoSituacao ?? order?.situacao,
    );
    const pedidoSituacaoDescricao = pickFirstString(
      order?.pedidoSituacaoDescricao,
      order?.pedidoSituacaoDescricaoDetalhada,
      order?.situacaoDescricao,
    );
    const mappedStatus = mapMagazordStatusToInternal(
      pedidoSituacaoCodigo,
      pedidoSituacaoDescricao,
    );
    const city = pickFirstString(order?.cidadeNome, order?.cidade);
    const state = pickFirstString(order?.estadoSigla, order?.estado);
    const shippingDate =
      safeDate(order?.dataHoraUltimaAlteracaoSituacao) ||
      safeDate(order?.dataHora);
    const estimatedDeliveryDate = extractEstimatedDeliveryDateFromOrder(order);
    const salesChannelParts = [
      'Magazord',
      pickFirstString(order?.marketplaceNome),
      pickFirstString(order?.lojaDoMarketplaceNome),
    ].filter(Boolean);
    const orderNumber = pickFirstString(
      order?.codigo,
      order?.id,
      order?.codigoMarketplace,
    );
    const trackingCode = extractTrackingCodeFromOrder(order);
    const trackingUrl = extractTrackingUrlFromOrder(order);
    const invoiceNumber = extractInvoiceNumberFromOrder(order);
    const invoiceAccessKey = pickFirstString(
      order?.notaFiscalChave,
      order?.notaFiscalChaveAcesso,
      order?.chaveAcessoNfe,
      order?.nfeChave,
      order?.chaveAcesso,
    );
    const invoiceXmlUrl = pickFirstString(
      order?.notaFiscalXmlUrl,
      order?.xmlNotaFiscalUrl,
      order?.urlXmlNotaFiscal,
      order?.linkXmlNotaFiscal,
    );
    const freightType = extractFreightTypeFromOrder(order);
    const normalizedTrackingItems = normalizeRastreioItems(order?.arrayPedidoRastreio);

    if (!orderNumber) {
      throw new Error('Pedido Magazord sem identificador utilizavel para importacao.');
    }

    return {
      orderNumber,
      invoiceNumber,
      invoiceAccessKey,
      invoiceXmlUrl,
      trackingCode,
      customerName: pickFirstString(order?.pessoaNome, order?.nomeDestinatario) || 'Desconhecido',
      corporateName: document.cnpj ? pickFirstString(order?.pessoaNome) : null,
      cpf: document.cpf,
      cnpj: document.cnpj,
      phone: pickFirstString(
        order?.pessoaTelefone,
        order?.telefone,
      ),
      mobile: pickFirstString(
        order?.pessoaCelular,
        order?.pessoaTelefone,
      ),
      salesChannel: salesChannelParts.join(' - ') || 'Magazord',
      freightType,
      freightValue: safeNumber(order?.valorFrete) || 0,
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
      shippingDate: shippingDate || safeDate(order?.dataHora) || new Date(),
      address: pickFirstString(order?.logradouro, order?.endereco) || '',
      number: pickFirstString(order?.numero) || '',
      complement: pickFirstString(order?.complemento),
      neighborhood: pickFirstString(order?.bairro) || '',
      city: city || '',
      state: state || '',
      zipCode: normalizeDigits(pickFirstString(order?.cep) || ''),
      totalValue: safeNumber(order?.valorTotalFinal ?? order?.valorTotal) || 0,
      recipient: pickFirstString(order?.nomeDestinatario, order?.pessoaNome),
      maxShippingDeadline: estimatedDeliveryDate,
      estimatedDeliveryDate,
      carrierEstimatedDeliveryDate: estimatedDeliveryDate,
      status: mappedStatus,
      isDelayed: false,
      apiRawPayload: {
        ...order,
        trackingUrl,
        trackingSource: 'MAGAZORD',
        trackingItemsCount: normalizedTrackingItems.length,
        extractedInvoiceNumber: invoiceNumber,
        extractedFreightType: freightType,
        extractedEstimatedDeliveryDate: estimatedDeliveryDate
          ? estimatedDeliveryDate.toISOString()
          : null,
        source: 'MAGAZORD',
      },
      trackingHistory: buildTrackingHistory(
        {
          ...order,
          arrayPedidoRastreio: normalizedTrackingItems,
        },
        mappedStatus,
        city,
        state,
      ),
    };
  }
}
