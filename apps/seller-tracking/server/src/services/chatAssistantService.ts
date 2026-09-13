import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { dbQuery } from '../lib/db';
import { OrderStatus } from '../types/orderStatus';
import { TrackingService } from './trackingService';
import { importOrdersForCompany } from './orderImportService';
import { AnymarketApiService } from './anymarketApiService';
import { TrayApiService } from './trayApiService';
import { MagazordApiService } from './magazordApiService';
import { JetApiService } from './jetApiService';
import { notificationService } from './notificationService';
import { getPublicBaseUrl } from '../utils/publicBaseUrl';

const CLOSED_STATUSES: OrderStatus[] = [
  OrderStatus.DELIVERED,
  OrderStatus.FAILURE,
  OrderStatus.RETURNED,
  OrderStatus.CANCELED,
  OrderStatus.CHANNEL_LOGISTICS,
];

const STATUS_LABELS: Record<OrderStatus, string> = {
  PENDING: 'Pendente',
  CREATED: 'Criado',
  SHIPPED: 'Em transito',
  DELIVERY_ATTEMPT: 'Saiu para entrega',
  DELIVERED: 'Entregue',
  FAILURE: 'Falha na entrega',
  RETURNED: 'Devolvido',
  CANCELED: 'Cancelado',
  CHANNEL_LOGISTICS: 'Logistica do canal',
};

const STATUS_SUMMARY_ORDER: OrderStatus[] = [
  OrderStatus.PENDING,
  OrderStatus.CREATED,
  OrderStatus.SHIPPED,
  OrderStatus.DELIVERY_ATTEMPT,
  OrderStatus.DELIVERED,
  OrderStatus.FAILURE,
  OrderStatus.RETURNED,
  OrderStatus.CANCELED,
  OrderStatus.CHANNEL_LOGISTICS,
];

const OPTION_MATCH_STOPWORDS = new Set([
  'da',
  'de',
  'do',
  'das',
  'dos',
  'e',
  'em',
  'para',
  'com',
  'pela',
  'pelos',
  'pelas',
  'por',
  'transportadora',
  'transportadoras',
  'transporte',
  'transportes',
  'express',
  'log',
  'logistica',
  'logistics',
  'marketplace',
  'marketplaces',
  'canal',
  'canais',
  'pedidos',
  'pedido',
  'status',
]);

type MatchedFilter = {
  status?: OrderStatus;
  statusSummary?: boolean;
  delayedKind?: 'carrier' | 'platform';
  noMovementDays?: number;
  carrierName?: string | null;
  salesChannel?: string | null;
  period?: {
    label: string;
    start: Date;
    endExclusive: Date;
  } | null;
};

type StructuredResult = {
  handled: boolean;
  text?: string;
  actions?: StructuredAction[];
};

type StructuredAction = {
  label: string;
  value: string;
  style?: 'primary' | 'secondary' | 'danger';
};

type PendingCarrierDeleteOperation = {
  key: string;
  companyId: string;
  userId: string;
  createdAt: number;
  expiresAt: number;
  carriers: string[];
  countsByCarrier: Array<{
    carrierName: string;
    total: number;
  }>;
};

type TrackingStatusSyncJob = {
  key: string;
  companyId: string;
  status?: OrderStatus;
  label: string;
  total: number;
  processed: number;
  success: number;
  failed: number;
  startedAt: number;
};

type ConversationMessage = {
  role?: string;
  text?: string;
  content?: string;
};

const normalizeText = (value: unknown) =>
  String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

const getMatchTokens = (value: unknown) =>
  normalizeText(value)
    .split(' ')
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !OPTION_MATCH_STOPWORDS.has(token));

const scoreOptionMatch = (option: string, normalizedInput: string) => {
  const normalizedOption = normalizeText(option);
  if (!normalizedOption) {
    return 0;
  }

  let score = 0;

  if (normalizedInput === normalizedOption) {
    score += 1000;
  }

  if (normalizedInput.includes(normalizedOption)) {
    score += 700;
  }

  if (
    normalizedInput.length >= 3 &&
    normalizedOption.includes(normalizedInput)
  ) {
    score += 550;
  }

  const optionTokens = getMatchTokens(normalizedOption);
  const inputTokens = getMatchTokens(normalizedInput);

  let sharedTokens = 0;
  let longestSharedTokenLength = 0;

  for (const optionToken of optionTokens) {
    const matchedToken = inputTokens.find(
      (inputToken) =>
        inputToken === optionToken ||
        inputToken.includes(optionToken) ||
        optionToken.includes(inputToken),
    );

    if (!matchedToken) {
      continue;
    }

    sharedTokens += 1;
    longestSharedTokenLength = Math.max(
      longestSharedTokenLength,
      Math.min(matchedToken.length, optionToken.length),
    );
  }

  if (sharedTokens > 0) {
    score += sharedTokens * 120 + longestSharedTokenLength * 10;

    if (sharedTokens === optionTokens.length && optionTokens.length > 0) {
      score += 180;
    }
  }

  return score;
};

const hasStatusHint = (normalized: string) =>
  STATUS_MATCHERS.some((matcher) =>
    matcher.phrases.some((phrase) => normalized.includes(phrase)),
  );

const hasDelayHint = (normalized: string) =>
  normalized.includes('atras') ||
  normalized.includes('em atraso') ||
  normalized.includes('transportadora') ||
  normalized.includes('plataforma');

const hasGenericDelayTerm = (normalized: string) =>
  normalized.includes('atrasado') ||
  normalized.includes('atrasados') ||
  normalized.includes('em atraso') ||
  normalized.includes('pedidos atrasados');

const hasExplicitPlatformDelayHint = (normalized: string) =>
  normalized.includes('atraso plataforma') ||
  normalized.includes('atrasados plataforma') ||
  normalized.includes('atrasado plataforma') ||
  normalized.includes('em atraso da plataforma') ||
  normalized.includes('em atraso plataforma') ||
  (normalized.includes('plataforma') && hasGenericDelayTerm(normalized));

const hasExplicitCarrierDelayHint = (normalized: string) =>
  normalized.includes('atraso transportadora') ||
  normalized.includes('atrasados transportadora') ||
  normalized.includes('atrasado transportadora') ||
  normalized.includes('atrasados pela') ||
  normalized.includes('atrasado pela') ||
  normalized.includes('atrasados por') ||
  normalized.includes('atrasado por') ||
  (normalized.includes('transportadora') && hasGenericDelayTerm(normalized));

const isAmbiguousDelayRequest = (normalized: string, carrierName?: string | null) =>
  hasGenericDelayTerm(normalized) &&
  !hasExplicitPlatformDelayHint(normalized) &&
  !hasExplicitCarrierDelayHint(normalized) &&
  !carrierName;

const hasNoMovementHint = (normalized: string) =>
  normalized.includes('sem movimentacao') ||
  normalized.includes('sem movimento') ||
  normalized.includes('sem atualizacao');

const hasPeriodHint = (normalized: string) =>
  normalized.includes('hoje') ||
  normalized.includes('ontem') ||
  /(?:nos\s+)?(?:ultimos|uiltimos|ultimas|ultimas)\s+\d+\s*dias?/.test(normalized);

const hasOperationalContextHint = (normalized: string) =>
  normalized.includes('pedido') ||
  normalized.includes('pedidos') ||
  normalized.includes('nf') ||
  normalized.includes('nfs') ||
  normalized.includes('nota fiscal') ||
  normalized.includes('transportadora') ||
  normalized.includes('marketplace') ||
  normalized.includes('canal');

const hasFilterLikeIntent = (normalized: string) =>
  (hasStatusHint(normalized) || hasDelayHint(normalized) || hasNoMovementHint(normalized)) &&
  (hasPeriodHint(normalized) ||
    hasOperationalContextHint(normalized) ||
    normalized.includes('pela ') ||
    normalized.includes('da ') ||
    normalized.includes('do '));

const hasStatusSummaryHint = (normalized: string) =>
  normalized.includes('por status') ||
  normalized.includes('status geral') ||
  normalized.includes('resumo por status') ||
  (normalized.includes('status') &&
    (normalized.includes('pedido') ||
      normalized.includes('pedidos') ||
      normalized.includes('relatorio')));

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const escapeCsv = (value: unknown) => {
  const text = String(value ?? '');
  if (/[",;\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
};

const formatDate = (value: Date | null | undefined) =>
  value ? new Date(value).toLocaleString('pt-BR') : '-';

const formatDateOnly = (value: Date | null | undefined) =>
  value ? new Date(value).toLocaleDateString('pt-BR') : '-';

const normalizeDigits = (value: unknown) =>
  String(value || '')
    .replace(/\D/g, '')
    .trim();

const normalizeAlphaNumeric = (value: unknown) =>
  String(value || '')
    .replace(/[^A-Za-z0-9]/g, '')
    .toUpperCase()
    .trim();

const safeString = (value: unknown) => {
  const normalized = String(value || '').trim();
  return normalized || null;
};

const safeDate = (value: unknown) => {
  if (!value) {
    return null;
  }

  const parsed = new Date(value as string | number | Date);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const buildIntelipostTrackingUrl = (
  clientId: string | null | undefined,
  orderNumber: string | null | undefined,
) => {
  const normalizedClientId = normalizeDigits(clientId);
  const normalizedOrderNumber = safeString(orderNumber);

  if (!normalizedClientId || !normalizedOrderNumber) {
    return null;
  }

  return `https://status.ondeestameupedido.com/tracking/${normalizedClientId}/${encodeURIComponent(normalizedOrderNumber)}`;
};

const looksLikeXmlIdentifier = (value: unknown) => {
  const normalized = normalizeAlphaNumeric(value);
  return Boolean(
    normalized &&
      (/^\d{44}$/.test(normalized) ||
        (normalized.length >= 20 && /[A-Z]/.test(normalized) && /\d/.test(normalized))),
  );
};

const looksLikeCorreiosObjectCode = (value: unknown) =>
  /^[A-Z]{2}\d{9}[A-Z]{2}$/.test(normalizeAlphaNumeric(value));

const TRACKING_INTENT_TERMS = [
  'rastreio',
  'rastreamento',
  'rastrear',
  'rastreie',
  'rastrei',
  'rastreia',
  'tracking',
  'acompanhar',
  'acompanhe',
  'acompanha',
  'consulta',
  'consultar',
];

type TrackingLookupKind =
  | 'invoice'
  | 'order'
  | 'xml'
  | 'tracking'
  | 'customer'
  | 'generic';

type TrackingLookupRequest = {
  kind: TrackingLookupKind;
  value: string;
  label: string;
};

const stripPoliteTail = (value: string) =>
  value
    .replace(/\b(?:pra mim|para mim|pra mi|para mi|por favor|pfv|pls|please|ai|a[ií])\b.*$/i, '')
    .replace(/[?!.,;:]+$/g, '')
    .trim();

const hasTrackingIntent = (text: string) => {
  const normalized = normalizeText(text);
  return TRACKING_INTENT_TERMS.some((term) => normalized.includes(term));
};

const hasTrackingLinkIntent = (text: string) => {
  const normalized = normalizeText(text);
  return (
    hasTrackingIntent(text) &&
    [
      'abrir',
      'abre',
      'abri',
      'link',
      'url',
      'abrir rastreio',
      'me manda o link',
      'me envie o link',
      'manda o link',
    ].some((term) => normalized.includes(term))
  );
};

const extractTrackingLookupRequest = (text: string): TrackingLookupRequest | null => {
  const rawText = String(text || '').trim();
  const normalized = normalizeText(rawText);

  if (!hasTrackingIntent(rawText)) {
    return null;
  }

  const patternMatches: Array<{
    kind: TrackingLookupKind;
    label: string;
    patterns: RegExp[];
  }> = [
    {
      kind: 'invoice',
      label: 'NF',
      patterns: [
        /(?:nota fiscal|nota|nf)\s*(?:numero|n|no|#|:)?\s*([A-Za-z0-9./-]{3,})/i,
      ],
    },
    {
      kind: 'order',
      label: 'pedido',
      patterns: [
        /(?:pedido)\s*(?:numero|n|no|#|:)?\s*([A-Za-z0-9./-]{3,})/i,
      ],
    },
    {
      kind: 'xml',
      label: 'XML',
      patterns: [
        /(?:xml|chave xml|chave da nota|chave de acesso|chave)\s*(?:numero|n|no|#|:)?\s*([A-Za-z0-9-]{20,})/i,
      ],
    },
    {
      kind: 'tracking',
      label: 'rastreio',
      patterns: [
        /(?:codigo de rastreio|codigo de envio|objeto|rastreio|tracking)\s*(?:numero|n|no|#|:)?\s*([A-Za-z0-9./-]{6,})/i,
      ],
    },
  ];

  for (const matcher of patternMatches) {
    for (const pattern of matcher.patterns) {
      const match = rawText.match(pattern);
      const value = stripPoliteTail(match?.[1] || '');
      if (value) {
        return {
          kind: matcher.kind,
          value,
          label: matcher.label,
        };
      }
    }
  }

  const customerMatch = rawText.match(
    /(?:do|da|de)?\s*cliente\s+(.+)$/i,
  );
  const customerValue = stripPoliteTail(customerMatch?.[1] || '');
  if (customerValue) {
    return {
      kind: 'customer',
      value: customerValue,
      label: 'cliente',
    };
  }

  const tokenCandidates = rawText.match(
    /[A-Za-z]{2}\d{9}[A-Za-z]{2}|\d{4,}|[A-Za-z0-9-]{20,}/g,
  );
  const candidate = tokenCandidates?.[tokenCandidates.length - 1] || '';
  const cleanedCandidate = stripPoliteTail(candidate);

  if (!cleanedCandidate) {
    return null;
  }

  if (looksLikeXmlIdentifier(cleanedCandidate)) {
    return { kind: 'xml', value: cleanedCandidate, label: 'XML' };
  }

  if (looksLikeCorreiosObjectCode(cleanedCandidate)) {
    return { kind: 'tracking', value: cleanedCandidate, label: 'rastreio' };
  }

  if (normalizeDigits(cleanedCandidate)) {
    return { kind: 'generic', value: cleanedCandidate, label: 'identificador' };
  }

  if (normalized.includes('cliente')) {
    return { kind: 'customer', value: cleanedCandidate, label: 'cliente' };
  }

  return null;
};

const mapTrackingEventsToHistory = (trackingEvents: any[] | undefined) =>
  Array.isArray(trackingEvents)
    ? trackingEvents.map((event) => ({
        status: safeString(event?.status) || 'UNKNOWN',
        description: safeString(event?.description) || 'Evento de rastreamento',
        date: safeDate(event?.eventDate || event?.date) || new Date(),
        city: safeString(event?.city) || '',
        state: safeString(event?.state) || '',
      }))
    : [];

const getStoredTrackingUrl = (order: { trackingUrl?: string | null; apiRawPayload?: any }) =>
  safeString(order.trackingUrl) ||
  safeString(order.apiRawPayload?.manualTrackingUrl) ||
  safeString(order.apiRawPayload?.trackingUrl) ||
  safeString(order.apiRawPayload?.logistic_provider?.live_tracking_url) ||
  safeString(order.apiRawPayload?.tracking_url) ||
  null;

const resolveTrackingSourceLabel = (order: {
  trackingSourceLabel?: string | null;
  trackingCode?: string | null;
  apiRawPayload?: any;
}) => {
  if (order.trackingSourceLabel) {
    return order.trackingSourceLabel;
  }

  const source = String(order.apiRawPayload?.source || '').toUpperCase();
  const lookupMode = String(order.apiRawPayload?.lookupMode || '').toUpperCase();
  const trackingUrl = String(getStoredTrackingUrl(order) || '');

  if (source === 'SSW' || /ssw\.inf\.br/i.test(trackingUrl)) {
    if (lookupMode === 'XML_KEY') {
      return 'SSW com Codigo XML';
    }
    if (lookupMode === 'TRACKING_CODE') {
      return 'SSW com codigo envio/NF';
    }
    return 'SSW com NF';
  }

  if (source === 'CORREIOS' || /correios/i.test(trackingUrl)) {
    return 'Correios';
  }

  if (
    source === 'INTELIPOST' ||
    /ondeestameupedido\.com|intelipost/i.test(trackingUrl)
  ) {
    return 'Intelipost';
  }

  return 'Nao identificado';
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
    return { cpf: null, cnpj: normalized };
  }

  return { cpf: normalized, cnpj: null };
};

const mapIntelipostStatusToOrderStatus = (value: string) => {
  const normalized = normalizeText(value).toUpperCase();

  if (
    normalized.includes('SAIU PARA ENTREGA') ||
    normalized.includes('DELIVERY_ATTEMPT') ||
    normalized.includes('TO_BE_DELIVERED')
  ) {
    return OrderStatus.DELIVERY_ATTEMPT;
  }

  if (normalized.includes('ENTREGUE') || normalized.includes('DELIVERED')) {
    return OrderStatus.DELIVERED;
  }

  if (
    normalized.includes('EM TRANSITO') ||
    normalized.includes('TRANSITO') ||
    normalized.includes('SHIPPED') ||
    normalized.includes('IN TRANSIT')
  ) {
    return OrderStatus.SHIPPED;
  }

  if (
    normalized.includes('CRIADO') ||
    normalized.includes('CREATED') ||
    normalized.includes('NEW')
  ) {
    return OrderStatus.CREATED;
  }

  if (
    normalized.includes('FALHA') ||
    normalized.includes('FAILURE') ||
    normalized.includes('CLARIFY_DELIVERY_FAIL')
  ) {
    return OrderStatus.FAILURE;
  }

  return OrderStatus.PENDING;
};

const getReportsDir = () =>
  path.join(__dirname, '../../public/reports/chat-insights');

const STATUS_MATCHERS: Array<{ phrases: string[]; status: OrderStatus; title: string }> = [
  {
    phrases: ['falha na entrega', 'falhas na entrega', 'falha de entrega'],
    status: OrderStatus.FAILURE,
    title: 'pedidos com falha na entrega',
  },
  {
    phrases: ['saiu para entrega', 'em rota', 'rota de entrega'],
    status: OrderStatus.DELIVERY_ATTEMPT,
    title: 'pedidos que sairam para entrega',
  },
  {
    phrases: ['em transito', 'transito', 'em transporte'],
    status: OrderStatus.SHIPPED,
    title: 'pedidos em transito',
  },
  {
    phrases: ['entregue', 'entregues'],
    status: OrderStatus.DELIVERED,
    title: 'pedidos entregues',
  },
  {
    phrases: ['devolvido', 'devolvidos'],
    status: OrderStatus.RETURNED,
    title: 'pedidos devolvidos',
  },
  {
    phrases: ['cancelado', 'cancelados'],
    status: OrderStatus.CANCELED,
    title: 'pedidos cancelados',
  },
  {
    phrases: ['logistica do canal'],
    status: OrderStatus.CHANNEL_LOGISTICS,
    title: 'pedidos em logistica do canal',
  },
  {
    phrases: ['pendente', 'pendentes'],
    status: OrderStatus.PENDING,
    title: 'pedidos pendentes',
  },
  {
    phrases: ['criado', 'criados'],
    status: OrderStatus.CREATED,
    title: 'pedidos criados',
  },
];

const isStructuredIntent = (text: string) => {
  const normalized = normalizeText(text);

  return (
    [
    'relatorio',
    'relatorio com',
    'me envie',
    'me envia',
    'gere um relatorio',
    'gerar relatorio',
    'monta um relatorio',
    'exporta',
    'csv',
    'html',
    'quantos',
    'quantidade',
    'qtd',
    'total de pedidos',
    'numero de pedidos',
    'lista de pedidos',
    'listar pedidos',
    'mostrar pedidos',
    'pedidos monitorados',
    'pedidos especificos',
    'pedido especifico',
    'me avise sobre',
    'me avise sobre o pedido',
    'me avise sobre a nf',
    'inclua os pedidos',
    'inclua as nfs',
    'inclua as nf',
    'adicione os pedidos',
    'monitorar pedido',
    'monitorar nf',
    'monitore',
    'monitora',
    'monitoramento',
    'monitore o pedido',
    'monitore a nf',
    'monitora o pedido',
    'monitora a nf',
    'arquivar pedido',
    'arquivar nf',
    'arquive pedido',
    'arquive nf',
    'desarquivar pedido',
    'desarquivar nf',
      'excluir pedidos',
      'exclua os pedidos',
      'apagar pedidos',
      'deletar pedidos',
      'remover pedidos',
      'atualizar o rastreio',
      'atualize o rastreio',
      'sincronizar o rastreio',
      'sincronize o rastreio',
      'sync de rastreio',
      'atualizar status',
      'atualize status',
      'alterar status',
      'altere status',
      'atualizar dados do pedido',
      'atualizar dados dos pedidos',
      'atualizacao completa de pedido',
      'atualizacao completa dos pedidos',
      'atualizar frete',
      'atualize frete',
      'atualizar nota',
      'atualizar xml',
      'sincronizar dados do pedido',
      'sincronizar dados dos pedidos',
      ].some((term) => normalized.includes(term)) || hasFilterLikeIntent(normalized)
  );
};

const MONITORED_IDENTIFIER_STOPWORDS = new Set([
  'inclua',
  'incluir',
  'incluido',
  'incluidos',
  'incluidas',
  'adicione',
  'adicionar',
  'adicionados',
  'adicionadas',
  'pedido',
  'pedidos',
  'pediso',
  'pedisos',
  'nf',
  'nfs',
  'nota',
  'nota fiscal',
  'notas fiscais',
  'lista',
  'monitorada',
  'monitorado',
  'monitorados',
  'monitorar',
  'monitore',
  'monitora',
  'monitoramento',
  'me',
  'avise',
  'sobre',
  'a',
  'ao',
  'aos',
  'na',
  'no',
  'de',
  'do',
  'da',
  'dos',
  'das',
  'e',
  'ou',
  'com',
  'por',
  'favor',
  'para',
  'mim',
  'quando',
  'se',
  'entrar',
  'atraso',
  'atrasado',
  'entregar',
  'entregue',
  'for',
  'status',
  'todos',
  'todas',
]);

const ARCHIVE_IDENTIFIER_STOPWORDS = new Set([
  'arquivar',
  'arquive',
  'arquivo',
  'arquivados',
  'arquivadas',
  'desarquivar',
  'desarquive',
  'desarquivado',
  'desarquivados',
  'pedido',
  'pedidos',
  'pediso',
  'pedisos',
  'nf',
  'nfs',
  'nota',
  'nota fiscal',
  'notas fiscais',
  'as',
  'os',
  'a',
  'o',
  'de',
  'da',
  'do',
  'dos',
  'das',
  'e',
  'ou',
  'por',
  'favor',
  'tais',
  'todos',
  'todas',
  'status',
  'entregar',
  'entregue',
  'entregues',
  'falha',
  'falhas',
  'devolvido',
  'devolvidos',
  'cancelado',
  'cancelados',
  'pendente',
  'pendentes',
  'criado',
  'criados',
  'transito',
  'rota',
]);

const extractOrderIdentifiers = (text: string, stopwords: Set<string>) => {
  const rawText = String(text || '');
  const matches = rawText.match(/[A-Za-z]{2}\d{9}[A-Za-z]{2}|[A-Za-z0-9./-]{2,}/g) || [];

  return Array.from(
    new Set(
      matches
        .map((item) => stripPoliteTail(item))
        .map((item) => item.replace(/^[#:\-.,\s]+|[#:\-.,\s]+$/g, '').trim())
        .filter(Boolean)
        .filter((item) => {
          const normalizedItem = normalizeText(item);
          if (!normalizedItem || stopwords.has(normalizedItem)) {
            return false;
          }

          if (item.length < 2) {
            return false;
          }

          if (/\d/.test(item)) {
            return true;
          }

          return /^[A-Za-z]{4,}$/.test(item);
        }),
    ),
  );
};

const isMonitoredOrderIncludeIntent = (text: string) => {
  const normalized = normalizeText(text);
  const hasActionVerb =
    normalized.includes('inclua') ||
    normalized.includes('incluir') ||
    normalized.includes('adicione') ||
    normalized.includes('adicionar') ||
    normalized.includes('me avise') ||
    normalized.includes('monitorar') ||
    normalized.includes('monitore') ||
    normalized.includes('monitora') ||
    normalized.includes('monitoramento');
  const hasTargetContext =
    normalized.includes('pedido monitorado') ||
    normalized.includes('pedidos monitorados') ||
    normalized.includes('pedido especifico') ||
    normalized.includes('pedidos especificos') ||
    normalized.includes('lista de pedidos') ||
    normalized.includes('lista monitorada') ||
    normalized.includes('nf') ||
    normalized.includes('nota fiscal') ||
    normalized.includes('pedido');

  return hasActionVerb && hasTargetContext;
};

const extractMonitoredIdentifiers = (text: string) => {
  return extractOrderIdentifiers(text, MONITORED_IDENTIFIER_STOPWORDS);
};

const extractArchiveIdentifiers = (text: string) =>
  extractOrderIdentifiers(text, ARCHIVE_IDENTIFIER_STOPWORDS);

const isArchiveIntent = (text: string) => {
  const normalized = normalizeText(text);
  return (
    !normalized.includes('desarquiv') &&
    (normalized.includes('arquivar') || normalized.includes('arquive')) &&
    (normalized.includes('pedido') ||
      normalized.includes('pedidos') ||
      normalized.includes('nf') ||
      normalized.includes('nota fiscal'))
  );
};

const isDeleteByCarrierIntent = (text: string) => {
  const normalized = normalizeText(text);
  const hasDeleteVerb =
    normalized.includes('excluir') ||
    normalized.includes('exclua') ||
    normalized.includes('apagar') ||
    normalized.includes('apague') ||
    normalized.includes('deletar') ||
    normalized.includes('delete') ||
    normalized.includes('remover') ||
    normalized.includes('remova');
  const hasOrderContext =
    normalized.includes('pedido') || normalized.includes('pedidos');
  const hasCarrierContext =
    normalized.includes('transportadora') || normalized.includes('transportadoras');
  return hasDeleteVerb && hasOrderContext && hasCarrierContext;
};

const isArchiveByCarrierIntent = (text: string) => {
  const normalized = normalizeText(text);
  if (normalized.includes('desarquiv')) {
    return false;
  }
  const hasArchiveVerb =
    normalized.includes('arquivar') || normalized.includes('arquive');
  const hasOrderContext =
    normalized.includes('pedido') || normalized.includes('pedidos');
  const hasCarrierContext =
    normalized.includes('transportadora') || normalized.includes('transportadoras');
  return hasArchiveVerb && hasOrderContext && hasCarrierContext;
};

const ORDER_UPDATE_IDENTIFIER_STOPWORDS = new Set([
  'atualizar', 'atualize', 'alterar', 'altere', 'mudar', 'mude',
  'sincronizar', 'sincronize', 'pedido', 'pedidos', 'nf', 'nfs',
  'nota', 'notas', 'fiscal', 'status', 'para', 'como', 'dados',
  'completos', 'completo', 'frete', 'integrador', 'integradora', 'erp',
  'xml', 'chave', 'rastreio', 'tracking', 'enviado', 'despachado',
  'entregue', 'concluido', 'cancelado', 'pendente', 'falha', 'devolvido',
  'em', 'transito', 'rota', 'a', 'o', 'os', 'as', 'de', 'da', 'do',
  'dos', 'das', 'e', 'ou', 'por', 'favor', 'todos', 'todas',
]);

const extractOrderUpdateIdentifiers = (text: string) =>
  extractOrderIdentifiers(text, ORDER_UPDATE_IDENTIFIER_STOPWORDS);

const isManualOrderStatusUpdateIntent = (text: string) => {
  const normalized = normalizeText(text);
  const hasAction = /\b(atualizar|atualize|alterar|altere|mudar|mude)\b/.test(normalized);
  const hasOrderContext = /\b(pedido|pedidos|nf|nfs|nota)\b/.test(normalized) || /\d{3,}/.test(normalized);
  return hasAction && hasOrderContext && normalized.includes('status') &&
    !normalized.includes('rastreio') && !normalized.includes('tracking');
};

const resolveManualOrderStatus = (text: string): OrderStatus | null => {
  const normalized = normalizeText(text);
  const targetMatch = normalized.match(/(?:status(?:\s+dos?\s+pedidos?)?\s+(?:para|como)|(?:para|como)\s+status)\s+(.+)/);
  const target = targetMatch?.[1] || '';

  if (/\b(saiu para entrega|em rota)\b/.test(target)) return OrderStatus.DELIVERY_ATTEMPT;
  if (/\b(entregue|concluido|concluida|concluidos|concluidas)\b/.test(target)) return OrderStatus.DELIVERED;
  if (/\b(falha|falhou|falhado)\b/.test(target)) return OrderStatus.FAILURE;
  if (/\b(devolvido|devolvida|devolvidos|devolvidas)\b/.test(target)) return OrderStatus.RETURNED;
  if (/\b(cancelado|cancelada|cancelados|canceladas)\b/.test(target)) return OrderStatus.CANCELED;
  if (/\b(pendente|aguardando envio)\b/.test(target)) return OrderStatus.PENDING;
  if (/\b(criado|criada)\b/.test(target)) return OrderStatus.CREATED;
  if (/\b(enviado|enviada|despachado|despachada|em transito)\b/.test(target)) return OrderStatus.SHIPPED;
  return null;
};

const isCompleteOrderIntegrationRefreshIntent = (text: string) => {
  const normalized = normalizeText(text);
  const hasAction = /\b(atualizar|atualize|sincronizar|sincronize|revisar|revise)\b/.test(normalized);
  const hasOrderContext = /\b(pedido|pedidos|nf|nfs|nota|notas)\b/.test(normalized) || /\d{3,}/.test(normalized);
  const hasDataContext = /\b(integradora|erp|frete|nota|notas|xml|dados|completos|status)\b/.test(normalized);
  return hasAction && hasOrderContext && hasDataContext &&
    !normalized.includes('rastreio') && !normalized.includes('tracking');
};
const isTrackingSyncByStatusIntent = (text: string) => {
  const normalized = normalizeText(text);
  const hasSyncVerb =
    normalized.includes('atualizar') ||
    normalized.includes('atualize') ||
    normalized.includes('sincronizar') ||
    normalized.includes('sincronize') ||
    normalized.includes('sync');
  const hasTrackingContext =
    normalized.includes('rastreio') || normalized.includes('tracking');
  return hasSyncVerb && hasTrackingContext && normalized.includes('status');
};

const isPositiveConfirmation = (text: string) => {
  const normalized = normalizeText(text);
  return (
    normalized === 'sim' ||
    normalized === 's' ||
    normalized === 'confirmo' ||
    normalized === 'confirmar' ||
    normalized === 'pode' ||
    normalized === 'pode sim' ||
    normalized === 'ok' ||
    normalized === 'ok pode'
  );
};

const isNegativeConfirmation = (text: string) => {
  const normalized = normalizeText(text);
  return (
    normalized === 'nao' ||
    normalized === 'não' ||
    normalized === 'n' ||
    normalized === 'cancelar' ||
    normalized === 'cancela' ||
    normalized === 'cancelado'
  );
};

const isUnarchiveIntent = (text: string) => {
  const normalized = normalizeText(text);
  return (
    normalized.includes('desarquivar') ||
    normalized.includes('desarquive') ||
    normalized.includes('retirar do arquivo') ||
    normalized.includes('tirar do arquivo')
  );
};

const hasBulkArchiveHint = (text: string) => {
  const normalized = normalizeText(text);
  return (
    normalized.includes('todos os pedidos') ||
    normalized.includes('todas as nfs') ||
    normalized.includes('todos as nfs') ||
    normalized.includes('todos os registros') ||
    normalized.includes('todos os itens') ||
    /\bpedidos?\s+(?:entregues?|cancelados?|devolvidos?|pendentes?|criados?)\b/.test(normalized) ||
    /\bnfs?\s+(?:entregues?|canceladas?|devolvidas?|pendentes?|criadas?)\b/.test(normalized)
  );
};

const hasActionableBulkArchiveFilter = (filter: MatchedFilter | null) =>
  Boolean(
    filter &&
      (filter.status ||
        filter.delayedKind ||
        filter.noMovementDays ||
        filter.carrierName ||
        filter.salesChannel),
  );

const inferMonitoredWatchEvents = (text: string) => {
  const normalized = normalizeText(text);

  if (
    normalized.includes('todos os status') ||
    normalized.includes('todos os eventos') ||
    normalized.includes('qualquer status') ||
    normalized.includes('todos os pedidos')
  ) {
    return ['ALL'];
  }

  const watchEvents = new Set<string>();

  if (normalized.includes('atras')) {
    watchEvents.add('ENTERED_DELAY');
  }

  if (normalized.includes('falha')) {
    watchEvents.add('ENTERED_FAILURE');
  }

  if (
    normalized.includes('entregue') ||
    normalized.includes('entregar') ||
    normalized.includes('for entregue')
  ) {
    watchEvents.add('DELIVERED');
  }

  if (normalized.includes('cancel')) {
    watchEvents.add('CANCELED');
  }

  if (
    normalized.includes('despach') ||
    normalized.includes('em transito') ||
    normalized.includes('transito')
  ) {
    watchEvents.add('SHIPPED');
  }

  if (
    normalized.includes('rota') ||
    normalized.includes('saiu para entrega') ||
    normalized.includes('em rota')
  ) {
    watchEvents.add('ROUTE');
  }

  if (
    normalized.includes('mudanca de status') ||
    normalized.includes('mudou de status') ||
    normalized.includes('quando mudar')
  ) {
    watchEvents.add('STATUS_CHANGE');
  }

  return watchEvents.size > 0 ? Array.from(watchEvents) : ['ALL'];
};

const describeWatchEvents = (watchEvents: string[]) => {
  if (!Array.isArray(watchEvents) || watchEvents.length === 0 || watchEvents.includes('ALL')) {
    return 'todos os eventos de status';
  }

  const labels: Record<string, string> = {
    STATUS_CHANGE: 'mudanca de status',
    ENTERED_DELAY: 'entrada em atraso',
    ENTERED_FAILURE: 'falha na entrega',
    DELIVERED: 'entrega',
    CANCELED: 'cancelamento',
    SHIPPED: 'despacho',
    ROUTE: 'entrada em rota',
  };

  return watchEvents
    .map((event) => labels[event] || event.toLowerCase())
    .join(', ');
};

const resolveIntentKind = (text: string) => {
  const normalized = normalizeText(text);

  if (
    normalized.includes('relatorio') ||
    normalized.includes('me envie') ||
    normalized.includes('me envia') ||
    normalized.includes('gere') ||
    normalized.includes('exporta') ||
    normalized.includes('csv') ||
    normalized.includes('html') ||
    normalized.includes('lista de pedidos') ||
    normalized.includes('listar pedidos') ||
    normalized.includes('mostrar pedidos')
  ) {
    return 'report' as const;
  }

  return 'count' as const;
};

const resolvePeriodFilter = (text: string) => {
  const normalized = normalizeText(text);
  const now = new Date();

  if (normalized.includes('ontem')) {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    const endExclusive = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return {
      label: 'ontem',
      start,
      endExclusive,
    };
  }

  if (normalized.includes('hoje')) {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const endExclusive = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    return {
      label: 'hoje',
      start,
      endExclusive,
    };
  }

  const lastDaysMatch = normalized.match(
    /(?:(?:nos|das|ha)\s+)?(?:ultimos|uiltimos|ultimas)\s+(\d+)\s*dias?/,
  );
  if (lastDaysMatch) {
    const days = Number(lastDaysMatch[1]);
    if (Number.isFinite(days) && days > 0) {
      const start = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
      return {
        label: `nos ultimos ${days} dias`,
        start,
        endExclusive: now,
      };
    }
  }

  return null;
};

const buildStatusEventSqlClause = (status: OrderStatus) => {
  if (status === OrderStatus.DELIVERED) {
    return `
      (
        te."status" IN ('DELIVERED', 'ENTREGUE')
        OR te."status" ILIKE '%DELIVERED%'
        OR te."description" ILIKE '%ENTREGUE%'
      )
    `;
  }

  if (status === OrderStatus.SHIPPED) {
    return `
      (
        te."status" ILIKE '%SHIPPED%'
        OR te."status" ILIKE '%TRANSIT%'
        OR te."description" ILIKE '%EM TRANSITO%'
        OR te."description" ILIKE '%TRANSITO%'
      )
    `;
  }

  if (status === OrderStatus.DELIVERY_ATTEMPT) {
    return `
      (
        te."status" ILIKE '%DELIVERY_ATTEMPT%'
        OR te."status" ILIKE '%TO_BE_DELIVERED%'
        OR te."description" ILIKE '%SAIU PARA ENTREGA%'
        OR te."description" ILIKE '%ROTA%'
      )
    `;
  }

  if (status === OrderStatus.FAILURE) {
    return `
      (
        te."status" ILIKE '%FAILURE%'
        OR te."status" ILIKE '%FALHA%'
        OR te."description" ILIKE '%FALHA%'
      )
    `;
  }

  return 'TRUE';
};

const buildOrderWhereSql = (
  companyId: string,
  filter: MatchedFilter,
  options: { archived?: boolean } = {},
) => {
  const now = new Date();
  const params: unknown[] = [companyId, options.archived ?? false];
  const conditions: string[] = ['o."companyId" = $1', 'o."isArchived" = $2'];
  let hasExactStatus = Boolean(filter.status);

  if (filter.delayedKind === 'carrier') {
    hasExactStatus = false;
    params.push(CLOSED_STATUSES);
    const closedStatusesParam = `$${params.length}`;
    params.push(now);
    const nowParam = `$${params.length}`;
    conditions.push(`NOT (o."status" = ANY(${closedStatusesParam}::text[]))`);
    conditions.push(`(o."isDelayed" = TRUE OR o."carrierEstimatedDeliveryDate" < ${nowParam})`);
  }

  if (filter.delayedKind === 'platform') {
    hasExactStatus = false;
    params.push(CLOSED_STATUSES);
    const closedStatusesParam = `$${params.length}`;
    params.push(now);
    const nowParam = `$${params.length}`;
    conditions.push(`NOT (o."status" = ANY(${closedStatusesParam}::text[]))`);
    conditions.push(`o."estimatedDeliveryDate" < ${nowParam}`);
  }

  if (filter.noMovementDays) {
    hasExactStatus = false;
    const minDate = new Date(now.getTime() - filter.noMovementDays * 24 * 60 * 60 * 1000);
    params.push(CLOSED_STATUSES);
    const closedStatusesParam = `$${params.length}`;
    params.push(minDate);
    const minDateParam = `$${params.length}`;
    conditions.push(`NOT (o."status" = ANY(${closedStatusesParam}::text[]))`);
    conditions.push(`o."lastUpdate" < ${minDateParam}`);
  }

  if (hasExactStatus && filter.status) {
    params.push(filter.status);
    conditions.push(`o."status" = $${params.length}`);
  }

  if (filter.carrierName) {
    params.push(filter.carrierName);
    conditions.push(`o."freightType" = $${params.length}`);
  }

  if (filter.salesChannel) {
    params.push(filter.salesChannel);
    conditions.push(`o."salesChannel" = $${params.length}`);
  }

  if (filter.period) {
    if (filter.status) {
      params.push(filter.period.start);
      const startParam = `$${params.length}`;
      params.push(filter.period.endExclusive);
      const endParam = `$${params.length}`;
      const statusClause = buildStatusEventSqlClause(filter.status);
      conditions.push(`
        EXISTS (
          SELECT 1
          FROM "TrackingEvent" te
          WHERE te."orderId" = o."id"
            AND te."eventDate" >= ${startParam}
            AND te."eventDate" < ${endParam}
            AND ${statusClause}
        )
      `);
    } else {
      params.push(filter.period.start);
      const startParam = `$${params.length}`;
      params.push(filter.period.endExclusive);
      const endParam = `$${params.length}`;
      conditions.push(`o."lastUpdate" >= ${startParam} AND o."lastUpdate" < ${endParam}`);
    }
  }

  return {
    whereSql: conditions.join('\n      AND '),
    params,
  };
};

const buildFilterLabel = (filter: MatchedFilter) => {
  let baseLabel = 'pedidos';

  if (filter.statusSummary) {
    baseLabel = 'pedidos por status';
  } else if (filter.delayedKind === 'platform') {
    baseLabel = 'pedidos em atraso da plataforma';
  } else if (filter.delayedKind === 'carrier') {
    baseLabel = 'pedidos atrasados pela transportadora';
  } else if (filter.noMovementDays) {
    baseLabel = `pedidos sem movimentacao ha ${filter.noMovementDays} dias`;
  } else if (filter.status) {
    baseLabel = `pedidos com status ${STATUS_LABELS[filter.status] || filter.status}`;
  }

  const details: string[] = [baseLabel];

  if (filter.carrierName) {
    details.push(`da transportadora ${filter.carrierName}`);
  }

  if (filter.salesChannel) {
    details.push(`do marketplace ${filter.salesChannel}`);
  }

  if (filter.period) {
    details.push(filter.period.label);
  }

  return details.join(' ');
};

const buildReportHtml = (input: {
  companyName: string;
  filterLabel: string;
  total: number;
  generatedAt: Date;
  orders: Array<{
    orderNumber: string;
    invoiceNumber: string | null;
    customerName: string;
    status: OrderStatus;
    salesChannel: string;
    freightType: string | null;
    trackingCode: string | null;
    estimatedDeliveryDate: Date | null;
    carrierEstimatedDeliveryDate: Date | null;
    lastUpdate: Date;
  }>;
}) => `<!DOCTYPE html>
<html lang="pt-BR">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Relatorio do chat - ${escapeHtml(input.companyName)}</title>
  </head>
  <body style="margin:0;padding:32px;background:#f8fafc;font-family:Segoe UI,Arial,sans-serif;color:#0f172a;">
    <div style="max-width:1120px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:24px;overflow:hidden;">
      <div style="padding:28px 32px;background:linear-gradient(135deg,#1d4ed8,#0f172a);color:#ffffff;">
        <div style="font-size:12px;letter-spacing:1px;text-transform:uppercase;opacity:0.8;">Relatorio gerado pela Muricoca</div>
        <h1 style="margin:12px 0 6px;font-size:30px;line-height:1.1;">${escapeHtml(input.filterLabel)}</h1>
        <div style="font-size:14px;opacity:0.88;">Empresa: ${escapeHtml(input.companyName)} | Gerado em: ${escapeHtml(formatDate(input.generatedAt))}</div>
      </div>
      <div style="padding:24px 32px;">
        <div style="margin-bottom:20px;padding:18px;border-radius:18px;background:#eff6ff;border:1px solid #bfdbfe;">
          <div style="font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#1d4ed8;font-weight:700;">Total localizado</div>
          <div style="margin-top:8px;font-size:32px;font-weight:700;">${input.total}</div>
        </div>
        <table style="width:100%;border-collapse:collapse;font-size:14px;">
          <thead>
            <tr style="background:#f8fafc;text-align:left;">
              <th style="padding:12px;border-bottom:1px solid #e2e8f0;">Pedido</th>
              <th style="padding:12px;border-bottom:1px solid #e2e8f0;">NF</th>
              <th style="padding:12px;border-bottom:1px solid #e2e8f0;">Cliente</th>
              <th style="padding:12px;border-bottom:1px solid #e2e8f0;">Status</th>
              <th style="padding:12px;border-bottom:1px solid #e2e8f0;">Marketplace</th>
              <th style="padding:12px;border-bottom:1px solid #e2e8f0;">Transportadora</th>
              <th style="padding:12px;border-bottom:1px solid #e2e8f0;">Rastreio</th>
              <th style="padding:12px;border-bottom:1px solid #e2e8f0;">Prev. plataforma</th>
              <th style="padding:12px;border-bottom:1px solid #e2e8f0;">Prev. transportadora</th>
              <th style="padding:12px;border-bottom:1px solid #e2e8f0;">Ultima mov.</th>
            </tr>
          </thead>
          <tbody>
            ${input.orders
              .map(
                (order) => `
                  <tr>
                    <td style="padding:12px;border-bottom:1px solid #f1f5f9;">${escapeHtml(order.orderNumber)}</td>
                    <td style="padding:12px;border-bottom:1px solid #f1f5f9;">${escapeHtml(order.invoiceNumber || '-')}</td>
                    <td style="padding:12px;border-bottom:1px solid #f1f5f9;">${escapeHtml(order.customerName)}</td>
                    <td style="padding:12px;border-bottom:1px solid #f1f5f9;">${escapeHtml(STATUS_LABELS[order.status] || order.status)}</td>
                    <td style="padding:12px;border-bottom:1px solid #f1f5f9;">${escapeHtml(order.salesChannel)}</td>
                    <td style="padding:12px;border-bottom:1px solid #f1f5f9;">${escapeHtml(order.freightType || '-')}</td>
                    <td style="padding:12px;border-bottom:1px solid #f1f5f9;">${escapeHtml(order.trackingCode || '-')}</td>
                    <td style="padding:12px;border-bottom:1px solid #f1f5f9;">${escapeHtml(formatDate(order.estimatedDeliveryDate))}</td>
                    <td style="padding:12px;border-bottom:1px solid #f1f5f9;">${escapeHtml(formatDate(order.carrierEstimatedDeliveryDate))}</td>
                    <td style="padding:12px;border-bottom:1px solid #f1f5f9;">${escapeHtml(formatDate(order.lastUpdate))}</td>
                  </tr>
                `,
              )
              .join('')}
          </tbody>
        </table>
      </div>
    </div>
  </body>
</html>`;

const buildReportCsv = (
  orders: Array<{
    orderNumber: string;
    invoiceNumber: string | null;
    customerName: string;
    status: OrderStatus;
    salesChannel: string;
    freightType: string | null;
    trackingCode: string | null;
    estimatedDeliveryDate: Date | null;
    carrierEstimatedDeliveryDate: Date | null;
    lastUpdate: Date;
  }>,
) =>
  [
    [
      'Pedido',
      'NF',
      'Cliente',
      'Status',
      'Marketplace',
      'Transportadora',
      'Rastreio',
      'Previsao Plataforma',
      'Previsao Transportadora',
      'Ultima Movimentacao',
    ],
    ...orders.map((order) => [
      order.orderNumber,
      order.invoiceNumber || '',
      order.customerName,
      STATUS_LABELS[order.status] || order.status,
      order.salesChannel,
      order.freightType || '',
      order.trackingCode || '',
      formatDate(order.estimatedDeliveryDate),
      formatDate(order.carrierEstimatedDeliveryDate),
      formatDate(order.lastUpdate),
    ]),
  ]
    .map((line) => line.map((value) => escapeCsv(value)).join(';'))
    .join('\n');

const buildAmbiguousPrompt = () =>
  [
    'Posso consultar isso para voce na base da plataforma, mas preciso confirmar o foco do relatorio.',
    '',
    'Voce quer um relatorio de:',
    '- pedidos por status, como Entregue, Em transito ou Falha na entrega',
    '- pedidos atrasados pela transportadora',
    '- pedidos em atraso da plataforma',
    '- pedidos sem movimentacao',
    '- pedidos de uma transportadora especifica',
    '- pedidos de um marketplace especifico',
  ].join('\n');

const buildDelayClarificationPrompt = () =>
  [
    'Posso consultar os pedidos atrasados para voce, mas preciso confirmar o tipo de atraso.',
    '',
    'Voce quer ver:',
    '- atraso da plataforma',
    '- atraso da transportadora',
    '',
    'Se quiser, ja pode responder por exemplo:',
    '- pedidos atrasados da plataforma',
    '- pedidos atrasados da transportadora',
  ].join('\n');

const getConversationMessageText = (message: ConversationMessage | null | undefined) =>
  String(message?.text || message?.content || '').trim();

const getPreviousUserMessageText = (
  messages: ConversationMessage[] | undefined,
  currentText: string,
) => {
  const userMessages = Array.isArray(messages)
    ? messages.filter((message) => String(message?.role || '') === 'user')
    : [];

  if (userMessages.length === 0) {
    return '';
  }

  const lastUserText = getConversationMessageText(userMessages[userMessages.length - 1]);
  if (normalizeText(lastUserText) === normalizeText(currentText)) {
    return getConversationMessageText(userMessages[userMessages.length - 2]);
  }

  return lastUserText;
};

const buildContextAwareStructuredInput = (
  text: string,
  messages: ConversationMessage[] | undefined,
) => {
  const trimmedText = String(text || '').trim();
  if (!trimmedText) {
    return trimmedText;
  }

  const normalizedCurrent = normalizeText(trimmedText);
  const assistantMessages = Array.isArray(messages)
    ? messages.filter((message) => {
        const role = String(message?.role || '');
        return role === 'model' || role === 'assistant';
      })
    : [];
  const lastAssistantText = normalizeText(
    getConversationMessageText(assistantMessages[assistantMessages.length - 1]),
  );
  const previousUserText = getPreviousUserMessageText(messages, trimmedText);
  const normalizedPreviousUser = normalizeText(previousUserText);

  if (
    (lastAssistantText.includes('foco do relatorio') ||
      lastAssistantText.includes('quer um relatorio')) &&
    !normalizedCurrent.includes('relatorio')
  ) {
    return `relatorio ${trimmedText}`;
  }

  if (
    lastAssistantText.includes('tipo de atraso') &&
    !normalizedCurrent.includes('pedidos atrasados')
  ) {
    return `pedidos atrasados ${trimmedText}`;
  }

  if (
    normalizedPreviousUser.includes('relatorio') &&
    !normalizedCurrent.includes('relatorio') &&
    (normalizedCurrent.includes('status') ||
      normalizedCurrent.includes('plataforma') ||
      normalizedCurrent.includes('transportadora') ||
      normalizedCurrent.includes('marketplace') ||
      normalizedCurrent.includes('sem movimentacao'))
  ) {
    return `${previousUserText} ${trimmedText}`;
  }

  return trimmedText;
};

class ChatAssistantService {
  private trackingService = new TrackingService();
  private pendingCarrierDeleteOperations = new Map<
    string,
    PendingCarrierDeleteOperation
  >();
  private trackingStatusSyncJobs = new Map<string, TrackingStatusSyncJob>();
  private static readonly PENDING_DELETE_TTL_MS = 15 * 60 * 1000;

  private buildPendingCarrierDeleteKey(companyId: string, userId: string) {
    return `${companyId}:${userId}`;
  }

  private pruneExpiredPendingCarrierDeleteOperations() {
    const now = Date.now();
    for (const [key, operation] of this.pendingCarrierDeleteOperations.entries()) {
      if (operation.expiresAt <= now) {
        this.pendingCarrierDeleteOperations.delete(key);
      }
    }
  }

  private extractCarrierTermsFromText(text: string) {
    const rawText = String(text || '').trim();
    if (!rawText) return [];

    const referenceMatch = rawText.match(/transportadoras?\s+(.+)/i);
    const baseSegment = referenceMatch?.[1] || rawText;
    const cleanedSegment = baseSegment
      .replace(/^[\s:,-]+/, '')
      .replace(/\b(da|das|de|do|dos)\b\s*/i, '')
      .replace(/[.!?].*$/, '')
      .replace(/\b(por favor|obrigado|obrigada|gentileza)\b.*$/i, '')
      .trim();

    if (!cleanedSegment) return [];

    const chunks = cleanedSegment
      .split(/,|;|\bou\b|\be\b|\//gi)
      .map((chunk) => stripPoliteTail(chunk))
      .map((chunk) => chunk.replace(/^[\s:.-]+|[\s:.-]+$/g, '').trim())
      .filter(Boolean);

    return Array.from(new Set(chunks));
  }

  private async resolveCarrierNamesFromText(companyId: string, text: string) {
    const candidateTerms = this.extractCarrierTermsFromText(text);
    const resolvedCarriers: string[] = [];
    const unresolvedTerms: string[] = [];

    for (const term of candidateTerms) {
      const resolved = await this.resolveExactCarrierName(companyId, normalizeText(term));
      if (resolved) {
        resolvedCarriers.push(resolved);
      } else {
        unresolvedTerms.push(term);
      }
    }

    if (resolvedCarriers.length === 0) {
      const fallback = await this.resolveExactCarrierName(companyId, normalizeText(text));
      if (fallback) {
        resolvedCarriers.push(fallback);
      }
    }

    return {
      resolvedCarriers: Array.from(new Set(resolvedCarriers)),
      unresolvedTerms,
    };
  }

  private async countOrdersByCarriers(companyId: string, carriers: string[]) {
    if (!carriers.length) return [];

    const rowsResult = await dbQuery<{ carrierName: string | null; total: number }>(
      `
        SELECT
          o."freightType" AS "carrierName",
          COUNT(*)::int AS total
        FROM "Order" o
        WHERE o."companyId" = $1
          AND o."freightType" = ANY($2::text[])
        GROUP BY o."freightType"
      `,
      [companyId, carriers],
    );

    const rowsByCarrier = new Map<string, number>(
      rowsResult.rows
        .map((row) => [String(row.carrierName || '').trim(), Number(row.total || 0)] as const)
        .filter(([carrierName]) => Boolean(carrierName)),
    );

    return carriers.map((carrierName) => ({
      carrierName,
      total: rowsByCarrier.get(carrierName) || 0,
    }));
  }

  private async archiveOrdersByCarriers(companyId: string, carriers: string[]) {
    if (!carriers.length) {
      return {
        updatedByCarrier: [] as Array<{ carrierName: string; total: number }>,
        alreadyArchivedByCarrier: [] as Array<{ carrierName: string; total: number }>,
      };
    }

    const totalByCarrier = await this.countOrdersByCarriers(companyId, carriers);

    const updatedResult = await dbQuery<{ id: string; carrierName: string | null }>(
      `
        UPDATE "Order" o
        SET
          "isArchived" = TRUE,
          "archivedAt" = NOW(),
          "lastUpdate" = NOW()
        WHERE o."companyId" = $1
          AND o."freightType" = ANY($2::text[])
          AND o."isArchived" = FALSE
        RETURNING o."id", o."freightType" AS "carrierName"
      `,
      [companyId, carriers],
    );

    const updatedRows = updatedResult.rows;
    const updatedIds = updatedRows.map((row) => String(row.id || '').trim()).filter(Boolean);

    if (updatedIds.length > 0) {
      await dbQuery(
        `
          DELETE FROM "MonitoredOrder" mo
          WHERE mo."companyId" = $1
            AND mo."orderId" = ANY($2::text[])
        `,
        [companyId, updatedIds],
      );
    }

    const updatedByCarrierMap = new Map<string, number>();
    for (const row of updatedRows) {
      const carrierName = String(row.carrierName || '').trim();
      if (!carrierName) continue;
      updatedByCarrierMap.set(
        carrierName,
        (updatedByCarrierMap.get(carrierName) || 0) + 1,
      );
    }

    const updatedByCarrier = carriers.map((carrierName) => ({
      carrierName,
      total: updatedByCarrierMap.get(carrierName) || 0,
    }));

    const alreadyArchivedByCarrier = totalByCarrier.map((item) => ({
      carrierName: item.carrierName,
      total: Math.max(0, item.total - (updatedByCarrierMap.get(item.carrierName) || 0)),
    }));

    return {
      updatedByCarrier,
      alreadyArchivedByCarrier,
    };
  }

  private async deleteOrdersByCarriers(companyId: string, carriers: string[]) {
    if (!carriers.length) {
      return [] as Array<{ carrierName: string; total: number }>;
    }

    const deletedResult = await dbQuery<{ carrierName: string | null }>(
      `
        DELETE FROM "Order" o
        WHERE o."companyId" = $1
          AND o."freightType" = ANY($2::text[])
        RETURNING o."freightType" AS "carrierName"
      `,
      [companyId, carriers],
    );

    const deletedByCarrierMap = new Map<string, number>();
    for (const row of deletedResult.rows) {
      const carrierName = String(row.carrierName || '').trim();
      if (!carrierName) continue;
      deletedByCarrierMap.set(
        carrierName,
        (deletedByCarrierMap.get(carrierName) || 0) + 1,
      );
    }

    return carriers.map((carrierName) => ({
      carrierName,
      total: deletedByCarrierMap.get(carrierName) || 0,
    }));
  }

  private formatCarrierBreakdown(
    entries: Array<{ carrierName: string; total: number }>,
    action: 'excluir' | 'arquivar',
  ) {
    return entries
      .map((item) => {
        const noun = item.total === 1 ? 'pedido' : 'pedidos';
        if (action === 'excluir') {
          return `${item.total} ${noun} da transportadora ${item.carrierName}`;
        }
        return `${item.total} ${noun} da transportadora ${item.carrierName}`;
      })
      .join(', ');
  }

  private async handlePendingCarrierDeleteConfirmation(input: {
    companyId: string;
    userId: string;
    text: string;
  }): Promise<StructuredResult | null> {
    this.pruneExpiredPendingCarrierDeleteOperations();

    const key = this.buildPendingCarrierDeleteKey(input.companyId, input.userId);
    const operation = this.pendingCarrierDeleteOperations.get(key);
    if (!operation) {
      return null;
    }

    if (operation.expiresAt <= Date.now()) {
      this.pendingCarrierDeleteOperations.delete(key);
      return {
        handled: true,
        text: 'A confirmacao expirou. Reenvie o comando de exclusao para eu gerar uma nova confirmacao.',
      };
    }

    if (isNegativeConfirmation(input.text)) {
      this.pendingCarrierDeleteOperations.delete(key);
      return {
        handled: true,
        text: 'Operacao cancelada. Nenhum pedido foi excluido.',
      };
    }

    if (!isPositiveConfirmation(input.text)) {
      return {
        handled: true,
        text: 'Existe uma exclusao pendente. Responda com "Sim" para confirmar ou "Nao" para cancelar.',
        actions: [
          { label: 'Sim', value: 'sim', style: 'danger' },
          { label: 'Nao', value: 'nao', style: 'secondary' },
        ],
      };
    }

    this.pendingCarrierDeleteOperations.delete(key);
    const deletedByCarrier = await this.deleteOrdersByCarriers(
      input.companyId,
      operation.carriers,
    );
    const totalDeleted = deletedByCarrier.reduce(
      (accumulator, item) => accumulator + item.total,
      0,
    );

    if (totalDeleted === 0) {
      return {
        handled: true,
        text: 'Nao encontrei pedidos para excluir nessas transportadoras no momento da confirmacao.',
      };
    }

    return {
      handled: true,
      text: `Exclusao concluida com sucesso. Foram removidos ${totalDeleted} pedidos do banco: ${this.formatCarrierBreakdown(
        deletedByCarrier,
        'excluir',
      )}.`,
    };
  }

  private buildTrackingSummary(order: {
    orderNumber: string;
    invoiceNumber?: string | null;
    trackingCode?: string | null;
    customerName: string;
    recipient?: string | null;
    freightType?: string | null;
    status: OrderStatus;
    estimatedDeliveryDate?: Date | null;
    carrierEstimatedDeliveryDate?: Date | null;
    trackingUrl?: string | null;
    trackingSourceLabel?: string | null;
    apiRawPayload?: any;
    trackingEvents?: any[];
  }) {
    const trackingHistory = mapTrackingEventsToHistory(order.trackingEvents);
    const latestEvent = trackingHistory
      .slice()
      .sort(
        (left, right) => new Date(right.date).getTime() - new Date(left.date).getTime(),
      )[0];
    const latestLocation =
      latestEvent && (latestEvent.city || latestEvent.state)
        ? ` (${[latestEvent.city, latestEvent.state].filter(Boolean).join('/')})`
        : '';
    const trackingUrl = getStoredTrackingUrl(order);
    const lines = [
      `Encontrei o rastreio atual do pedido ${order.orderNumber}.`,
      `- Cliente: ${order.customerName || '-'}`,
      `- Destinatario: ${order.recipient || '-'}`,
      `- Status atual: ${STATUS_LABELS[order.status] || order.status}`,
      `- Fonte do rastreio: ${resolveTrackingSourceLabel(order)}`,
      `- Transportadora: ${order.freightType || '-'}`,
      `- NF: ${order.invoiceNumber || '-'}`,
      `- Codigo de envio: ${order.trackingCode || '-'}`,
      `- Prazo da plataforma: ${formatDateOnly(order.estimatedDeliveryDate || null)}`,
      `- Prazo da transportadora: ${formatDateOnly(order.carrierEstimatedDeliveryDate || null)}`,
      latestEvent
        ? `- Ultima movimentacao: ${formatDate(latestEvent.date)} - ${latestEvent.description}${latestLocation}`
        : '- Ultima movimentacao: sem historico de rastreio',
    ];

    if (trackingUrl) {
      lines.push(`- Link de rastreio: ${trackingUrl}`);
    }

    return lines.join('\n');
  }

  private buildTrackingLinkReply(order: {
    orderNumber: string;
    trackingUrl?: string | null;
    apiRawPayload?: any;
  }) {
    const trackingUrl = getStoredTrackingUrl(order);

    if (!trackingUrl) {
      return `Nao encontrei um link direto de rastreio para o pedido ${order.orderNumber}.`;
    }

    return [
      `Aqui esta o link direto de rastreio do pedido ${order.orderNumber}:`,
      trackingUrl,
    ].join('\n');
  }

  private buildCustomerDisambiguation(
    customerName: string,
    orders: Array<{
      orderNumber: string;
      invoiceNumber: string | null;
      customerName: string;
      status: OrderStatus;
      lastUpdate: Date;
    }>,
  ) {
    return [
      `Encontrei mais de um pedido para o cliente ${customerName}.`,
      '',
      ...orders.slice(0, 5).map(
        (order, index) =>
          `${index + 1}. Pedido ${order.orderNumber} | NF ${order.invoiceNumber || '-'} | ${STATUS_LABELS[order.status] || order.status} | Ultima mov. ${formatDate(order.lastUpdate)}`,
      ),
      '',
      'Se quiser, me peça por numero do pedido, NF ou XML para eu trazer o rastreio exato.',
    ].join('\n');
  }

  private buildExternalOrderPayload(
    request: TrackingLookupRequest,
    source: 'SSW' | 'INTELIPOST' | 'INTELIPOST_INVOICE_KEY' | 'CORREIOS',
    result: any,
  ) {
    if (source === 'SSW') {
      const events = Array.isArray(result.events) ? result.events : [];
      const latestEvent = events
        .slice()
        .sort((left, right) => right.eventDate.getTime() - left.eventDate.getTime())[0];
      const recipientName =
        safeString(result.matchMetadata?.recipientName) ||
        safeString(result.matchMetadata?.deliveredToName) ||
        'Consulta externa';
      const documentFields = splitDocumentFields(
        safeString(result.matchMetadata?.deliveredToDocument) ||
          safeString(result.matchMetadata?.recipientDocument),
      );
      const trackingUrl = safeString(result.rawPayload?.trackingUrl);

      return {
        orderNumber: request.kind === 'order' ? request.value : request.value,
        invoiceNumber:
          String(result.lookupMode || '').toUpperCase() === 'INVOICE'
            ? normalizeDigits(request.value)
            : null,
        trackingCode:
          String(result.lookupMode || '').toUpperCase() === 'XML_KEY'
            ? normalizeAlphaNumeric(request.value)
            : String(result.lookupMode || '').toUpperCase() === 'TRACKING_CODE'
              ? normalizeDigits(request.value)
              : null,
        customerName: recipientName,
        corporateName: null,
        cpf: documentFields.cpf,
        cnpj: documentFields.cnpj,
        phone: null,
        mobile: null,
        salesChannel: 'Externo',
        freightType: safeString(result.freightType) || 'SSW',
        freightValue: 0,
        shippingDate: latestEvent?.eventDate || new Date(),
        address: '',
        number: '',
        complement: null,
        neighborhood: '',
        city: safeString(result.matchMetadata?.destinationCity) || latestEvent?.city || '',
        state: safeString(result.matchMetadata?.destinationState) || latestEvent?.state || '',
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
        apiRawPayload: {
          source: 'SSW',
          lookupMode: result.lookupMode || 'INVOICE',
          trackingUrl,
          matchMetadata: result.matchMetadata ?? null,
          rawPayload: result.rawPayload ?? null,
        },
      };
    }

    if (source === 'CORREIOS') {
      const events = Array.isArray(result.events) ? result.events : [];
      const latestEvent = events[0] || null;
      const trackingCode = normalizeAlphaNumeric(result.objectCode || request.value);
      const trackingUrl = safeString(result.trackingUrl);

      return {
        orderNumber: trackingCode || request.value,
        invoiceNumber: null,
        trackingCode,
        customerName: 'Consulta externa',
        corporateName: null,
        cpf: null,
        cnpj: null,
        phone: null,
        mobile: null,
        salesChannel: 'Externo',
        freightType: 'Correios',
        freightValue: 0,
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
        apiRawPayload: {
          source: 'CORREIOS',
          trackingUrl,
          objectCode: trackingCode,
          rawPayload: result.rawPayload ?? null,
        },
      };
    }

    const trackingHistory = Array.isArray(result?.tracking?.history)
      ? result.tracking.history.map((historyItem: any) => ({
          status: safeString(historyItem?.macro_state?.code) || 'UNKNOWN',
          description:
            safeString(historyItem?.provider_message) ||
            safeString(historyItem?.status_label) ||
            'Evento de rastreamento',
          date: safeDate(historyItem?.event_date) || new Date(),
          city: safeString(result?.end_customer?.address?.city) || '',
          state: safeString(result?.end_customer?.address?.state) || '',
        }))
      : [];
    const latestEvent = trackingHistory
      .slice()
      .sort(
        (left, right) => new Date(right.date).getTime() - new Date(left.date).getTime(),
      )[0];
    const resolvedOrderNumber = safeString(result?.order?.order_number) || request.value;
    const trackingUrl = buildIntelipostTrackingUrl(
      safeString(result?.client?.id),
      resolvedOrderNumber,
    );

    return {
      orderNumber: resolvedOrderNumber,
      invoiceNumber: null,
      trackingCode: null,
      customerName: 'Consulta externa',
      corporateName: null,
      cpf: null,
      cnpj: null,
      phone: null,
      mobile: null,
      salesChannel: 'Externo',
      freightType: safeString(result?.logistic_provider?.name) || 'Desconhecida',
      freightValue: 0,
      shippingDate: latestEvent?.date || new Date(),
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
      status: mapIntelipostStatusToOrderStatus(
        [
          safeString(result?.tracking?.status),
          safeString(result?.tracking?.status_label),
          safeString(trackingHistory[0]?.status),
          safeString(trackingHistory[0]?.description),
        ]
          .filter(Boolean)
          .join(' '),
      ),
      isDelayed: false,
      trackingHistory,
      apiRawPayload: {
        source: source === 'INTELIPOST_INVOICE_KEY' ? 'INTELIPOST_INVOICE_KEY' : 'INTELIPOST',
        trackingUrl,
        tracking: result?.tracking ?? null,
        logistic_provider: result?.logistic_provider ?? null,
        end_customer: result?.end_customer ?? null,
        client: result?.client ?? null,
        rawPayload: result ?? null,
      },
    };
  }

  private async fetchTrackingOrderById(orderId: string) {
    const orderResult = await dbQuery<any>(
      `
        SELECT
          o."id",
          o."orderNumber",
          o."invoiceNumber",
          o."trackingCode",
          o."customerName",
          o."recipient",
          o."freightType",
          o."status",
          o."estimatedDeliveryDate",
          o."carrierEstimatedDeliveryDate",
          o."apiRawPayload",
          o."trackingUrl",
          o."trackingSourceLabel"
        FROM "Order" o
        WHERE o."id" = $1
        LIMIT 1
      `,
      [orderId],
    );

    const order = orderResult.rows[0];
    if (!order) {
      return null;
    }

    const trackingEventsResult = await dbQuery<any>(
      `
        SELECT
          te."status",
          te."description",
          te."city",
          te."state",
          te."eventDate"
        FROM "TrackingEvent" te
        WHERE te."orderId" = $1
        ORDER BY te."eventDate" DESC
        LIMIT 20
      `,
      [orderId],
    );

    return {
      ...order,
      trackingEvents: trackingEventsResult.rows,
    };
  }

  async tryHandleTrackingRequest(input: {
    companyId: string | null | undefined;
    text: string;
  }): Promise<StructuredResult> {
    const shouldReturnLink = hasTrackingLinkIntent(input.text);
    const request = extractTrackingLookupRequest(input.text);
    if (!request) {
      return { handled: false };
    }

    if (!input.companyId) {
      return {
        handled: true,
        text: 'Nao encontrei uma empresa ativa para consultar o rastreio deste chat.',
      };
    }

    if (request.kind === 'customer') {
      const customerSearch = `%${request.value}%`;
      const matchesResult = await dbQuery<any>(
        `
          SELECT
            o."id",
            o."orderNumber",
            o."invoiceNumber",
            o."customerName",
            o."status",
            o."lastUpdate"
          FROM "Order" o
          WHERE o."companyId" = $1
            AND o."isArchived" = FALSE
            AND (
              o."customerName" ILIKE $2
              OR o."corporateName" ILIKE $2
              OR o."recipient" ILIKE $2
            )
          ORDER BY o."lastUpdate" DESC
          LIMIT 6
        `,
        [input.companyId, customerSearch],
      );
      const matches = matchesResult.rows;

      if (matches.length === 0) {
        return {
          handled: true,
          text: `Nao encontrei pedido para o cliente ${request.value} na empresa ativa.`,
        };
      }

      if (matches.length > 1) {
        return {
          handled: true,
          text: this.buildCustomerDisambiguation(request.value, matches),
        };
      }

      const match = matches[0];
      const syncResult = await this.trackingService
        .syncOrder(match.id, input.companyId, { forceFinalized: true })
        .catch(() => null);
      if (syncResult?.change) {
        await notificationService
          .registerMonitoredOrderChanges(input.companyId, [syncResult.change])
          .catch(() => null);
      }
      const refreshedOrder = await this.fetchTrackingOrderById(match.id);

      return {
        handled: true,
        text: refreshedOrder
          ? shouldReturnLink
            ? this.buildTrackingLinkReply(refreshedOrder)
            : this.buildTrackingSummary(refreshedOrder)
          : `Nao consegui montar o rastreio do cliente ${request.value} agora.`,
      };
    }

    const normalizedDigits = normalizeDigits(request.value);
    const normalizedAlphaNumeric = normalizeAlphaNumeric(request.value);
    const localMatchesResult = await dbQuery<any>(
      `
        SELECT
          o."id",
          o."lastUpdate"
        FROM "Order" o
        WHERE o."companyId" = $1
          AND o."isArchived" = FALSE
          AND (
            o."orderNumber" = $2
            OR ($3::text <> '' AND o."orderNumber" = $3)
            OR ($3::text <> '' AND o."invoiceNumber" = $3)
            OR ($3::text <> '' AND o."trackingCode" = $3)
            OR ($4::text <> '' AND o."trackingCode" = $4)
          )
        ORDER BY o."lastUpdate" DESC
        LIMIT 1
      `,
      [
        input.companyId,
        request.value,
        normalizedDigits || '',
        normalizedAlphaNumeric || '',
      ],
    );
    const localMatches = localMatchesResult.rows;

    if (localMatches[0]?.id) {
      const syncResult = await this.trackingService
        .syncOrder(localMatches[0].id, input.companyId, { forceFinalized: true })
        .catch(() => null);
      if (syncResult?.change) {
        await notificationService
          .registerMonitoredOrderChanges(input.companyId, [syncResult.change])
          .catch(() => null);
      }
      const refreshedOrder = await this.fetchTrackingOrderById(localMatches[0].id);

      return {
        handled: true,
        text: refreshedOrder
          ? shouldReturnLink
            ? this.buildTrackingLinkReply(refreshedOrder)
            : this.buildTrackingSummary(refreshedOrder)
          : `Nao consegui montar o rastreio de ${request.label} ${request.value} agora.`,
      };
    }

    const externalResult = await this.trackingService.searchExternalIdentifier(
      request.value,
      input.companyId,
    );

    if (!externalResult) {
      return {
        handled: true,
        text: `Nao encontrei rastreio para ${request.label} ${request.value} nas integradoras ativas nem na base local.`,
      };
    }

    const externalOrderPayload = this.buildExternalOrderPayload(
      request,
      externalResult.source,
      externalResult.result,
    );
    await importOrdersForCompany(input.companyId, [externalOrderPayload]);

    const savedOrderResult = await dbQuery<any>(
      `
        SELECT o."id"
        FROM "Order" o
        WHERE o."companyId" = $1
          AND o."orderNumber" = $2
        ORDER BY o."createdAt" DESC
        LIMIT 1
      `,
      [input.companyId, String(externalOrderPayload.orderNumber)],
    );
    const savedOrder = savedOrderResult.rows[0] || null;

    const orderForSummary = savedOrder?.id
      ? await this.fetchTrackingOrderById(savedOrder.id)
      : {
          ...externalOrderPayload,
          trackingUrl: getStoredTrackingUrl(externalOrderPayload),
          trackingSourceLabel: resolveTrackingSourceLabel(externalOrderPayload),
          trackingEvents: Array.isArray(externalOrderPayload.trackingHistory)
            ? externalOrderPayload.trackingHistory.map((event) => ({
                ...event,
                eventDate: event.date,
              }))
            : [],
        };

    return {
      handled: true,
      text: orderForSummary
        ? shouldReturnLink
          ? this.buildTrackingLinkReply(orderForSummary as any)
          : this.buildTrackingSummary(orderForSummary as any)
        : `Nao consegui montar o rastreio de ${request.label} ${request.value} agora.`,
    };
  }

  private async buildCarrierStatusSummary(companyId: string, filter: MatchedFilter) {
    if (
      !filter.carrierName &&
      !filter.salesChannel &&
      !filter.statusSummary &&
      !(
        !filter.status &&
        !filter.delayedKind &&
        !filter.noMovementDays &&
        !filter.period
      )
    ) {
      return null;
    }

    const summaryBaseFilter: MatchedFilter = {
      carrierName: filter.carrierName,
      salesChannel: filter.salesChannel || null,
      period: filter.period || null,
    };
    const baseWhere = buildOrderWhereSql(companyId, summaryBaseFilter);
    const statusRowsResult = await dbQuery<{ status: OrderStatus; total: number }>(
      `
        SELECT
          o."status" AS status,
          COUNT(*)::int AS total
        FROM "Order" o
        WHERE ${baseWhere.whereSql}
        GROUP BY o."status"
      `,
      baseWhere.params,
    );

    const countsByStatus = new Map<OrderStatus, number>(
      statusRowsResult.rows.map((row) => [row.status, Number(row.total || 0)]),
    );

    const carrierWhere = buildOrderWhereSql(companyId, {
      ...summaryBaseFilter,
      delayedKind: 'carrier',
    });
    const carrierDelayedResult = await dbQuery<{ total: number }>(
      `
        SELECT COUNT(*)::int AS total
        FROM "Order" o
        WHERE ${carrierWhere.whereSql}
      `,
      carrierWhere.params,
    );
    const carrierDelayedCount = Number(carrierDelayedResult.rows[0]?.total || 0);

    const platformWhere = buildOrderWhereSql(companyId, {
      ...summaryBaseFilter,
      delayedKind: 'platform',
    });
    const platformDelayedResult = await dbQuery<{ total: number }>(
      `
        SELECT COUNT(*)::int AS total
        FROM "Order" o
        WHERE ${platformWhere.whereSql}
      `,
      platformWhere.params,
    );
    const platformDelayedCount = Number(platformDelayedResult.rows[0]?.total || 0);

    const summaryTitle = filter.carrierName
      ? `Resumo por status da transportadora ${filter.carrierName}:`
      : filter.salesChannel
        ? `Resumo por status do marketplace ${filter.salesChannel}:`
        : 'Resumo geral por status:';

    return [
      summaryTitle,
      `- Atraso Transportadora: ${carrierDelayedCount}`,
      `- Atraso Plataforma: ${platformDelayedCount}`,
      ...STATUS_SUMMARY_ORDER.map(
        (status) =>
          `- ${STATUS_LABELS[status] || status}: ${countsByStatus.get(status) || 0}`,
      ),
    ].join('\n');
  }

  private async resolveExactCarrierName(companyId: string, normalizedInput: string) {
    const carriersResult = await dbQuery<{ freightType: string | null }>(
      `
        SELECT DISTINCT o."freightType" AS "freightType"
        FROM "Order" o
        WHERE o."companyId" = $1
          AND o."freightType" IS NOT NULL
        LIMIT 200
      `,
      [companyId],
    );
    const carriers = carriersResult.rows;

    const matches = carriers
      .map((carrier) => String(carrier.freightType || '').trim())
      .filter(Boolean)
      .sort((left, right) => right.length - left.length);

    const bestMatch = matches
      .map((carrier) => ({
        carrier,
        score: scoreOptionMatch(carrier, normalizedInput),
      }))
      .sort((left, right) => right.score - left.score)[0];

    return bestMatch && bestMatch.score >= 120 ? bestMatch.carrier : null;
  }

  private async resolveExactMarketplaceName(companyId: string, normalizedInput: string) {
    const channelsResult = await dbQuery<{ salesChannel: string | null }>(
      `
        SELECT DISTINCT o."salesChannel" AS "salesChannel"
        FROM "Order" o
        WHERE o."companyId" = $1
        LIMIT 200
      `,
      [companyId],
    );
    const channels = channelsResult.rows;

    const matches = channels
      .map((channel) => String(channel.salesChannel || '').trim())
      .filter(Boolean)
      .sort((left, right) => right.length - left.length);

    const bestMatch = matches
      .map((channel) => ({
        channel,
        score: scoreOptionMatch(channel, normalizedInput),
      }))
      .sort((left, right) => right.score - left.score)[0];

    return bestMatch && bestMatch.score >= 120 ? bestMatch.channel : null;
  }

  private async resolveOrdersByIdentifiers(input: {
    companyId: string;
    identifiers: string[];
  }) {
    const foundOrdersById = new Map<string, any>();
    const notFoundIdentifiers: string[] = [];

    for (const identifier of Array.from(new Set(input.identifiers.map((item) => String(item || '').trim()).filter(Boolean)))) {
      const digits = normalizeDigits(identifier);
      const alphaNumeric = normalizeAlphaNumeric(identifier);
      const result = await dbQuery<any>(
        `
          SELECT o.*
          FROM "Order" o
          WHERE o."companyId" = $1
            AND (
              o."orderNumber" = $2
              OR ($3::text <> '' AND o."orderNumber" = $3)
              OR ($3::text <> '' AND o."invoiceNumber" = $3)
              OR ($4::text <> '' AND o."trackingCode" = $4)
              OR ($4::text <> '' AND regexp_replace(UPPER(COALESCE(o."invoiceAccessKey", '')), '[^A-Z0-9]', '', 'g') = $4)
            )
          ORDER BY o."lastUpdate" DESC
          LIMIT 1
        `,
        [input.companyId, identifier, digits || '', alphaNumeric || ''],
      );
      const order = result.rows[0] || null;
      if (!order) {
        notFoundIdentifiers.push(identifier);
        continue;
      }
      foundOrdersById.set(String(order.id), order);
    }

    return {
      foundOrders: Array.from(foundOrdersById.values()),
      notFoundIdentifiers,
    };
  }

  private async getEnabledOrderIntegrations(companyId: string) {
    const result = await dbQuery<any>(
      `
        SELECT
          "trayIntegrationEnabled",
          "magazordIntegrationEnabled",
          "anymarketIntegrationEnabled",
          "jetIntegrationEnabled"
        FROM "Company"
        WHERE "id" = $1
        LIMIT 1
      `,
      [companyId],
    );
    const flags = result.rows[0] || {};
    const integrations: Array<'tray' | 'magazord' | 'anymarket' | 'jet'> = [];
    if (flags.trayIntegrationEnabled !== false) integrations.push('tray');
    if (flags.magazordIntegrationEnabled === true) integrations.push('magazord');
    if (flags.anymarketIntegrationEnabled === true) integrations.push('anymarket');
    if (flags.jetIntegrationEnabled === true) integrations.push('jet');
    return integrations;
  }

  private async fetchOrderFromIntegration(
    integration: 'tray' | 'magazord' | 'anymarket' | 'jet',
    companyId: string,
    orderNumber: string,
  ) {
    if (integration === 'tray') {
      const trayApi = new TrayApiService(companyId);
      const completeOrder = await trayApi.getOrderComplete(orderNumber);
      return completeOrder?.Order ? trayApi.mapTrayOrderToSystem(completeOrder.Order) : null;
    }

    if (integration === 'anymarket') {
      const anymarketApi = new AnymarketApiService(companyId);
      for (const params of [{ partnerId: orderNumber }, { marketplaceId: orderNumber }, { shippingId: orderNumber }]) {
        const response = await anymarketApi.listOrders({ limit: 5, offset: 0, ...params });
        const orders = Array.isArray(response?.content) ? response.content : [];
        if (orders.length > 0) return anymarketApi.mapAnymarketOrderToSystem(orders[0]);
      }
      return null;
    }

    if (integration === 'magazord') {
      const magazordApi = new MagazordApiService(companyId);
      const detail = await magazordApi.getOrderByCode(orderNumber);
      if (!detail) return null;
      const trackingItems = await magazordApi.getOrderTrackingByCode(orderNumber);
      return magazordApi.mapMagazordOrderToSystem({ ...detail, arrayPedidoRastreio: trackingItems });
    }

    const jetApi = new JetApiService(companyId);
    const jetOrder = await jetApi.getOrderById(normalizeDigits(orderNumber));
    return jetApi.mapJetOrderToSystem(jetOrder);
  }

  private async updateOrdersFromIntegration(input: {
    companyId: string;
    identifiers: string[];
  }) {
    const resolution = await this.resolveOrdersByIdentifiers(input);
    const integrations = await this.getEnabledOrderIntegrations(input.companyId);
    const updatedOrders: string[] = [];
    const skippedArchived: string[] = [];
    const failedOrders: string[] = [];

    for (const order of resolution.foundOrders) {
      const label = order.invoiceNumber
        ? `Pedido ${order.orderNumber} / NF ${order.invoiceNumber}`
        : `Pedido ${order.orderNumber}`;
      if (order.isArchived) {
        skippedArchived.push(label);
        continue;
      }

      let updated = false;
      const attempts: string[] = [];
      for (const integration of integrations) {
        try {
          const mappedOrder = await this.fetchOrderFromIntegration(
            integration,
            input.companyId,
            String(order.orderNumber),
          );
          if (!mappedOrder) {
            attempts.push(`${integration}: pedido nao localizado`);
            continue;
          }
          const result = await importOrdersForCompany(input.companyId, [mappedOrder]);
          if (result.results.created > 0 || result.results.updated > 0) {
            updated = true;
            break;
          }
          attempts.push(result.results.errors[0] || result.results.skippedOrders?.[0]?.reason || `${integration}: sem alteracao`);
        } catch (error: any) {
          attempts.push(`${integration}: ${error?.message || 'falha na consulta'}`);
        }
      }

      if (updated) updatedOrders.push(label);
      else failedOrders.push(`${label}${attempts.length ? ` (${attempts.join('; ')})` : ''}`);
    }

    return { ...resolution, updatedOrders, skippedArchived, failedOrders, integrations };
  }

  private async updateOrdersManualStatus(input: {
    companyId: string;
    identifiers: string[];
    status: OrderStatus;
  }) {
    const resolution = await this.resolveOrdersByIdentifiers(input);
    const updatedOrders: string[] = [];
    const skippedArchived: string[] = [];
    const updatedAt = new Date();

    for (const order of resolution.foundOrders) {
      const label = order.invoiceNumber
        ? `Pedido ${order.orderNumber} / NF ${order.invoiceNumber}`
        : `Pedido ${order.orderNumber}`;
      if (order.isArchived) {
        skippedArchived.push(label);
        continue;
      }

      await dbQuery(
        `
          UPDATE "Order"
          SET
            "status" = $2,
            "isDelayed" = FALSE,
            "lastApiSync" = $3,
            "lastApiError" = NULL,
            "lastUpdate" = NOW()
          WHERE "id" = $1
        `,
        [order.id, input.status, updatedAt],
      );
      await dbQuery(
        `
          INSERT INTO "TrackingEvent" (
            "id", "orderId", "status", "description", "city", "state", "eventDate", "createdAt"
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
        `,
        [
          crypto.randomUUID(),
          order.id,
          input.status,
          `Status alterado manualmente pelo Muricoca para ${STATUS_LABELS[input.status] || input.status}.`,
          order.city || null,
          order.state || null,
          updatedAt,
        ],
      );
      updatedOrders.push(label);
    }

    return { ...resolution, updatedOrders, skippedArchived };
  }
  private async setOrderArchiveByIdentifiers(input: {
    companyId: string;
    identifiers: string[];
    archived: boolean;
  }) {
    const normalizedIdentifiers = Array.from(
      new Set(
        (Array.isArray(input.identifiers) ? input.identifiers : [])
          .map((item) => String(item || '').trim())
          .filter(Boolean),
      ),
    );

    const foundOrdersById = new Map<
      string,
      {
        id: string;
        orderNumber: string;
        invoiceNumber: string | null;
        isArchived: boolean;
      }
    >();
    const notFoundIdentifiers: string[] = [];

    for (const identifier of normalizedIdentifiers) {
      const digits = normalizeDigits(identifier);
      const alphaNumeric = normalizeAlphaNumeric(identifier);

      const orderResult = await dbQuery<any>(
        `
          SELECT
            o."id",
            o."orderNumber",
            o."invoiceNumber",
            o."isArchived"
          FROM "Order" o
          WHERE o."companyId" = $1
            AND (
              o."orderNumber" = $2
              OR ($3::text <> '' AND o."orderNumber" = $3)
              OR ($3::text <> '' AND o."invoiceNumber" = $3)
              OR ($3::text <> '' AND o."trackingCode" = $3)
              OR ($4::text <> '' AND o."trackingCode" = $4)
            )
          ORDER BY o."lastUpdate" DESC
          LIMIT 1
        `,
        [input.companyId, identifier, digits || '', alphaNumeric || ''],
      );
      const order = orderResult.rows[0] || null;

      if (!order?.id) {
        notFoundIdentifiers.push(identifier);
        continue;
      }

      foundOrdersById.set(String(order.id), {
        id: String(order.id),
        orderNumber: String(order.orderNumber || ''),
        invoiceNumber: order.invoiceNumber ? String(order.invoiceNumber) : null,
        isArchived: Boolean(order.isArchived),
      });
    }

    const foundOrders = Array.from(foundOrdersById.values());
    const toUpdate = foundOrders.filter((order) => order.isArchived !== input.archived);
    const alreadyInTargetState = foundOrders.filter(
      (order) => order.isArchived === input.archived,
    );

    if (toUpdate.length > 0) {
      await dbQuery(
        `
          UPDATE "Order" o
          SET
            "isArchived" = $3,
            "archivedAt" = CASE WHEN $3 = TRUE THEN NOW() ELSE NULL END,
            "lastUpdate" = NOW()
          WHERE o."companyId" = $1
            AND o."id" = ANY($2::text[])
        `,
        [input.companyId, toUpdate.map((order) => order.id), input.archived],
      );

      if (input.archived) {
        await dbQuery(
          `
            DELETE FROM "MonitoredOrder" mo
            WHERE mo."companyId" = $1
              AND mo."orderId" = ANY($2::text[])
          `,
          [input.companyId, toUpdate.map((order) => order.id)],
        );
      }
    }

    const toLabel = (order: {
      orderNumber: string;
      invoiceNumber: string | null;
    }) =>
      order.invoiceNumber
        ? `Pedido ${order.orderNumber} / NF ${order.invoiceNumber}`
        : `Pedido ${order.orderNumber}`;

    return {
      updatedOrders: toUpdate.map((order) => ({
        ...order,
        label: toLabel(order),
      })),
      alreadyInTargetState: alreadyInTargetState.map((order) => ({
        ...order,
        label: toLabel(order),
      })),
      notFoundIdentifiers,
    };
  }

  private async setOrderArchiveByFilter(input: {
    companyId: string;
    filter: MatchedFilter;
    archived: boolean;
  }) {
    const updateFilter = buildOrderWhereSql(input.companyId, input.filter, {
      archived: !input.archived,
    });
    const ordersToUpdateResult = await dbQuery<{ id: string }>(
      `
        SELECT o."id"
        FROM "Order" o
        WHERE ${updateFilter.whereSql}
      `,
      updateFilter.params,
    );
    const ordersToUpdate = ordersToUpdateResult.rows;

    const alreadyFilter = buildOrderWhereSql(input.companyId, input.filter, {
      archived: input.archived,
    });
    const alreadyCountResult = await dbQuery<{ total: number }>(
      `
        SELECT COUNT(*)::int AS total
        FROM "Order" o
        WHERE ${alreadyFilter.whereSql}
      `,
      alreadyFilter.params,
    );
    const alreadyInTargetStateCount = Number(alreadyCountResult.rows[0]?.total || 0);

    if (ordersToUpdate.length === 0) {
      return {
        updatedCount: 0,
        alreadyInTargetStateCount,
      };
    }

    const orderIds = ordersToUpdate.map((order) => order.id);

    await dbQuery(
      `
        UPDATE "Order" o
        SET
          "isArchived" = $3,
          "archivedAt" = CASE WHEN $3 = TRUE THEN NOW() ELSE NULL END,
          "lastUpdate" = NOW()
        WHERE o."companyId" = $1
          AND o."id" = ANY($2::text[])
      `,
      [input.companyId, orderIds, input.archived],
    );

    if (input.archived) {
      await dbQuery(
        `
          DELETE FROM "MonitoredOrder" mo
          WHERE mo."companyId" = $1
            AND mo."orderId" = ANY($2::text[])
        `,
        [input.companyId, orderIds],
      );
    }

    return {
      updatedCount: ordersToUpdate.length,
      alreadyInTargetStateCount,
    };
  }

  private async runTrackingSyncByStatusJob(input: {
    key: string;
    companyId: string;
    orderIds: string[];
  }) {
    const job = this.trackingStatusSyncJobs.get(input.key);
    if (!job) return;

    const changes: any[] = [];
    const concurrency = Math.max(1, Math.min(2, input.orderIds.length || 1));
    let nextIndex = 0;

    const workers = Array.from({ length: concurrency }, async () => {
      while (true) {
        const currentIndex = nextIndex;
        if (currentIndex >= input.orderIds.length) {
          return;
        }

        nextIndex += 1;
        const orderId = input.orderIds[currentIndex];

        try {
          const syncResult = await this.trackingService.syncOrder(orderId, input.companyId, {
            forceFinalized: true,
          });
          if (syncResult.success) {
            job.success += 1;
          } else {
            job.failed += 1;
          }
          if (syncResult.change) {
            changes.push(syncResult.change);
          }
        } catch (error) {
          job.failed += 1;
        } finally {
          job.processed += 1;
        }
      }
    });

    try {
      await Promise.all(workers);
      if (changes.length > 0) {
        await notificationService
          .registerMonitoredOrderChanges(input.companyId, changes)
          .catch(() => null);
      }
    } finally {
      this.trackingStatusSyncJobs.delete(input.key);
    }
  }

  private async resolveFilters(companyId: string, input: string): Promise<MatchedFilter | null> {
    const normalized = normalizeText(input);
    const filter: MatchedFilter = {};
    filter.period = resolvePeriodFilter(input);

    if (hasExplicitPlatformDelayHint(normalized)) {
      filter.delayedKind = 'platform';
    }

    if (hasExplicitCarrierDelayHint(normalized)) {
      if (filter.delayedKind !== 'platform') {
        filter.delayedKind = 'carrier';
      }
    }

    if (
      normalized.includes('sem movimentacao') ||
      normalized.includes('sem movimento') ||
      normalized.includes('sem atualizacao')
    ) {
      const daysMatch = normalized.match(/(\d+)\s*dias?/);
      filter.noMovementDays = daysMatch ? Number(daysMatch[1]) : 5;
    }

    for (const matcher of STATUS_MATCHERS) {
      if (matcher.phrases.some((phrase) => normalized.includes(phrase))) {
        filter.status = matcher.status;
        break;
      }
    }

    if (!filter.status && hasStatusSummaryHint(normalized)) {
      filter.statusSummary = true;
    }

    const carrierName = await this.resolveExactCarrierName(companyId, normalized);
    if (carrierName) {
      filter.carrierName = carrierName;
    }

    if (
      !filter.delayedKind &&
      carrierName &&
      hasGenericDelayTerm(normalized)
    ) {
      filter.delayedKind = 'carrier';
    }

    const salesChannel = await this.resolveExactMarketplaceName(companyId, normalized);
    if (salesChannel) {
      filter.salesChannel = salesChannel;
    }

    if (
      filter.statusSummary ||
      filter.status ||
      filter.delayedKind ||
      filter.noMovementDays ||
      filter.carrierName ||
      filter.salesChannel
    ) {
      return filter;
    }

    if (
      normalized.includes('todos os pedidos') ||
      normalized === 'relatorio' ||
      normalized.includes('relatorio geral') ||
      normalized.includes('geral de pedidos')
    ) {
      return {};
    }

    return null;
  }

  async tryHandleStructuredRequest(input: {
    companyId: string | null | undefined;
    userId?: string | null;
    text: string;
    messages?: ConversationMessage[];
  }): Promise<StructuredResult> {
    if (input.companyId && input.userId) {
      const pendingConfirmationResult =
        await this.handlePendingCarrierDeleteConfirmation({
          companyId: input.companyId,
          userId: input.userId,
          text: input.text,
        });
      if (pendingConfirmationResult) {
        return pendingConfirmationResult;
      }
    }

    if (!isStructuredIntent(input.text)) {
      return { handled: false };
    }

    if (!input.companyId) {
      return {
        handled: true,
        text: 'Nao encontrei uma empresa ativa para consultar os pedidos deste chat.',
      };
    }

    const companyResult = await dbQuery<{ id: string; name: string }>(
      `
        SELECT c."id", c."name"
        FROM "Company" c
        WHERE c."id" = $1
        LIMIT 1
      `,
      [input.companyId],
    );
    const company = companyResult.rows[0] || null;

    if (!company) {
      return {
        handled: true,
        text: 'Nao encontrei a empresa ativa para consultar os pedidos agora.',
      };
    }

    if (isManualOrderStatusUpdateIntent(input.text)) {
      const identifiers = extractOrderUpdateIdentifiers(input.text);
      const status = resolveManualOrderStatus(input.text);
      if (!status) {
        return {
          handled: true,
          text: 'Informe o status desejado. Exemplo: atualizar status para enviado dos pedidos 369714055, 369714056.',
        };
      }
      if (identifiers.length === 0) {
        return {
          handled: true,
          text: 'Informe os numeros dos pedidos, NFs, codigos de rastreio ou chaves XML para alterar o status.',
        };
      }

      const result = await this.updateOrdersManualStatus({ companyId: company.id, identifiers, status });
      const lines = result.updatedOrders.length > 0
        ? [`Status alterado para ${STATUS_LABELS[status]}: ${result.updatedOrders.join(', ')}.`]
        : [];
      if (result.skippedArchived.length > 0) lines.push(`Arquivados e nao alterados: ${result.skippedArchived.join(', ')}.`);
      if (result.notFoundIdentifiers.length > 0) lines.push(`Nao encontrados: ${result.notFoundIdentifiers.join(', ')}.`);
      return {
        handled: true,
        text: lines.join('\n') || 'Nao encontrei pedidos ativos para alterar o status.',
      };
    }

    if (isCompleteOrderIntegrationRefreshIntent(input.text)) {
      const identifiers = extractOrderUpdateIdentifiers(input.text);
      if (identifiers.length === 0) {
        return {
          handled: true,
          text: 'Informe os numeros dos pedidos, NFs, codigos de rastreio ou chaves XML para atualizar pela integradora.',
        };
      }

      const result = await this.updateOrdersFromIntegration({ companyId: company.id, identifiers });
      if (result.integrations.length === 0) {
        return { handled: true, text: 'Nao encontrei uma integradora de pedidos habilitada para esta empresa.' };
      }
      const lines = result.updatedOrders.length > 0
        ? [`Atualizacao completa concluida: ${result.updatedOrders.join(', ')}.`, 'Foram consultados status, frete, nota fiscal, chave XML, prazo e demais dados retornados pela integradora.']
        : [];
      if (result.skippedArchived.length > 0) lines.push(`Arquivados e nao atualizados: ${result.skippedArchived.join(', ')}.`);
      if (result.notFoundIdentifiers.length > 0) lines.push(`Nao encontrados: ${result.notFoundIdentifiers.join(', ')}.`);
      if (result.failedOrders.length > 0) lines.push(`Sem atualizacao: ${result.failedOrders.join(' | ')}.`);
      return {
        handled: true,
        text: lines.join('\n') || 'Nenhum pedido foi atualizado pela integradora.',
      };
    }
    if (isTrackingSyncByStatusIntent(input.text)) {
      const syncFilter = await this.resolveFilters(company.id, input.text);
      const normalizedSyncText = normalizeText(input.text);
      const wantsDelayedSync =
        !syncFilter?.status &&
        (Boolean(syncFilter?.delayedKind) || hasGenericDelayTerm(normalizedSyncText));

      if (!syncFilter?.status && !wantsDelayedSync) {
        return {
          handled: true,
          text:
            'Para atualizar o rastreio por status, informe tambem o status. Exemplo: atualizar o rastreio dos pedidos com status entregue ou status atrasado.',
        };
      }

      let syncKey = '';
      let syncLabel = '';
      let orderIds: string[] = [];

      if (syncFilter?.status) {
        if (syncFilter.status === OrderStatus.CANCELED) {
          return {
            handled: true,
            text: 'Pedidos cancelados nao entram em sincronizacao de rastreio.',
          };
        }

        syncKey = `${company.id}:STATUS:${syncFilter.status}`;
        syncLabel = `status ${STATUS_LABELS[syncFilter.status] || syncFilter.status}`;

        const ordersToSyncResult = await dbQuery<{ id: string }>(
          `
            SELECT o."id"
            FROM "Order" o
            WHERE o."companyId" = $1
              AND o."status" = $2
              AND o."isArchived" = FALSE
              AND o."status" <> $3
            ORDER BY o."lastUpdate" DESC
          `,
          [company.id, syncFilter.status, OrderStatus.CANCELED],
        );
        orderIds = ordersToSyncResult.rows
          .map((row) => String(row.id || '').trim())
          .filter(Boolean);
      } else {
        const delayedKind = syncFilter?.delayedKind || 'all';
        syncKey = `${company.id}:DELAYED:${delayedKind}`;
        syncLabel =
          delayedKind === 'carrier'
            ? 'status atrasado (transportadora)'
            : delayedKind === 'platform'
              ? 'status atrasado (plataforma)'
              : 'status atrasado';

        const delayedNow = new Date();
        const delayedOrdersResult = await dbQuery<{ id: string }>(
          `
            SELECT o."id"
            FROM "Order" o
            WHERE o."companyId" = $1
              AND o."isArchived" = FALSE
              AND o."status" NOT IN ($2, $3, $4)
              AND (
                ($5 = 'carrier' AND (
                  o."isDelayed" = TRUE
                  OR (o."carrierEstimatedDeliveryDate" IS NOT NULL AND o."carrierEstimatedDeliveryDate" < $6)
                ))
                OR ($5 = 'platform' AND (
                  o."estimatedDeliveryDate" IS NOT NULL AND o."estimatedDeliveryDate" < $6
                ))
                OR ($5 = 'all' AND (
                  o."isDelayed" = TRUE
                  OR (o."carrierEstimatedDeliveryDate" IS NOT NULL AND o."carrierEstimatedDeliveryDate" < $6)
                  OR (o."estimatedDeliveryDate" IS NOT NULL AND o."estimatedDeliveryDate" < $6)
                ))
              )
            ORDER BY o."lastUpdate" DESC
          `,
          [
            company.id,
            OrderStatus.CANCELED,
            OrderStatus.DELIVERED,
            OrderStatus.CHANNEL_LOGISTICS,
            delayedKind,
            delayedNow,
          ],
        );
        orderIds = delayedOrdersResult.rows
          .map((row) => String(row.id || '').trim())
          .filter(Boolean);
      }

      const existingJob = this.trackingStatusSyncJobs.get(syncKey);
      if (existingJob) {
        return {
          handled: true,
          text: `Ja existe uma sincronizacao em andamento para ${existingJob.label}. Progresso: ${existingJob.processed}/${existingJob.total}.`,
        };
      }

      if (orderIds.length === 0) {
        return {
          handled: true,
          text: `Nao encontrei pedidos ativos com ${syncLabel} para sincronizar.`,
        };
      }

      const nextJob: TrackingStatusSyncJob = {
        key: syncKey,
        companyId: company.id,
        status: syncFilter?.status,
        label: syncLabel,
        total: orderIds.length,
        processed: 0,
        success: 0,
        failed: 0,
        startedAt: Date.now(),
      };
      this.trackingStatusSyncJobs.set(syncKey, nextJob);
      void this.runTrackingSyncByStatusJob({
        key: syncKey,
        companyId: company.id,
        orderIds,
      });

      return {
        handled: true,
        text: `Iniciei a sincronizacao de rastreio para ${orderIds.length} pedidos com ${syncLabel}.`,
      };
    }

    if (isDeleteByCarrierIntent(input.text)) {
      if (!input.userId) {
        return {
          handled: true,
          text: 'Nao consegui identificar o usuario desta sessao para confirmar a exclusao.',
        };
      }

      const { resolvedCarriers, unresolvedTerms } =
        await this.resolveCarrierNamesFromText(company.id, input.text);

      if (resolvedCarriers.length === 0) {
        return {
          handled: true,
          text:
            unresolvedTerms.length > 0
              ? `Nao consegui identificar estas transportadoras: ${unresolvedTerms.join(', ')}.`
              : 'Nao consegui identificar as transportadoras informadas para exclusao.',
        };
      }

      const countsByCarrier = await this.countOrdersByCarriers(
        company.id,
        resolvedCarriers,
      );
      const totalToDelete = countsByCarrier.reduce(
        (accumulator, item) => accumulator + item.total,
        0,
      );

      if (totalToDelete === 0) {
        return {
          handled: true,
          text: `Nao encontrei pedidos dessas transportadoras para excluir na empresa ${company.name}.`,
        };
      }

      const key = this.buildPendingCarrierDeleteKey(company.id, input.userId);
      this.pendingCarrierDeleteOperations.set(key, {
        key,
        companyId: company.id,
        userId: input.userId,
        createdAt: Date.now(),
        expiresAt: Date.now() + ChatAssistantService.PENDING_DELETE_TTL_MS,
        carriers: resolvedCarriers,
        countsByCarrier,
      });

      const unresolvedNotice =
        unresolvedTerms.length > 0
          ? `\nNao reconheci estas entradas e elas serao ignoradas: ${unresolvedTerms.join(', ')}.`
          : '';

      return {
        handled: true,
        text: `Irei excluir ${this.formatCarrierBreakdown(
          countsByCarrier,
          'excluir',
        )}. Tem certeza?${unresolvedNotice}`,
        actions: [
          { label: 'Sim', value: 'sim', style: 'danger' },
          { label: 'Nao', value: 'nao', style: 'secondary' },
        ],
      };
    }

    if (isArchiveByCarrierIntent(input.text)) {
      const { resolvedCarriers, unresolvedTerms } =
        await this.resolveCarrierNamesFromText(company.id, input.text);

      if (resolvedCarriers.length === 0) {
        return {
          handled: true,
          text:
            unresolvedTerms.length > 0
              ? `Nao consegui identificar estas transportadoras: ${unresolvedTerms.join(', ')}.`
              : 'Nao consegui identificar as transportadoras informadas para arquivamento.',
        };
      }

      const archiveResult = await this.archiveOrdersByCarriers(
        company.id,
        resolvedCarriers,
      );
      const totalArchived = archiveResult.updatedByCarrier.reduce(
        (accumulator, item) => accumulator + item.total,
        0,
      );

      const lines = [
        totalArchived > 0
          ? `Arquivei ${this.formatCarrierBreakdown(archiveResult.updatedByCarrier, 'arquivar')} com sucesso.`
          : 'Nenhum pedido novo foi arquivado para essas transportadoras.',
      ];

      const alreadyTotal = archiveResult.alreadyArchivedByCarrier.reduce(
        (accumulator, item) => accumulator + item.total,
        0,
      );

      if (alreadyTotal > 0) {
        lines.push(
          `Ja estavam arquivados: ${this.formatCarrierBreakdown(
            archiveResult.alreadyArchivedByCarrier,
            'arquivar',
          )}.`,
        );
      }

      if (unresolvedTerms.length > 0) {
        lines.push(
          `Nao reconheci estas entradas e elas foram ignoradas: ${unresolvedTerms.join(', ')}.`,
        );
      }

      return {
        handled: true,
        text: lines.join('\n'),
      };
    }

    if (isArchiveIntent(input.text) || isUnarchiveIntent(input.text)) {
      const shouldArchive = !isUnarchiveIntent(input.text);
      const bulkArchiveRequested = hasBulkArchiveHint(input.text);

      if (bulkArchiveRequested) {
        const bulkFilter = await this.resolveFilters(company.id, input.text);

        if (hasActionableBulkArchiveFilter(bulkFilter)) {
          const filter = bulkFilter as MatchedFilter;
          const filterLabel = buildFilterLabel(filter);
          const archiveResult = await this.setOrderArchiveByFilter({
            companyId: company.id,
            filter,
            archived: shouldArchive,
          });

          const actionLabel = shouldArchive ? 'arquivados' : 'retirados do arquivo';
          const alreadyLabel = shouldArchive
            ? 'ja estavam arquivados'
            : 'ja estavam fora do arquivo';

          const lines =
            archiveResult.updatedCount > 0
              ? [
                  `${archiveResult.updatedCount} ${filterLabel} foram ${actionLabel} com sucesso.`,
                ]
              : [
                  `Nao encontrei ${filterLabel} pendentes de ${shouldArchive ? 'arquivamento' : 'desarquivamento'}.`,
                ];

          if (archiveResult.alreadyInTargetStateCount > 0) {
            lines.push(
              `${archiveResult.alreadyInTargetStateCount} ${filterLabel} ${alreadyLabel}.`,
            );
          }

          return {
            handled: true,
            text: lines.join('\n'),
          };
        }
      }

      const identifiers = extractArchiveIdentifiers(input.text);

      if (identifiers.length === 0) {
        return {
          handled: true,
          text: shouldArchive
            ? bulkArchiveRequested
              ? 'Para arquivar em lote, informe um filtro especifico. Exemplo: arquive todos os pedidos entregues.'
              : 'Para arquivar, me envie os numeros dos pedidos ou NFs. Exemplo: arquivar os pedidos 123, 456.'
            : 'Para desarquivar, me envie os numeros dos pedidos ou NFs. Exemplo: desarquivar os pedidos 123, 456.',
        };
      }

      const archiveResult = await this.setOrderArchiveByIdentifiers({
        companyId: company.id,
        identifiers,
        archived: shouldArchive,
      });

      const updatedLabels = archiveResult.updatedOrders.map((item) => item.label);
      const alreadyLabels = archiveResult.alreadyInTargetState.map(
        (item) => item.label,
      );

      const lines: string[] = [];

      if (updatedLabels.length > 0) {
        lines.push(
          shouldArchive
            ? `NFS/PEDIDOS "${updatedLabels.join(', ')}" ARQUIVADOS COM SUCESSO.`
            : `NFS/PEDIDOS "${updatedLabels.join(', ')}" RETIRADOS DO ARQUIVO COM SUCESSO.`,
        );
      }

      if (alreadyLabels.length > 0) {
        lines.push(
          shouldArchive
            ? `Ja estavam arquivados: ${alreadyLabels.join(', ')}.`
            : `Ja estavam fora do arquivo: ${alreadyLabels.join(', ')}.`,
        );
      }

      if (archiveResult.notFoundIdentifiers.length > 0) {
        lines.push(
          `Nao encontrados: ${archiveResult.notFoundIdentifiers.join(', ')}.`,
        );
      }

      return {
        handled: true,
        text:
          lines.join('\n') ||
          'Nao encontrei pedidos/NFs validos para atualizar o arquivo.',
      };
    }

    if (isMonitoredOrderIncludeIntent(input.text)) {
      const identifiers = extractMonitoredIdentifiers(input.text);
      const watchEvents = inferMonitoredWatchEvents(input.text);
      if (identifiers.length === 0) {
        return {
          handled: true,
          text:
            'Para incluir pedidos monitorados, me envie os numeros dos pedidos ou NFs. Exemplo: inclua os pedidos 123, 456 ou inclua as NFs 9981, 9982.',
        };
      }

      const result = await notificationService.addMonitoredOrders({
        companyId: company.id,
        createdById: input.userId || null,
        identifiers,
        watchEvents,
      });

      const addedLabels = result.addedOrders.map((item) => item.label);
      const alreadyLabels = result.alreadyMonitoredOrders.map((item) => item.label);
      const limitExceededLabels = Array.isArray(result.limitExceededOrders)
        ? result.limitExceededOrders.map((item: any) => item.label)
        : [];
      const maxMonitoredOrders = Number(result.maxMonitoredOrders || 10);

      if (addedLabels.length > 0) {
        const lines = [
          `NFS/PEDIDOS "${addedLabels.join(', ')}" INCLUIDOS A LISTA DE PEDIDOS MONITORADOS.`,
          `Eventos monitorados: ${describeWatchEvents(watchEvents)}.`,
        ];

        const addedOrderIds = result.addedOrders
          .map((item) => String(item.id || '').trim())
          .filter(Boolean);

        if (addedOrderIds.length > 0) {
          const requestedBy = input.userId
            ? (
                await dbQuery<{ name: string | null }>(
                  `
                    SELECT u."name"
                    FROM "User" u
                    WHERE u."id" = $1
                    LIMIT 1
                  `,
                  [input.userId],
                )
              ).rows[0] || null
            : null;

          try {
            await notificationService.sendMonitoredEnrollmentEmail({
              companyId: company.id,
              orderIds: addedOrderIds,
              watchEvents,
              requestedByName: requestedBy?.name || null,
            });
            lines.push(
              'Enviei um e-mail de confirmacao do monitoramento com os dados dos pedidos.',
            );
          } catch (emailError) {
            console.error(
              'Falha ao enviar e-mail de confirmacao do monitoramento:',
              emailError,
            );
            lines.push(
              'Nao consegui enviar o e-mail de confirmacao agora, mas o monitoramento foi ativado.',
            );
          }
        }

        if (alreadyLabels.length > 0) {
          lines.push(
            `Ja monitorados: ${alreadyLabels.join(', ')}.`,
          );
        }

        if (result.notFoundIdentifiers.length > 0) {
          lines.push(
            `Nao encontrados: ${result.notFoundIdentifiers.join(', ')}.`,
          );
        }

        if (limitExceededLabels.length > 0) {
          lines.push(
            `Limite de ${maxMonitoredOrders} monitorados por empresa atingido. Sem vaga para: ${limitExceededLabels.join(', ')}.`,
          );
        }

        return {
          handled: true,
          text: lines.join('\n'),
        };
      }

      if (alreadyLabels.length > 0) {
        return {
          handled: true,
          text: `NFS/PEDIDOS "${alreadyLabels.join(', ')}" JA ESTAO NA LISTA DE PEDIDOS MONITORADOS.`,
        };
      }

      return {
        handled: true,
        text:
          limitExceededLabels.length > 0
            ? `Limite de ${maxMonitoredOrders} pedidos monitorados por empresa atingido. Remova ou aguarde finalizacao de pedidos monitorados para liberar vagas.`
            : result.notFoundIdentifiers.length > 0
            ? `Nao encontrei esses pedidos/NFs na empresa ativa: ${result.notFoundIdentifiers.join(', ')}.`
            : 'Nao consegui identificar pedidos/NFs validos para monitorar.',
      };
    }

    const effectiveText = buildContextAwareStructuredInput(
      input.text,
      input.messages,
    );
    const filter = await this.resolveFilters(company.id, effectiveText);
    if (!filter) {
      const normalizedInput = normalizeText(effectiveText);
      const inferredCarrier = await this.resolveExactCarrierName(
        company.id,
        normalizedInput,
      );

      if (isAmbiguousDelayRequest(normalizedInput, inferredCarrier)) {
        return {
          handled: true,
          text: buildDelayClarificationPrompt(),
        };
      }

      return {
        handled: true,
        text: buildAmbiguousPrompt(),
      };
    }

    const filterLabel = buildFilterLabel(filter);
    const where = buildOrderWhereSql(company.id, filter);
    const intentKind = resolveIntentKind(effectiveText);

    const countResult = await dbQuery<{ total: number }>(
      `
        SELECT COUNT(*)::int AS total
        FROM "Order" o
        WHERE ${where.whereSql}
      `,
      where.params,
    );
    const count = Number(countResult.rows[0]?.total || 0);

    if (intentKind === 'count') {
      return {
        handled: true,
        text:
          count === 0
            ? `Hoje nao encontrei ${filterLabel} na empresa ${company.name}.`
            : `Hoje existem ${count} ${filterLabel} na empresa ${company.name}.\n\nSe quiser, eu tambem posso montar um relatorio completo disso para voce.`,
      };
    }

    if (count === 0) {
      return {
        handled: true,
        text: `Nao encontrei registros para ${filterLabel} na empresa ${company.name}.`,
      };
    }

    const ordersResult = await dbQuery<any>(
      `
        SELECT
          o."orderNumber",
          o."invoiceNumber",
          o."customerName",
          o."status",
          o."salesChannel",
          o."freightType",
          o."trackingCode",
          o."estimatedDeliveryDate",
          o."carrierEstimatedDeliveryDate",
          o."lastUpdate"
        FROM "Order" o
        WHERE ${where.whereSql}
        ORDER BY o."lastUpdate" DESC
      `,
      where.params,
    );
    const orders = ordersResult.rows;

    const generatedAt = new Date();
    const reportId = crypto.randomUUID();
    const baseUrl = getPublicBaseUrl();
    const reportsDir = getReportsDir();
    const htmlUrl = `${baseUrl}/reports/chat-insights/${reportId}.html`;
    const csvUrl = `${baseUrl}/reports/chat-insights/${reportId}.csv`;

    await fs.mkdir(reportsDir, { recursive: true });
    await Promise.all([
      fs.writeFile(
        path.join(reportsDir, `${reportId}.html`),
        buildReportHtml({
          companyName: company.name,
          filterLabel,
          total: count,
          generatedAt,
          orders,
        }),
        'utf8',
      ),
      fs.writeFile(
        path.join(reportsDir, `${reportId}.csv`),
        buildReportCsv(orders),
        'utf8',
      ),
    ]);

    const carrierStatusSummary = await this.buildCarrierStatusSummary(
      company.id,
      filter,
    );

    return {
      handled: true,
      text: [
        `Preparei um relatorio com ${count} ${filterLabel} na empresa ${company.name}.`,
        ...(carrierStatusSummary ? ['', carrierStatusSummary] : []),
        '',
        `Relatorio HTML: ${htmlUrl}`,
        `CSV: ${csvUrl}`,
      ].join('\n'),
    };
  }
}

export const chatAssistantService = new ChatAssistantService();
