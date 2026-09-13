"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TrackingService = void 0;
const crypto_1 = __importDefault(require("crypto"));
const orderStatus_1 = require("../types/orderStatus");
const prismaError_1 = require("../utils/prismaError");
const correiosTrackingService_1 = require("./correiosTrackingService");
const sswTrackingService_1 = require("./sswTrackingService");
const demoCompanyService_1 = require("./demoCompanyService");
const db_1 = require("../lib/db");
const syncCancellation_1 = require("../utils/syncCancellation");
const INTELIPOST_API_URL = 'https://tracking-graphql.intelipost.com.br/';
const INTELIPOST_INVOICE_KEY_API_BASE_URL = 'https://api.intelipost.com.br/api/v1/shipment_order/invoice_key';
const DEFAULT_CLIENT_ID = '40115';
const ROUTE_STATUSES = [
    orderStatus_1.OrderStatus.SHIPPED,
    orderStatus_1.OrderStatus.DELIVERY_ATTEMPT,
];
const FINALIZED_STATUSES = [
    orderStatus_1.OrderStatus.DELIVERED,
    orderStatus_1.OrderStatus.CANCELED,
];
const INTELIPOST_QUERY = `
query ($clientId: ID, $orderNumber: String, $orderHash: String) {
  trackingStatus(clientId: $clientId, orderNumber: $orderNumber, orderHash: $orderHash) {
    client {
      id
    }
    order {
      order_number
    }
    tracking {
      status
      status_label
      estimated_delivery_date_lp
      history {
        event_date
        status_label
        provider_message
        macro_state { code }
      }
    }
    logistic_provider {
      name
    }
    end_customer {
      address {
        city
        state
      }
    }
  }
}
`;
const mapIntelipostStatusToEnum = (status) => {
    const normalizedStatus = status ? status.toUpperCase() : '';
    if (normalizedStatus.includes('SAIU PARA ENTREGA') ||
        normalizedStatus.includes('DELIVERY_ATTEMPT') ||
        normalizedStatus.includes('TO_BE_DELIVERED') ||
        normalizedStatus.includes('SAIU PARA')) {
        return orderStatus_1.OrderStatus.DELIVERY_ATTEMPT;
    }
    if (normalizedStatus.includes('ENTREGUE') ||
        normalizedStatus.includes('DELIVERED')) {
        return orderStatus_1.OrderStatus.DELIVERED;
    }
    if (normalizedStatus.includes('EM TRÃƒâ€šNSITO') ||
        normalizedStatus.includes('SHIPPED') ||
        normalizedStatus.includes('TRANSIT')) {
        return orderStatus_1.OrderStatus.SHIPPED;
    }
    if (normalizedStatus.includes('CRIADO') || normalizedStatus.includes('CREATED')) {
        return orderStatus_1.OrderStatus.CREATED;
    }
    if (normalizedStatus.includes('FALHA') ||
        normalizedStatus.includes('FAILURE') ||
        normalizedStatus.includes('SINISTR') ||
        normalizedStatus.includes('ROUBO') ||
        normalizedStatus.includes('AVARIA')) {
        return orderStatus_1.OrderStatus.FAILURE;
    }
    if (normalizedStatus.includes('DEVOL') || normalizedStatus.includes('RETURN')) {
        return orderStatus_1.OrderStatus.RETURNED;
    }
    if (normalizedStatus.includes('CANCEL') ||
        normalizedStatus.includes('CANCELED')) {
        return orderStatus_1.OrderStatus.CANCELED;
    }
    return orderStatus_1.OrderStatus.PENDING;
};
const resolveTrackingStatus = (trackingData, events) => {
    const latestEvent = events.length > 0
        ? events.reduce((currentLatest, event) => {
            if (!currentLatest || event.eventDate > currentLatest.eventDate) {
                return event;
            }
            return currentLatest;
        })
        : null;
    return mapIntelipostStatusToEnum([
        trackingData?.tracking?.status,
        trackingData?.tracking?.status_label,
        latestEvent?.status,
        latestEvent?.description,
    ]
        .filter(Boolean)
        .join(' '));
};
const parseCarrierForecastFromText = (text) => {
    const normalizedText = String(text || '').trim();
    if (!normalizedText)
        return null;
    const match = normalizedText.match(/previs[aã]o\s+de\s+entrega\s*:\s*(\d{2})\/(\d{2})\/(\d{2,4})/i);
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
const resolveCarrierEstimatedDate = (events) => {
    const orderedTexts = events
        .slice()
        .sort((left, right) => right.eventDate.getTime() - left.eventDate.getTime())
        .map((event) => event.description);
    for (const text of orderedTexts) {
        const parsedDate = parseCarrierForecastFromText(text);
        if (parsedDate) {
            return parsedDate;
        }
    }
    return null;
};
const normalizeEventLocation = (value) => String(value || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[.;:,]+$/g, '')
    .trim();
const extractEventLocationFromText = (text) => {
    const normalizedText = normalizeEventLocation(String(text || ''));
    if (!normalizedText) {
        return { city: null, state: null };
    }
    const slashMatch = normalizedText.match(/\b([A-ZÀ-Ú0-9' -]+)\s*\/\s*([A-Z]{2})\b/i);
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
const isRouteStatus = (status) => ROUTE_STATUSES.includes(status);
const shouldSkipTerminalSync = (order) => {
    return FINALIZED_STATUSES.includes(order.status);
};
const getTerminalSyncSkipMessage = (status) => status === orderStatus_1.OrderStatus.DELIVERED ? 'Pedido ja entregue' : 'Pedido ja finalizado';
const isDeliveredTrackingEvent = (event) => {
    if (!event) {
        return false;
    }
    const normalizedStatus = String(event.status || '').trim();
    const normalizedDescription = String(event.description || '').trim();
    if (normalizedStatus.toUpperCase() === orderStatus_1.OrderStatus.DELIVERED) {
        return true;
    }
    return (mapIntelipostStatusToEnum(`${normalizedStatus} ${normalizedDescription}`.trim()) === orderStatus_1.OrderStatus.DELIVERED);
};
const toIsoString = (value) => value instanceof Date ? value.toISOString() : null;
const normalizeTrackingEventDate = (value) => {
    if (value instanceof Date) {
        return Number.isNaN(value.getTime()) ? null : value;
    }
    if (!value) {
        return null;
    }
    const parsed = new Date(String(value));
    return Number.isNaN(parsed.getTime()) ? null : parsed;
};
const normalizeTrackingEvents = (events) => {
    const uniqueKeys = new Set();
    const normalizedEvents = [];
    for (const event of events) {
        const eventDate = normalizeTrackingEventDate(event.eventDate);
        if (!eventDate) {
            continue;
        }
        const status = String(event.status || 'UNKNOWN').trim() || 'UNKNOWN';
        const description = String(event.description || 'Evento de rastreamento').trim() ||
            'Evento de rastreamento';
        const city = String(event.city || '').trim() || null;
        const state = String(event.state || '').trim() || null;
        const uniqueKey = [
            status.toUpperCase(),
            description.toUpperCase(),
            city?.toUpperCase() || '',
            state?.toUpperCase() || '',
            eventDate.toISOString(),
        ].join('|');
        if (uniqueKeys.has(uniqueKey)) {
            continue;
        }
        uniqueKeys.add(uniqueKey);
        normalizedEvents.push({
            status,
            description,
            city,
            state,
            eventDate,
        });
    }
    return normalizedEvents.sort((left, right) => right.eventDate.getTime() - left.eventDate.getTime());
};
const hasTrackingEventsUpdate = (previousEvents, nextEvents) => {
    if (previousEvents.length !== nextEvents.length) {
        return true;
    }
    for (let index = 0; index < previousEvents.length; index += 1) {
        const previous = previousEvents[index];
        const next = nextEvents[index];
        if (!next) {
            return true;
        }
        if (previous.status !== next.status ||
            previous.description !== next.description ||
            (previous.city || null) !== (next.city || null) ||
            (previous.state || null) !== (next.state || null) ||
            previous.eventDate.toISOString() !== next.eventDate.toISOString()) {
            return true;
        }
    }
    return false;
};
const DATABASE_RETRY_DELAYS_MS = [5000, 15000, 30000, 60000];
const CORREIOS_DISABLED_WARNING = 'Ha pedidos Correios ativos porem a integracao esta desabilitada, habilite ou adicione Correio, Pac e Sedex a excecao de transportadoras.';
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ensureDatabaseReady = async () => {
    await (0, db_1.dbQuery)('SELECT 1');
};
const buildEmptySnapshot = () => ({
    totalTracked: 0,
    delivered: 0,
    onRoute: 0,
    delayed: 0,
    failure: 0,
});
const DELIVERED_REVISIT_POLICY_KEY = '__deliveredRevisitPolicy';
const buildInitialDeliveredRevisitPolicy = () => ({
    version: 1,
    syncCyclesAfterDelivered: 0,
    secondRevisitAttempted: false,
    secondRevisitFoundUpdates: false,
    secondRevisitAttemptedAt: null,
    fourthRevisitAttempted: false,
    fourthRevisitAttemptedAt: null,
    completed: false,
});
const toPlainObject = (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return {};
    }
    return value;
};
const readDeliveredRevisitPolicy = (payload) => {
    const source = toPlainObject(payload)[DELIVERED_REVISIT_POLICY_KEY];
    const defaults = buildInitialDeliveredRevisitPolicy();
    const normalizedCycles = Number(source?.syncCyclesAfterDelivered);
    return {
        version: 1,
        syncCyclesAfterDelivered: Number.isFinite(normalizedCycles)
            ? Math.max(0, Math.floor(normalizedCycles))
            : defaults.syncCyclesAfterDelivered,
        secondRevisitAttempted: Boolean(source?.secondRevisitAttempted),
        secondRevisitFoundUpdates: Boolean(source?.secondRevisitFoundUpdates),
        secondRevisitAttemptedAt: typeof source?.secondRevisitAttemptedAt === 'string'
            ? source.secondRevisitAttemptedAt
            : null,
        fourthRevisitAttempted: Boolean(source?.fourthRevisitAttempted),
        fourthRevisitAttemptedAt: typeof source?.fourthRevisitAttemptedAt === 'string'
            ? source.fourthRevisitAttemptedAt
            : null,
        completed: Boolean(source?.completed),
    };
};
const attachDeliveredRevisitPolicy = (payload, policy) => {
    const basePayload = toPlainObject(payload);
    return {
        ...basePayload,
        [DELIVERED_REVISIT_POLICY_KEY]: policy,
    };
};
const sameDeliveredRevisitPolicy = (left, right) => left.syncCyclesAfterDelivered === right.syncCyclesAfterDelivered &&
    left.secondRevisitAttempted === right.secondRevisitAttempted &&
    left.secondRevisitFoundUpdates === right.secondRevisitFoundUpdates &&
    left.secondRevisitAttemptedAt === right.secondRevisitAttemptedAt &&
    left.fourthRevisitAttempted === right.fourthRevisitAttempted &&
    left.fourthRevisitAttemptedAt === right.fourthRevisitAttemptedAt &&
    left.completed === right.completed;
const planDeliveredRevisitForAutoSync = (payload) => {
    const current = readDeliveredRevisitPolicy(payload);
    if (current.completed) {
        return {
            cycle: current.syncCyclesAfterDelivered,
            shouldSync: false,
            policy: current,
            changed: false,
        };
    }
    const nextCycle = current.syncCyclesAfterDelivered + 1;
    const nextPolicy = {
        ...current,
        syncCyclesAfterDelivered: nextCycle,
    };
    const shouldSyncOnSecond = nextCycle === 2;
    const shouldSyncOnFourth = nextCycle === 4 &&
        nextPolicy.secondRevisitAttempted &&
        !nextPolicy.secondRevisitFoundUpdates;
    if (nextCycle > 4 && !shouldSyncOnFourth) {
        nextPolicy.completed = true;
    }
    return {
        cycle: nextCycle,
        shouldSync: shouldSyncOnSecond || shouldSyncOnFourth,
        policy: nextPolicy,
        changed: !sameDeliveredRevisitPolicy(current, nextPolicy),
    };
};
const applyDeliveredRevisitAttemptOutcome = (policy, cycle, foundUpdates) => {
    if (cycle !== 2 && cycle !== 4) {
        return policy;
    }
    const nowIso = new Date().toISOString();
    if (cycle === 2) {
        return {
            ...policy,
            secondRevisitAttempted: true,
            secondRevisitAttemptedAt: nowIso,
            secondRevisitFoundUpdates: foundUpdates,
            completed: foundUpdates,
        };
    }
    return {
        ...policy,
        fourthRevisitAttempted: true,
        fourthRevisitAttemptedAt: nowIso,
        completed: true,
    };
};
const parseEnvNumber = (envName, fallback, minimum, maximum) => {
    const rawValue = Number(process.env[envName]);
    if (!Number.isFinite(rawValue)) {
        return fallback;
    }
    return Math.min(maximum, Math.max(minimum, Math.floor(rawValue)));
};
class TrackingRequestScheduler {
    config;
    queue = [];
    inFlight = 0;
    startedAt = [];
    lastStartedAt = 0;
    timer = null;
    constructor(config) {
        this.config = config;
    }
    execute(run) {
        return new Promise((resolve, reject) => {
            this.queue.push({
                run: () => run(),
                resolve: (value) => resolve(value),
                reject,
            });
            this.pump();
        });
    }
    clearExpiredStarts(now) {
        if (this.config.maxRequests <= 0) {
            return;
        }
        const cutoff = now - this.config.windowMs;
        while (this.startedAt.length > 0 && this.startedAt[0] <= cutoff) {
            this.startedAt.shift();
        }
    }
    resolveStartDelay(now) {
        this.clearExpiredStarts(now);
        const spacingDelay = this.config.minIntervalMs > 0
            ? Math.max(0, this.lastStartedAt + this.config.minIntervalMs - now)
            : 0;
        let windowDelay = 0;
        if (this.config.maxRequests > 0 &&
            this.startedAt.length >= this.config.maxRequests) {
            const oldestStart = this.startedAt[0];
            windowDelay = Math.max(0, oldestStart + this.config.windowMs - now);
        }
        return Math.max(spacingDelay, windowDelay);
    }
    schedulePump(delayMs) {
        if (this.timer) {
            return;
        }
        this.timer = setTimeout(() => {
            this.timer = null;
            this.pump();
        }, Math.max(1, delayMs));
    }
    markStart(now) {
        this.lastStartedAt = now;
        if (this.config.maxRequests <= 0) {
            return;
        }
        this.clearExpiredStarts(now);
        this.startedAt.push(now);
    }
    pump() {
        if (!this.queue.length) {
            return;
        }
        while (this.queue.length > 0 && this.inFlight < this.config.maxConcurrent) {
            const now = Date.now();
            const delayMs = this.resolveStartDelay(now);
            if (delayMs > 0) {
                this.schedulePump(delayMs);
                return;
            }
            const task = this.queue.shift();
            if (!task) {
                return;
            }
            this.markStart(now);
            this.inFlight += 1;
            task
                .run()
                .then(task.resolve)
                .catch(task.reject)
                .finally(() => {
                this.inFlight = Math.max(0, this.inFlight - 1);
                this.pump();
            });
        }
    }
}
const TRACKING_REQUEST_WINDOW_MS = 60_000;
const TRACKING_SYNC_WORKER_CONCURRENCY = parseEnvNumber('TRACKING_SYNC_ORDER_CONCURRENCY', 6, 1, 12);
const TRACKING_SYNC_DELAY_MS = parseEnvNumber('SYNC_DELAY_MS', 0, 0, 5_000);
const TRACKING_INTELIPOST_TIMEOUT_MS = parseEnvNumber('TRACKING_INTELIPOST_TIMEOUT_MS', 15_000, 3_000, 120_000);
const INTELIPOST_SCHEDULER_CONFIG = {
    maxConcurrent: parseEnvNumber('TRACKING_INTELIPOST_CONCURRENCY', 3, 1, 8),
    minIntervalMs: parseEnvNumber('TRACKING_INTELIPOST_MIN_INTERVAL_MS', 140, 0, 10_000),
    maxRequests: parseEnvNumber('TRACKING_INTELIPOST_MAX_REQUESTS_PER_MINUTE', 180, 1, 2000),
    windowMs: TRACKING_REQUEST_WINDOW_MS,
};
const CORREIOS_SCHEDULER_CONFIG = {
    maxConcurrent: parseEnvNumber('TRACKING_CORREIOS_CONCURRENCY', 2, 1, 6),
    minIntervalMs: parseEnvNumber('TRACKING_CORREIOS_MIN_INTERVAL_MS', 300, 0, 10_000),
    maxRequests: parseEnvNumber('TRACKING_CORREIOS_MAX_REQUESTS_PER_MINUTE', 90, 1, 1000),
    windowMs: TRACKING_REQUEST_WINDOW_MS,
};
const SSW_SCHEDULER_CONFIG = {
    maxConcurrent: parseEnvNumber('TRACKING_SSW_CONCURRENCY', 1, 1, 3),
    minIntervalMs: parseEnvNumber('TRACKING_SSW_MIN_INTERVAL_MS', 1200, 0, 20_000),
    maxRequests: parseEnvNumber('TRACKING_SSW_MAX_REQUESTS_PER_MINUTE', 45, 1, 600),
    windowMs: TRACKING_REQUEST_WINDOW_MS,
};
const INTELIPOST_INVOICE_KEY_SCHEDULER_CONFIG = {
    maxConcurrent: parseEnvNumber('TRACKING_INTELIPOST_XML_CONCURRENCY', 2, 1, 6),
    minIntervalMs: parseEnvNumber('TRACKING_INTELIPOST_XML_MIN_INTERVAL_MS', 300, 0, 10_000),
    maxRequests: parseEnvNumber('TRACKING_INTELIPOST_XML_MAX_REQUESTS_PER_MINUTE', 120, 1, 1500),
    windowMs: TRACKING_REQUEST_WINDOW_MS,
};
const isXmlSearchIdentifier = (value) => {
    const normalized = String(value || '')
        .replace(/[^A-Za-z0-9]/g, '')
        .toUpperCase()
        .trim();
    if (!normalized)
        return false;
    if (/^\d{44}$/.test(normalized))
        return true;
    return normalized.length >= 20 && /[A-Z]/.test(normalized) && /\d/.test(normalized);
};
const isCorreiosSearchIdentifier = (value) => {
    const normalized = String(value || '')
        .replace(/[^A-Za-z0-9]/g, '')
        .toUpperCase()
        .trim();
    return /^[A-Z]{2}\d{9}[A-Z]{2}$/.test(normalized);
};
const resolveExplicitProviderSource = (value) => {
    const normalized = String(value || '')
        .trim()
        .toUpperCase();
    if (normalized === 'CORREIOS')
        return 'CORREIOS';
    if (normalized === 'SSW')
        return 'SSW';
    if (normalized === 'INTELIPOST')
        return 'INTELIPOST';
    return null;
};
const normalizeInvoiceAccessKey = (value) => String(value || '')
    .replace(/[^A-Za-z0-9]/g, '')
    .toUpperCase()
    .trim();
const resolvePreferredProvider = (order, shouldUseCorreiosProvider) => {
    const explicitSource = resolveExplicitProviderSource(order.apiRawPayload?.source);
    if (explicitSource) {
        return explicitSource;
    }
    if (shouldUseCorreiosProvider) {
        return 'CORREIOS';
    }
    const trackingUrl = String(order.apiRawPayload?.manualTrackingUrl ||
        order.apiRawPayload?.trackingUrl ||
        order.apiRawPayload?.tracking_url ||
        order.apiRawPayload?.logistic_provider?.live_tracking_url ||
        '').toLowerCase();
    if (trackingUrl.includes('ondeestameupedido.com') ||
        trackingUrl.includes('intelipost') ||
        order.apiRawPayload?.tracking ||
        order.apiRawPayload?.logistic_provider) {
        return 'INTELIPOST';
    }
    if (trackingUrl.includes('ssw.inf.br') || order.apiRawPayload?.lookupMode) {
        return 'SSW';
    }
    return null;
};
class TrackingService {
    static intelipostScheduler = new TrackingRequestScheduler(INTELIPOST_SCHEDULER_CONFIG);
    static correiosScheduler = new TrackingRequestScheduler(CORREIOS_SCHEDULER_CONFIG);
    static sswScheduler = new TrackingRequestScheduler(SSW_SCHEDULER_CONFIG);
    static intelipostInvoiceKeyScheduler = new TrackingRequestScheduler(INTELIPOST_INVOICE_KEY_SCHEDULER_CONFIG);
    async resolveCompanyTrackingConfig(companyId) {
        if (!companyId) {
            return {
                intelipostClientId: DEFAULT_CLIENT_ID,
                intelipostApiKey: '',
                sswRequireCnpjs: [],
                intelipostIntegrationEnabled: true,
                sswRequireEnabled: true,
                correiosIntegrationEnabled: true,
            };
        }
        const companyResult = await (0, db_1.dbQuery)(`
        SELECT
          c."intelipostIntegrationEnabled",
          c."sswRequireEnabled",
          c."correiosIntegrationEnabled",
          c."intelipostClientId",
          c."intelipostApiKey",
          c."sswRequireCnpjs"
        FROM "Company" c
        WHERE c."id" = $1
        LIMIT 1
      `, [companyId]);
        const company = companyResult.rows[0] || null;
        return {
            intelipostClientId: company?.intelipostIntegrationEnabled === false
                ? ''
                : String(company?.intelipostClientId || DEFAULT_CLIENT_ID).trim(),
            intelipostApiKey: company?.intelipostIntegrationEnabled === false
                ? ''
                : String(company?.intelipostApiKey || '').trim(),
            sswRequireCnpjs: company?.sswRequireEnabled === false
                ? []
                : Array.isArray(company?.sswRequireCnpjs)
                    ? company.sswRequireCnpjs.map((cnpj) => String(cnpj || '').replace(/\D/g, '').trim()).filter(Boolean)
                    : [],
            intelipostIntegrationEnabled: company?.intelipostIntegrationEnabled !== false,
            sswRequireEnabled: company?.sswRequireEnabled !== false,
            correiosIntegrationEnabled: company?.correiosIntegrationEnabled !== false,
        };
    }
    async fetchFromIntelipost(orderNumber, companyId, companyTrackingConfig) {
        try {
            const { intelipostClientId, intelipostIntegrationEnabled } = companyTrackingConfig ||
                (await this.resolveCompanyTrackingConfig(companyId));
            if (!intelipostIntegrationEnabled || !intelipostClientId) {
                return null;
            }
            const payload = {
                operationName: null,
                query: INTELIPOST_QUERY,
                variables: {
                    clientId: intelipostClientId,
                    orderHash: intelipostClientId,
                    orderNumber: orderNumber.trim(),
                },
            };
            return await TrackingService.intelipostScheduler.execute(async () => {
                const abortController = new AbortController();
                const timeout = setTimeout(() => {
                    abortController.abort();
                }, TRACKING_INTELIPOST_TIMEOUT_MS);
                try {
                    const response = await fetch(INTELIPOST_API_URL, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            Origin: 'https://status.ondeestameupedido.com',
                        },
                        body: JSON.stringify(payload),
                        signal: abortController.signal,
                    });
                    if (!response.ok) {
                        throw new Error(`HTTP ${response.status}`);
                    }
                    const json = await response.json();
                    if (json.errors) {
                        console.error('GraphQL errors:', json.errors);
                        return null;
                    }
                    return json.data?.trackingStatus;
                }
                finally {
                    clearTimeout(timeout);
                }
            });
        }
        catch (error) {
            if (error instanceof Error &&
                (error.name === 'AbortError' ||
                    error.message.includes('The operation was aborted'))) {
                console.warn(`Intelipost timeout para o pedido ${orderNumber} apos ${TRACKING_INTELIPOST_TIMEOUT_MS}ms.`);
                return null;
            }
            console.error('Erro ao consultar Intelipost:', error);
            return null;
        }
    }
    async fetchFromIntelipostByInvoiceKey(invoiceAccessKey, companyTrackingConfig) {
        try {
            const normalizedInvoiceKey = normalizeInvoiceAccessKey(invoiceAccessKey);
            const { intelipostIntegrationEnabled, intelipostApiKey, } = companyTrackingConfig || (await this.resolveCompanyTrackingConfig(null));
            if (!intelipostIntegrationEnabled ||
                !intelipostApiKey ||
                !normalizedInvoiceKey) {
                return null;
            }
            const endpoint = `${INTELIPOST_INVOICE_KEY_API_BASE_URL}/${encodeURIComponent(normalizedInvoiceKey)}`;
            return await TrackingService.intelipostInvoiceKeyScheduler.execute(async () => {
                const response = await fetch(endpoint, {
                    method: 'GET',
                    headers: {
                        Accept: 'application/json',
                        'api-key': intelipostApiKey,
                    },
                });
                if (!response.ok) {
                    return null;
                }
                const json = await response.json().catch(() => null);
                const shipmentOrder = Array.isArray(json?.content) ? json.content[0] : null;
                if (!shipmentOrder) {
                    return null;
                }
                const volumes = Array.isArray(shipmentOrder?.shipment_order_volume_array)
                    ? shipmentOrder.shipment_order_volume_array
                    : [];
                const allHistory = volumes.flatMap((volume) => Array.isArray(volume?.shipment_order_volume_state_history_array)
                    ? volume.shipment_order_volume_state_history_array
                    : []);
                const events = allHistory
                    .map((item) => ({
                    status: item?.shipment_volume_micro_state?.i18n_name ||
                        item?.shipment_order_volume_state ||
                        item?.shipment_volume_micro_state?.default_name ||
                        'UNKNOWN',
                    description: item?.provider_message ||
                        item?.shipment_volume_micro_state?.description ||
                        item?.shipment_order_volume_state_localized ||
                        item?.shipment_volume_micro_state?.name ||
                        'Evento de rastreamento',
                    city: item?.location?.city || null,
                    state: item?.location?.state || null,
                    eventDate: item?.event_date_iso || item?.event_date || item?.created_iso,
                }))
                    .filter((event) => Boolean(event.eventDate));
                const statusLabel = shipmentOrder?.shipment_order_volume_array?.[0]?.shipment_order_volume_state_localized ||
                    shipmentOrder?.shipment_order_volume_array?.[0]?.shipment_order_volume_state ||
                    shipmentOrder?.shipment_order_type ||
                    null;
                const historyForStatus = events.map((event) => ({
                    event_date: event.eventDate,
                    status_label: event.status,
                    provider_message: event.description,
                    macro_state: {
                        code: event.status,
                    },
                }));
                return {
                    source: 'INTELIPOST_INVOICE_KEY',
                    tracking: {
                        status: statusLabel || shipmentOrder?.shipment_order_type || 'UNKNOWN',
                        status_label: statusLabel || 'UNKNOWN',
                        estimated_delivery_date_lp: shipmentOrder?.estimated_delivery_date_iso ||
                            shipmentOrder?.estimated_delivery_date ||
                            null,
                        history: historyForStatus,
                    },
                    logistic_provider: {
                        name: shipmentOrder?.logistic_provider_name || null,
                    },
                    end_customer: {
                        address: {
                            city: shipmentOrder?.end_customer?.shipping_city || null,
                            state: shipmentOrder?.end_customer?.shipping_state_code ||
                                shipmentOrder?.end_customer?.shipping_state ||
                                null,
                        },
                    },
                    parsedEvents: events,
                    rawPayload: json,
                };
            });
        }
        catch (error) {
            console.error('Erro ao consultar Intelipost por chave da NF:', error);
            return null;
        }
    }
    async fetchFromSsw(order, companyTrackingConfig, options) {
        const normalizedInvoiceNumber = String(order.invoiceNumber || '')
            .replace(/\D/g, '')
            .trim();
        const normalizedInvoiceAccessKey = normalizeInvoiceAccessKey(order.invoiceAccessKey);
        const normalizedTrackingDigits = String(order.trackingCode || '')
            .replace(/\D/g, '')
            .trim();
        const normalizedTrackingKey = String(order.trackingCode || '')
            .replace(/[^A-Za-z0-9]/g, '')
            .toUpperCase()
            .trim();
        const trackingCodeLooksLikeXmlKey = normalizedTrackingKey.length === 44 ||
            (normalizedTrackingKey.length >= 20 &&
                /[A-Z]/.test(normalizedTrackingKey) &&
                /\d/.test(normalizedTrackingKey));
        const xmlLookupKey = normalizedInvoiceAccessKey || (trackingCodeLooksLikeXmlKey ? normalizedTrackingKey : '');
        const shouldAttemptXml = options?.attemptXml !== false;
        const shouldAttemptStandard = options?.attemptStandard !== false;
        const { sswRequireCnpjs } = companyTrackingConfig ||
            (await this.resolveCompanyTrackingConfig(order.companyId));
        const shouldValidateAgainstOrder = Boolean(order.customerName || order.cpf || order.cnpj || order.city || order.state);
        if (shouldAttemptXml && xmlLookupKey) {
            const result = await TrackingService.sswScheduler.execute(() => sswTrackingService_1.sswTrackingService.fetchTrackingByKey(xmlLookupKey));
            if (result) {
                if (shouldValidateAgainstOrder) {
                    const match = (0, sswTrackingService_1.matchSswTrackingToOrder)(order, result);
                    if (!match.isMatch) {
                        return null;
                    }
                }
                return {
                    ...result,
                    lookupMode: 'XML_KEY',
                };
            }
        }
        if (!shouldAttemptStandard) {
            return null;
        }
        const standardCandidates = [
            normalizedInvoiceNumber
                ? {
                    identifier: normalizedInvoiceNumber,
                    lookupMode: 'INVOICE',
                }
                : null,
            normalizedTrackingDigits && normalizedTrackingDigits !== normalizedInvoiceNumber
                ? {
                    identifier: normalizedTrackingDigits,
                    lookupMode: 'TRACKING_CODE',
                }
                : null,
        ].filter(Boolean);
        const acceptedStandardMatches = [];
        const rejectedStandardMatches = [];
        for (const candidate of standardCandidates) {
            for (const cnpj of sswRequireCnpjs) {
                const result = await TrackingService.sswScheduler.execute(() => sswTrackingService_1.sswTrackingService.fetchTrackingByInvoice(cnpj, candidate.identifier));
                if (!result) {
                    continue;
                }
                if (!shouldValidateAgainstOrder) {
                    return {
                        ...result,
                        lookupMode: candidate.lookupMode,
                        matchedCnpj: cnpj,
                    };
                }
                const match = (0, sswTrackingService_1.matchSswTrackingToOrder)(order, result);
                if (!match.isMatch) {
                    rejectedStandardMatches.push({
                        score: match.score,
                        lookupMode: candidate.lookupMode,
                        cnpj,
                        reasons: match.reasons,
                    });
                    continue;
                }
                acceptedStandardMatches.push({
                    score: match.score,
                    lookupMode: candidate.lookupMode,
                    result: match,
                    payload: {
                        ...result,
                        lookupMode: candidate.lookupMode,
                        matchedCnpj: cnpj,
                        matchScore: match.score,
                        matchReasons: match.reasons,
                    },
                });
            }
        }
        if (acceptedStandardMatches.length > 0) {
            acceptedStandardMatches.sort((left, right) => {
                if (right.score !== left.score) {
                    return right.score - left.score;
                }
                if (left.lookupMode === right.lookupMode) {
                    return 0;
                }
                return left.lookupMode === 'INVOICE' ? -1 : 1;
            });
            return acceptedStandardMatches[0].payload;
        }
        if (rejectedStandardMatches.length > 0) {
            rejectedStandardMatches.sort((left, right) => right.score - left.score);
            const bestRejected = rejectedStandardMatches[0];
            console.warn('SSW retornou dados, mas o match com o pedido foi rejeitado.', {
                orderNumber: order.orderNumber,
                invoiceNumber: order.invoiceNumber,
                trackingCode: order.trackingCode,
                lookupMode: bestRejected.lookupMode,
                cnpj: bestRejected.cnpj,
                score: bestRejected.score,
                reasons: bestRejected.reasons,
            });
        }
        return null;
    }
    async fetchFromCorreios(order, options) {
        try {
            const { correiosIntegrationEnabled } = options?.companyTrackingConfig ||
                (await this.resolveCompanyTrackingConfig(order.companyId));
            if (!correiosIntegrationEnabled) {
                if (options?.strict) {
                    throw new Error('A integracao dos Correios esta desativada para a empresa atual.');
                }
                return null;
            }
            return await TrackingService.correiosScheduler.execute(() => correiosTrackingService_1.correiosTrackingService.fetchTrackingByObjectCode(order.trackingCode, order.freightType));
        }
        catch (error) {
            if (options?.strict) {
                throw error;
            }
            console.error('Erro ao consultar Correios:', error);
            return null;
        }
    }
    async searchExternalIdentifier(identifier, companyId) {
        const rawIdentifier = String(identifier || '').trim();
        if (!rawIdentifier) {
            return null;
        }
        const companyTrackingConfig = await this.resolveCompanyTrackingConfig(companyId || null);
        const hasCorreiosCodeFormat = isCorreiosSearchIdentifier(rawIdentifier);
        const correiosResult = await this.fetchFromCorreios({
            trackingCode: rawIdentifier,
            freightType: 'Correios',
            companyId,
        }, {
            strict: hasCorreiosCodeFormat,
            companyTrackingConfig,
        });
        if (correiosResult) {
            return {
                source: 'CORREIOS',
                identifier: rawIdentifier,
                result: correiosResult,
            };
        }
        if (hasCorreiosCodeFormat) {
            return null;
        }
        const normalizedDigits = rawIdentifier.replace(/\D/g, '').trim();
        const looksLikeXml = isXmlSearchIdentifier(rawIdentifier);
        if (looksLikeXml) {
            const sswResult = await this.fetchFromSsw({
                orderNumber: rawIdentifier,
                invoiceNumber: null,
                trackingCode: rawIdentifier,
                companyId: companyId || null,
            }, companyTrackingConfig);
            if (sswResult) {
                return {
                    source: 'SSW',
                    identifier: rawIdentifier,
                    result: sswResult,
                };
            }
        }
        if (normalizedDigits) {
            const sswResult = await this.fetchFromSsw({
                orderNumber: rawIdentifier,
                invoiceNumber: normalizedDigits,
                trackingCode: normalizedDigits,
                companyId: companyId || null,
            }, companyTrackingConfig);
            if (sswResult) {
                return {
                    source: 'SSW',
                    identifier: rawIdentifier,
                    result: sswResult,
                };
            }
        }
        const intelipostResult = await this.fetchFromIntelipost(rawIdentifier, companyId, companyTrackingConfig);
        if (intelipostResult) {
            return {
                source: 'INTELIPOST',
                identifier: rawIdentifier,
                result: intelipostResult,
            };
        }
        if (looksLikeXml) {
            const intelipostInvoiceKeyResult = await this.fetchFromIntelipostByInvoiceKey(rawIdentifier, companyTrackingConfig);
            if (intelipostInvoiceKeyResult) {
                return {
                    source: 'INTELIPOST_INVOICE_KEY',
                    identifier: rawIdentifier,
                    result: intelipostInvoiceKeyResult,
                };
            }
        }
        return null;
    }
    async buildSnapshot(companyId) {
        if (!companyId) {
            return buildEmptySnapshot();
        }
        const snapshotResult = await (0, db_1.dbQuery)(`
        SELECT
          COUNT(*) FILTER (
            WHERE o."status" <> $2
          )::int AS "totalTracked",
          COUNT(*) FILTER (
            WHERE o."status" <> $2
              AND o."status" = $3
          )::int AS "delivered",
          COUNT(*) FILTER (
            WHERE o."status" <> $2
              AND o."status" IN ($4, $5)
          )::int AS "onRoute",
          COUNT(*) FILTER (
            WHERE o."status" <> $2
              AND o."isDelayed" = TRUE
          )::int AS "delayed",
          COUNT(*) FILTER (
            WHERE o."status" <> $2
              AND o."status" = $6
          )::int AS "failure"
        FROM "Order" o
        WHERE o."companyId" = $1
          AND o."isArchived" = FALSE
      `, [
            companyId,
            orderStatus_1.OrderStatus.CHANNEL_LOGISTICS,
            orderStatus_1.OrderStatus.DELIVERED,
            orderStatus_1.OrderStatus.SHIPPED,
            orderStatus_1.OrderStatus.DELIVERY_ATTEMPT,
            orderStatus_1.OrderStatus.FAILURE,
        ]);
        const snapshot = snapshotResult.rows[0];
        return {
            totalTracked: Number(snapshot?.totalTracked || 0),
            delivered: Number(snapshot?.delivered || 0),
            onRoute: Number(snapshot?.onRoute || 0),
            delayed: Number(snapshot?.delayed || 0),
            failure: Number(snapshot?.failure || 0),
        };
    }
    buildChangeBase(order) {
        return {
            orderId: order.id,
            orderNumber: String(order.orderNumber),
            trackingCode: order.trackingCode || null,
            customerName: order.customerName,
            freightType: order.freightType || null,
            previousStatus: order.status,
            currentStatus: order.status,
            previousIsDelayed: order.isDelayed,
            currentIsDelayed: order.isDelayed,
            previousEstimatedDeliveryDate: toIsoString(order.estimatedDeliveryDate),
            currentEstimatedDeliveryDate: toIsoString(order.estimatedDeliveryDate),
            lastApiSync: toIsoString(order.lastApiSync),
            changed: false,
            enteredDelivered: false,
            enteredDelay: false,
            enteredFailure: false,
            enteredRoute: false,
            latestTrackingStatus: null,
            latestTrackingDescription: null,
            errorMessage: null,
            trackingEvents: [],
        };
    }
    async syncOrder(orderId, companyId, options) {
        try {
            const order = options?.orderSnapshot && options.orderSnapshot.id === orderId
                ? options.orderSnapshot
                : (await (0, db_1.dbQuery)(`
                  SELECT
                    o."id",
                    o."companyId",
                    o."isArchived",
                    o."orderNumber",
                    o."invoiceNumber",
                    o."invoiceAccessKey",
                    o."trackingCode",
                    o."customerName",
                    o."freightType",
                    o."status",
                    o."isDelayed",
                    o."estimatedDeliveryDate",
                    o."carrierEstimatedDeliveryDate",
                    o."lastApiSync",
                    o."apiRawPayload"
                  FROM "Order" o
                  WHERE o."id" = $1
                  LIMIT 1
                `, [orderId])).rows[0] || null;
            if (!order) {
                return { success: false, message: 'Pedido nÃƒÂ£o encontrado', change: null };
            }
            if (companyId && order.companyId !== companyId) {
                return {
                    success: false,
                    message: 'Pedido nÃƒÂ£o pertence ÃƒÂ  empresa ativa',
                    change: null,
                };
            }
            const baseChange = this.buildChangeBase(order);
            const resolvedCompanyId = order.companyId || companyId || null;
            const deliveredAutoRevisitCycle = Math.max(0, Math.floor(Number(options?.deliveredAutoRevisitCycle || 0)));
            if (order.isArchived) {
                const archivedMessage = 'Pedido arquivado. Retire do arquivo para sincronizar.';
                return {
                    success: false,
                    message: archivedMessage,
                    change: {
                        ...baseChange,
                        errorMessage: archivedMessage,
                    },
                };
            }
            if (resolvedCompanyId && (await (0, demoCompanyService_1.isDemoCompanyById)(resolvedCompanyId))) {
                const blockedMessage = 'Sincronizacao desabilitada para empresa demonstrativa.';
                return {
                    success: false,
                    message: blockedMessage,
                    change: {
                        ...baseChange,
                        errorMessage: blockedMessage,
                    },
                };
            }
            if (!options?.forceFinalized && shouldSkipTerminalSync(order)) {
                let shouldKeepSkip = true;
                if (order.status === orderStatus_1.OrderStatus.DELIVERED) {
                    const latestTrackingEventResult = await (0, db_1.dbQuery)(`
              SELECT
                te."status",
                te."description"
              FROM "TrackingEvent" te
              WHERE te."orderId" = $1
              ORDER BY te."eventDate" DESC
              LIMIT 1
            `, [orderId]);
                    const latestTrackingEvent = latestTrackingEventResult.rows[0] || null;
                    // Se o pedido esta "entregue" no Order, mas o historico ainda nao chegou em
                    // evento de entrega, permitimos sync para corrigir o timeline.
                    if (!isDeliveredTrackingEvent(latestTrackingEvent)) {
                        shouldKeepSkip = false;
                    }
                }
                if (shouldKeepSkip) {
                    const terminalMessage = getTerminalSyncSkipMessage(order.status);
                    return {
                        success: false,
                        message: terminalMessage,
                        change: {
                            ...baseChange,
                            errorMessage: terminalMessage,
                        },
                    };
                }
            }
            const shouldUseCorreiosProvider = correiosTrackingService_1.correiosTrackingService.shouldUseForCarrier(order.freightType);
            const companyTrackingConfig = options?.companyTrackingConfig ||
                (await this.resolveCompanyTrackingConfig(order.companyId || companyId || null));
            const shouldTryCorreios = shouldUseCorreiosProvider &&
                companyTrackingConfig.correiosIntegrationEnabled !== false;
            const fallbackInvoiceAccessKey = order.invoiceAccessKey ||
                order.apiRawPayload?.invoiceAccessKey ||
                order.apiRawPayload?.invoice?.accessKey ||
                null;
            const hasInvoiceAccessKey = Boolean(normalizeInvoiceAccessKey(fallbackInvoiceAccessKey));
            let correiosTrackingData = null;
            let sswTrackingData = null;
            let intelipostTrackingData = null;
            let intelipostInvoiceKeyTrackingData = null;
            const tryCorreios = async () => {
                if (correiosTrackingData || !shouldTryCorreios)
                    return;
                correiosTrackingData = await this.fetchFromCorreios({
                    trackingCode: order.trackingCode,
                    freightType: order.freightType,
                    companyId: order.companyId || companyId || null,
                }, {
                    companyTrackingConfig,
                });
            };
            const trySswXmlByInvoiceKey = async () => {
                if (correiosTrackingData || sswTrackingData)
                    return;
                sswTrackingData = await this.fetchFromSsw({
                    orderNumber: order.orderNumber,
                    invoiceNumber: order.invoiceNumber,
                    invoiceAccessKey: fallbackInvoiceAccessKey,
                    trackingCode: order.trackingCode,
                    companyId: order.companyId || companyId || null,
                }, companyTrackingConfig, {
                    attemptXml: true,
                    attemptStandard: false,
                });
            };
            const trySswByInvoiceAndCnpj = async () => {
                if (correiosTrackingData || sswTrackingData)
                    return;
                sswTrackingData = await this.fetchFromSsw({
                    orderNumber: order.orderNumber,
                    invoiceNumber: order.invoiceNumber,
                    invoiceAccessKey: fallbackInvoiceAccessKey,
                    trackingCode: order.trackingCode,
                    companyId: order.companyId || companyId || null,
                }, companyTrackingConfig, {
                    attemptXml: false,
                    attemptStandard: true,
                });
            };
            const tryIntelipost = async () => {
                if (correiosTrackingData || sswTrackingData || intelipostTrackingData)
                    return;
                intelipostTrackingData = await this.fetchFromIntelipost(order.orderNumber, order.companyId || companyId, companyTrackingConfig);
            };
            const tryIntelipostByInvoiceKey = async () => {
                if (correiosTrackingData ||
                    sswTrackingData ||
                    intelipostTrackingData ||
                    intelipostInvoiceKeyTrackingData) {
                    return;
                }
                intelipostInvoiceKeyTrackingData =
                    await this.fetchFromIntelipostByInvoiceKey(fallbackInvoiceAccessKey, companyTrackingConfig);
            };
            if (hasInvoiceAccessKey) {
                await trySswXmlByInvoiceKey();
                await tryIntelipostByInvoiceKey();
                await trySswByInvoiceAndCnpj();
                await tryIntelipost();
                await tryCorreios();
            }
            else {
                await trySswByInvoiceAndCnpj();
                await tryIntelipost();
                await tryCorreios();
            }
            const trackingData = correiosTrackingData ||
                sswTrackingData ||
                intelipostTrackingData ||
                intelipostInvoiceKeyTrackingData;
            const selectedProvider = correiosTrackingData
                ? 'CORREIOS'
                : sswTrackingData
                    ? 'SSW'
                    : (intelipostTrackingData || intelipostInvoiceKeyTrackingData)
                        ? 'INTELIPOST'
                        : null;
            if (!trackingData) {
                const syncedAt = new Date();
                const noDataErrorMessage = shouldUseCorreiosProvider && !shouldTryCorreios
                    ? 'Integracao Correios desabilitada e sem dados nas demais integradoras'
                    : shouldUseCorreiosProvider
                        ? 'Sem dados dos Correios e das demais integradoras'
                        : 'Sem dados da SSW e da Intelipost (ordem/chave NF)';
                const currentDeliveredPolicy = readDeliveredRevisitPolicy(order.apiRawPayload);
                const nextDeliveredPolicy = deliveredAutoRevisitCycle > 0
                    ? applyDeliveredRevisitAttemptOutcome(currentDeliveredPolicy, deliveredAutoRevisitCycle, false)
                    : currentDeliveredPolicy;
                const shouldPersistDeliveredPolicy = deliveredAutoRevisitCycle > 0 &&
                    !sameDeliveredRevisitPolicy(currentDeliveredPolicy, nextDeliveredPolicy);
                await (0, db_1.dbQuery)(`
            UPDATE "Order"
            SET
              "lastApiError" = $2,
              "lastApiSync" = $3,
              "apiRawPayload" = CASE
                WHEN $4::jsonb IS NULL THEN "apiRawPayload"
                ELSE $4::jsonb
              END,
              "lastUpdate" = NOW()
            WHERE "id" = $1
          `, [
                    orderId,
                    noDataErrorMessage,
                    syncedAt,
                    shouldPersistDeliveredPolicy
                        ? JSON.stringify(attachDeliveredRevisitPolicy(order.apiRawPayload, nextDeliveredPolicy))
                        : null,
                ]);
                return {
                    success: false,
                    message: shouldUseCorreiosProvider
                        ? 'Sem dados de rastreio nas integradoras ativas'
                        : 'Sem dados de rastreio na SSW e na Intelipost',
                    change: {
                        ...baseChange,
                        lastApiSync: syncedAt.toISOString(),
                        errorMessage: noDataErrorMessage,
                    },
                };
            }
            const usingCorreios = selectedProvider === 'CORREIOS' ||
                ('source' in trackingData && trackingData.source === 'CORREIOS');
            const usingSsw = selectedProvider === 'SSW' ||
                ('source' in trackingData && trackingData.source === 'SSW');
            const providerEvents = usingSsw || usingCorreios
                ? trackingData.events.map((event) => ({
                    status: event.status,
                    description: event.description,
                    city: event.city,
                    state: event.state,
                    eventDate: event.eventDate,
                }))
                : Array.isArray(trackingData.parsedEvents)
                    ? trackingData.parsedEvents.map((event) => ({
                        status: event.status,
                        description: event.description,
                        city: event.city,
                        state: event.state,
                        eventDate: event.eventDate,
                    }))
                    : (trackingData.tracking.history || []).map((historyItem) => {
                        const description = historyItem.provider_message || historyItem.status_label;
                        const parsedLocation = extractEventLocationFromText(description);
                        return {
                            status: historyItem.macro_state?.code || 'UNKNOWN',
                            description,
                            city: parsedLocation.city,
                            state: parsedLocation.state,
                            eventDate: historyItem.event_date,
                        };
                    });
            const normalizedProviderEvents = normalizeTrackingEvents(providerEvents);
            const existingEventsResult = await (0, db_1.dbQuery)(`
          SELECT
            te."status",
            te."description",
            te."city",
            te."state",
            te."eventDate"
          FROM "TrackingEvent" te
          WHERE te."orderId" = $1
        `, [orderId]);
            const existingEvents = normalizeTrackingEvents(existingEventsResult.rows.map((row) => ({
                status: row.status,
                description: row.description,
                city: row.city,
                state: row.state,
                eventDate: row.eventDate,
            })));
            const events = normalizedProviderEvents.length > 0
                ? normalizedProviderEvents
                : existingEvents;
            const foundTrackingUpdates = hasTrackingEventsUpdate(existingEvents, events);
            const newStatus = usingSsw || usingCorreios
                ? trackingData.status
                : resolveTrackingStatus(trackingData, events);
            const carrierEstimatedDate = usingSsw
                ? trackingData.carrierEstimatedDate
                : usingCorreios
                    ? trackingData.carrierEstimatedDate
                    : resolveCarrierEstimatedDate(events);
            const estimatedDate = order.estimatedDeliveryDate;
            const isDelayed = Boolean(carrierEstimatedDate) &&
                ![
                    orderStatus_1.OrderStatus.DELIVERED,
                    orderStatus_1.OrderStatus.FAILURE,
                    orderStatus_1.OrderStatus.RETURNED,
                    orderStatus_1.OrderStatus.CANCELED,
                    orderStatus_1.OrderStatus.CHANNEL_LOGISTICS,
                ].includes(newStatus) &&
                new Date() > carrierEstimatedDate;
            const syncedAt = new Date();
            const currentFreightType = usingCorreios
                ? order.freightType || trackingData.freightType || 'Correios'
                : usingSsw
                    ? trackingData.freightType || order.freightType || null
                    : trackingData.logistic_provider?.name || order.freightType || null;
            const providerRawPayload = usingCorreios
                ? {
                    source: 'CORREIOS',
                    trackingUrl: trackingData.trackingUrl,
                    objectCode: trackingData.objectCode,
                    ...trackingData.rawPayload,
                }
                : usingSsw
                    ? {
                        source: 'SSW',
                        lookupMode: trackingData.lookupMode || 'INVOICE',
                        ...trackingData.rawPayload,
                    }
                    : {
                        source: trackingData?.source === 'INTELIPOST_INVOICE_KEY'
                            ? 'INTELIPOST_INVOICE_KEY'
                            : 'INTELIPOST',
                        ...trackingData,
                    };
            const deliveredPolicyBase = order.status !== orderStatus_1.OrderStatus.DELIVERED && newStatus === orderStatus_1.OrderStatus.DELIVERED
                ? buildInitialDeliveredRevisitPolicy()
                : readDeliveredRevisitPolicy(order.apiRawPayload);
            const deliveredPolicyWithAttempt = deliveredAutoRevisitCycle > 0
                ? applyDeliveredRevisitAttemptOutcome(deliveredPolicyBase, deliveredAutoRevisitCycle, foundTrackingUpdates)
                : deliveredPolicyBase;
            const rawPayload = attachDeliveredRevisitPolicy(providerRawPayload, deliveredPolicyWithAttempt);
            await (0, db_1.withDbTransaction)(async (client) => {
                await client.query(`
            UPDATE "Order"
            SET
              "status" = $2,
              "freightType" = $3,
              "estimatedDeliveryDate" = $4,
              "carrierEstimatedDeliveryDate" = $5,
              "isDelayed" = $6,
              "lastApiSync" = $7,
              "lastApiError" = NULL,
              "apiRawPayload" = $8::jsonb,
              "lastUpdate" = NOW()
            WHERE "id" = $1
          `, [
                    orderId,
                    newStatus,
                    currentFreightType,
                    estimatedDate,
                    carrierEstimatedDate,
                    isDelayed || false,
                    syncedAt,
                    rawPayload ? JSON.stringify(rawPayload) : null,
                ]);
                await client.query(`
            DELETE FROM "TrackingEvent"
            WHERE "orderId" = $1
          `, [orderId]);
                for (const event of events) {
                    await client.query(`
              INSERT INTO "TrackingEvent" (
                "id",
                "orderId",
                "status",
                "description",
                "city",
                "state",
                "eventDate",
                "createdAt"
              )
              VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
            `, [
                        crypto_1.default.randomUUID(),
                        orderId,
                        event.status,
                        event.description,
                        event.city,
                        event.state,
                        event.eventDate,
                    ]);
                }
            });
            const latestEvent = events.length > 0
                ? events.reduce((currentLatest, event) => {
                    if (!currentLatest || event.eventDate > currentLatest.eventDate) {
                        return event;
                    }
                    return currentLatest;
                })
                : null;
            const changed = order.status !== newStatus ||
                order.isDelayed !== Boolean(isDelayed) ||
                toIsoString(order.estimatedDeliveryDate) !== toIsoString(estimatedDate) ||
                toIsoString(order.carrierEstimatedDeliveryDate) !==
                    toIsoString(carrierEstimatedDate) ||
                (order.freightType || null) !== currentFreightType;
            return {
                success: true,
                message: usingCorreios
                    ? 'Rastreio atualizado com sucesso pelos Correios'
                    : usingSsw
                        ? 'Rastreio atualizado com sucesso pela SSW'
                        : 'Rastreio atualizado com sucesso pela Intelipost',
                change: {
                    ...baseChange,
                    freightType: currentFreightType,
                    currentStatus: newStatus,
                    currentIsDelayed: Boolean(isDelayed),
                    currentEstimatedDeliveryDate: toIsoString(estimatedDate),
                    lastApiSync: syncedAt.toISOString(),
                    changed,
                    enteredDelivered: order.status !== orderStatus_1.OrderStatus.DELIVERED &&
                        newStatus === orderStatus_1.OrderStatus.DELIVERED,
                    enteredDelay: !order.isDelayed && Boolean(isDelayed),
                    enteredFailure: order.status !== orderStatus_1.OrderStatus.FAILURE &&
                        newStatus === orderStatus_1.OrderStatus.FAILURE,
                    enteredRoute: !isRouteStatus(order.status) && isRouteStatus(newStatus),
                    latestTrackingStatus: latestEvent?.status || null,
                    latestTrackingDescription: latestEvent?.description || null,
                    trackingEvents: events
                        .slice()
                        .sort((left, right) => right.eventDate.getTime() - left.eventDate.getTime())
                        .map((event) => ({
                        status: event.status,
                        description: event.description,
                        eventDate: event.eventDate.toISOString(),
                        city: event.city,
                        state: event.state,
                    })),
                },
            };
        }
        catch (error) {
            console.error('Erro ao sincronizar rastreio:', error);
            return {
                success: false,
                message: (0, prismaError_1.toUserFacingDatabaseErrorMessage)(error, 'Erro ao sincronizar'),
                error,
                change: null,
            };
        }
    }
    async syncAllActive(companyId, options, hooks) {
        const executeSync = async () => {
            if (companyId && (await (0, demoCompanyService_1.isDemoCompanyById)(companyId))) {
                const emptySnapshot = await this.buildSnapshot(companyId);
                const blockedWarning = 'Sincronizacao automatica e manual desabilitada para empresa demonstrativa.';
                hooks?.onStart?.({ total: 0 });
                return {
                    total: 0,
                    success: 0,
                    failed: 0,
                    warnings: [blockedWarning],
                    errors: [],
                    report: {
                        companyId: companyId || '',
                        total: 0,
                        success: 0,
                        failed: 0,
                        errors: [],
                        before: emptySnapshot,
                        after: emptySnapshot,
                        changes: [],
                    },
                };
            }
            const activeOrdersResult = await (0, db_1.dbQuery)(`
          SELECT
            o."id",
            o."companyId",
            o."isArchived",
                    o."orderNumber",
                    o."invoiceNumber",
                    o."invoiceAccessKey",
                    o."trackingCode",
            o."customerName",
            o."status",
            o."isDelayed",
            o."freightType",
            o."estimatedDeliveryDate",
            o."carrierEstimatedDeliveryDate",
            o."lastApiSync",
            o."apiRawPayload"
          FROM "Order" o
          WHERE ($1::text = '' OR o."companyId" = $1)
            AND o."isArchived" = FALSE
            AND (o."freightType" IS NULL OR o."freightType" NOT IN ('ColetasME2', 'Shopee Xpress'))
            AND o."status" <> $2
          ORDER BY o."createdAt" ASC
        `, [companyId || '', orderStatus_1.OrderStatus.CANCELED]);
            const activeOrders = activeOrdersResult.rows;
            const deliveredRevisitPlanByOrderId = new Map();
            const deliveredPolicyUpdates = [];
            if (!options?.forceFinalized) {
                for (const order of activeOrders) {
                    if (order.status !== orderStatus_1.OrderStatus.DELIVERED) {
                        continue;
                    }
                    const revisitPlan = planDeliveredRevisitForAutoSync(order.apiRawPayload);
                    deliveredRevisitPlanByOrderId.set(order.id, {
                        cycle: revisitPlan.cycle,
                        shouldSync: revisitPlan.shouldSync,
                    });
                    if (revisitPlan.changed) {
                        const nextPayload = attachDeliveredRevisitPolicy(order.apiRawPayload, revisitPlan.policy);
                        order.apiRawPayload = nextPayload;
                        deliveredPolicyUpdates.push({
                            id: order.id,
                            payload: nextPayload,
                        });
                    }
                }
                if (deliveredPolicyUpdates.length > 0) {
                    await (0, db_1.withDbTransaction)(async (client) => {
                        for (const update of deliveredPolicyUpdates) {
                            await client.query(`
                  UPDATE "Order"
                  SET
                    "apiRawPayload" = $2::jsonb,
                    "lastUpdate" = NOW()
                  WHERE "id" = $1
                `, [update.id, JSON.stringify(update.payload)]);
                        }
                    });
                }
            }
            const eligibleOrders = options?.forceFinalized
                ? activeOrders
                : activeOrders.filter((order) => {
                    if (!shouldSkipTerminalSync(order)) {
                        return true;
                    }
                    if (order.status !== orderStatus_1.OrderStatus.DELIVERED) {
                        return false;
                    }
                    return deliveredRevisitPlanByOrderId.get(order.id)?.shouldSync === true;
                });
            const beforeSnapshot = await this.buildSnapshot(companyId);
            const changes = [];
            const results = {
                total: eligibleOrders.length,
                success: 0,
                failed: 0,
                warnings: [],
                errors: [],
                report: {
                    companyId: companyId || '',
                    total: eligibleOrders.length,
                    success: 0,
                    failed: 0,
                    errors: [],
                    before: beforeSnapshot,
                    after: beforeSnapshot,
                    changes,
                },
            };
            const syncDelayMs = TRACKING_SYNC_DELAY_MS;
            const sharedCompanyTrackingConfig = companyId
                ? await this.resolveCompanyTrackingConfig(companyId)
                : null;
            const hasCorreiosOrders = eligibleOrders.some((order) => correiosTrackingService_1.correiosTrackingService.shouldUseForCarrier(order.freightType));
            if (hasCorreiosOrders &&
                sharedCompanyTrackingConfig &&
                sharedCompanyTrackingConfig.correiosIntegrationEnabled === false) {
                results.warnings.push(CORREIOS_DISABLED_WARNING);
            }
            hooks?.onStart?.({ total: eligibleOrders.length });
            const indexedChanges = [];
            const workerCount = Math.max(1, Math.min(TRACKING_SYNC_WORKER_CONCURRENCY, eligibleOrders.length || 1));
            let nextOrderIndex = 0;
            let canceled = false;
            const workers = Array.from({ length: workerCount }, async () => {
                while (true) {
                    if (canceled) {
                        return;
                    }
                    if (hooks?.shouldCancel?.()) {
                        canceled = true;
                        return;
                    }
                    const currentIndex = nextOrderIndex;
                    if (currentIndex >= eligibleOrders.length) {
                        return;
                    }
                    nextOrderIndex += 1;
                    const order = eligibleOrders[currentIndex];
                    const startedAt = Date.now();
                    const syncOrderOptions = sharedCompanyTrackingConfig
                        ? {
                            ...(options || {}),
                            companyTrackingConfig: sharedCompanyTrackingConfig,
                            orderSnapshot: order,
                            deliveredAutoRevisitCycle: order.status === orderStatus_1.OrderStatus.DELIVERED
                                ? deliveredRevisitPlanByOrderId.get(order.id)?.cycle || 0
                                : 0,
                        }
                        : {
                            ...(options || {}),
                            orderSnapshot: order,
                            deliveredAutoRevisitCycle: order.status === orderStatus_1.OrderStatus.DELIVERED
                                ? deliveredRevisitPlanByOrderId.get(order.id)?.cycle || 0
                                : 0,
                        };
                    hooks?.onOrderStart?.({
                        orderNumber: String(order.orderNumber),
                        index: currentIndex + 1,
                        total: eligibleOrders.length,
                    });
                    const result = await this.syncOrder(order.id, companyId, syncOrderOptions);
                    const durationMs = Date.now() - startedAt;
                    if (result.success) {
                        results.success += 1;
                    }
                    else {
                        results.failed += 1;
                        results.errors.push(`${order.orderNumber}: ${result.message}`);
                    }
                    if (result.change) {
                        indexedChanges.push({
                            index: currentIndex,
                            change: result.change,
                        });
                    }
                    hooks?.onOrderFinish?.({
                        orderNumber: String(order.orderNumber),
                        success: !!result.success,
                        message: String(result.message || ''),
                        durationMs,
                    });
                    if (hooks?.shouldCancel?.()) {
                        canceled = true;
                        return;
                    }
                    if (syncDelayMs > 0) {
                        await new Promise((resolve) => setTimeout(resolve, syncDelayMs));
                    }
                }
            });
            await Promise.all(workers);
            if (canceled) {
                throw new syncCancellation_1.SyncCancellationError();
            }
            indexedChanges
                .sort((left, right) => left.index - right.index)
                .forEach((entry) => {
                changes.push(entry.change);
            });
            const afterSnapshot = await this.buildSnapshot(companyId);
            results.report.success = results.success;
            results.report.failed = results.failed;
            results.report.errors = [...results.errors];
            results.report.after = afterSnapshot;
            return results;
        };
        try {
            await ensureDatabaseReady();
            return await executeSync();
        }
        catch (error) {
            if ((0, prismaError_1.isDatabaseUnavailableError)(error)) {
                for (let index = 0; index < DATABASE_RETRY_DELAYS_MS.length; index += 1) {
                    const delayMs = DATABASE_RETRY_DELAYS_MS[index];
                    console.warn(`Banco indisponivel na sincronizacao. Nova tentativa ${index + 2}/${DATABASE_RETRY_DELAYS_MS.length + 1} em ${delayMs}ms.`);
                    await wait(delayMs);
                    try {
                        await ensureDatabaseReady();
                        return await executeSync();
                    }
                    catch (retryError) {
                        if (!(0, prismaError_1.isDatabaseUnavailableError)(retryError)) {
                            console.error('Erro ao sincronizar pedidos:', retryError);
                            throw retryError;
                        }
                        error = retryError;
                    }
                }
            }
            console.error('Erro ao sincronizar pedidos:', error);
            throw error;
        }
    }
}
exports.TrackingService = TrackingService;
