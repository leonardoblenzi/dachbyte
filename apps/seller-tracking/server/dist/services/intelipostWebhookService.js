"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.intelipostWebhookService = void 0;
const crypto_1 = __importDefault(require("crypto"));
const db_1 = require("../lib/db");
const orderStatus_1 = require("../types/orderStatus");
const orderImportService_1 = require("./orderImportService");
const anymarketApiService_1 = require("./anymarketApiService");
const trayApiService_1 = require("./trayApiService");
const magazordApiService_1 = require("./magazordApiService");
const jetApiService_1 = require("./jetApiService");
const normalizeInvoiceAccessKey = (value) => String(value || '')
    .replace(/[^A-Za-z0-9]/g, '')
    .toUpperCase()
    .trim();
const toDigits = (value) => String(value || '')
    .replace(/\D/g, '')
    .trim();
const toSafeText = (value, fallback = '') => {
    const text = String(value ?? '').trim();
    return text || fallback;
};
const toSafeDate = (value) => {
    if (value instanceof Date) {
        return Number.isNaN(value.getTime()) ? null : value;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
        const parsed = value > 10_000_000_000 ? new Date(value) : new Date(value * 1000);
        return Number.isNaN(parsed.getTime()) ? null : parsed;
    }
    const text = String(value || '').trim();
    if (!text)
        return null;
    const parsed = new Date(text);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
};
const mapIntelipostStatusToEnum = (status) => {
    const normalizedStatus = toSafeText(status).toUpperCase();
    if (normalizedStatus.includes('ENTREGUE') ||
        normalizedStatus.includes('DELIVERED') ||
        normalizedStatus.includes('MERCADORIA ENTREGUE')) {
        return orderStatus_1.OrderStatus.DELIVERED;
    }
    if (normalizedStatus.includes('SAIU PARA ENTREGA') ||
        normalizedStatus.includes('DELIVERY_ATTEMPT') ||
        normalizedStatus.includes('TO_BE_DELIVERED')) {
        return orderStatus_1.OrderStatus.DELIVERY_ATTEMPT;
    }
    if (normalizedStatus.includes('FALHA') ||
        normalizedStatus.includes('AUSENTE') ||
        normalizedStatus.includes('SINISTR') ||
        normalizedStatus.includes('ROUBO') ||
        normalizedStatus.includes('AVARIA')) {
        return orderStatus_1.OrderStatus.FAILURE;
    }
    if (normalizedStatus.includes('DEVOL') || normalizedStatus.includes('RETURN')) {
        return orderStatus_1.OrderStatus.RETURNED;
    }
    if (normalizedStatus.includes('CANCEL')) {
        return orderStatus_1.OrderStatus.CANCELED;
    }
    if (normalizedStatus.includes('TRANSITO') ||
        normalizedStatus.includes('TRANSIT') ||
        normalizedStatus.includes('SHIPPED') ||
        normalizedStatus.includes('UNIDADE')) {
        return orderStatus_1.OrderStatus.SHIPPED;
    }
    if (normalizedStatus.includes('CRIADO') || normalizedStatus.includes('CREATED')) {
        return orderStatus_1.OrderStatus.CREATED;
    }
    return orderStatus_1.OrderStatus.PENDING;
};
const parseCarrierForecastFromText = (text) => {
    const normalizedText = toSafeText(text);
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
const resolveCarrierEstimatedDateFromPayload = (payload) => {
    const directCandidates = [
        payload?.estimated_delivery_date?.client?.current_iso,
        payload?.estimated_delivery_date?.client?.current,
        payload?.estimated_delivery_date?.client?.original_iso,
        payload?.estimated_delivery_date?.client?.original,
        payload?.estimated_delivery_date_iso,
        payload?.estimated_delivery_date,
        payload?.tracking?.estimated_delivery_date_lp,
        payload?.tracking?.estimated_delivery_date_iso,
        payload?.tracking?.estimated_delivery_date,
    ];
    if (Array.isArray(payload?.content)) {
        for (const item of payload.content) {
            directCandidates.push(item?.estimated_delivery_date?.client?.current_iso, item?.estimated_delivery_date?.client?.current, item?.estimated_delivery_date?.client?.original_iso, item?.estimated_delivery_date?.client?.original, item?.estimated_delivery_date_iso, item?.estimated_delivery_date);
        }
    }
    for (const candidate of directCandidates) {
        const parsed = toSafeDate(candidate);
        if (parsed) {
            return parsed;
        }
    }
    return null;
};
const normalizeTrackingEvents = (events) => {
    const uniqueKeys = new Set();
    const normalizedEvents = [];
    for (const event of events) {
        const eventDate = toSafeDate(event.eventDate);
        if (!eventDate) {
            continue;
        }
        const status = toSafeText(event.status, 'UNKNOWN');
        const description = toSafeText(event.description, 'Evento de rastreamento');
        const city = toSafeText(event.city);
        const state = toSafeText(event.state).slice(0, 2).toUpperCase();
        const uniqueKey = [
            status.toUpperCase(),
            description.toUpperCase(),
            city.toUpperCase(),
            state.toUpperCase(),
            eventDate.toISOString(),
        ].join('|');
        if (uniqueKeys.has(uniqueKey)) {
            continue;
        }
        uniqueKeys.add(uniqueKey);
        normalizedEvents.push({
            status,
            description,
            city: city || null,
            state: state || null,
            eventDate,
        });
    }
    return normalizedEvents.sort((left, right) => right.eventDate.getTime() - left.eventDate.getTime());
};
const extractTrackingEventsFromShipment = (shipment) => {
    if (!shipment || typeof shipment !== 'object') {
        return [];
    }
    const stateHistory = Array.isArray(shipment.shipment_order_volume_state_history_array)
        ? shipment.shipment_order_volume_state_history_array
        : [];
    return normalizeTrackingEvents(stateHistory.map((historyItem) => {
        const stateInfo = historyItem?.shipment_volume_micro_state || {};
        const status = stateInfo?.name ||
            stateInfo?.default_name ||
            stateInfo?.i18n_name ||
            historyItem?.shipment_order_volume_state_localized ||
            historyItem?.shipment_order_volume_state ||
            'Evento';
        const description = historyItem?.provider_message ||
            historyItem?.esprinter_message ||
            historyItem?.provider_state ||
            stateInfo?.description ||
            status;
        return {
            status,
            description,
            city: historyItem?.location?.city ||
                shipment?.destination_city ||
                shipment?.shipping_city ||
                null,
            state: historyItem?.location?.state_code ||
                shipment?.destination_state ||
                shipment?.shipping_state_code ||
                null,
            eventDate: historyItem?.event_date_iso ||
                historyItem?.event_date ||
                historyItem?.created_iso ||
                historyItem?.created ||
                null,
        };
    }));
};
const extractTrackingEventsFromRootHistory = (payload) => {
    const historyItems = Array.isArray(payload?.history)
        ? payload.history
        : payload?.history && typeof payload.history === 'object'
            ? [payload.history]
            : [];
    if (historyItems.length === 0) {
        return [];
    }
    return normalizeTrackingEvents(historyItems.map((historyItem) => {
        const stateInfo = historyItem?.shipment_volume_micro_state || {};
        const status = stateInfo?.name ||
            stateInfo?.default_name ||
            stateInfo?.i18n_name ||
            historyItem?.shipment_order_volume_state_localized ||
            historyItem?.shipment_order_volume_state ||
            historyItem?.provider_state ||
            historyItem?.tracking_state ||
            'Evento';
        const description = historyItem?.provider_message ||
            historyItem?.esprinter_message ||
            historyItem?.provider_state ||
            stateInfo?.description ||
            status;
        return {
            status,
            description,
            city: historyItem?.location?.city ||
                payload?.end_customer?.shipping_city ||
                payload?.end_customer?.address?.city ||
                payload?.shipping_city ||
                null,
            state: historyItem?.location?.state_code ||
                payload?.end_customer?.shipping_state ||
                payload?.end_customer?.address?.state ||
                payload?.shipping_state_code ||
                null,
            eventDate: historyItem?.event_date_iso ||
                historyItem?.event_date ||
                historyItem?.created_iso ||
                historyItem?.created ||
                payload?.created_iso ||
                payload?.created ||
                null,
        };
    }));
};
const extractIdentifiersAndEvents = (payload) => {
    const identifiers = {
        invoiceKey: '',
        orderNumbers: [],
        trackingCode: '',
        freightType: '',
    };
    const events = [];
    const normalizedInvoiceCandidates = [
        payload?.invoice_key,
        payload?.invoiceKey,
        payload?.invoice?.invoice_key,
        payload?.invoice?.key,
        payload?.shipment_order_volume_invoice?.invoice_key,
    ]
        .map((value) => normalizeInvoiceAccessKey(value))
        .filter(Boolean);
    if (Array.isArray(payload?.content)) {
        for (const contentItem of payload.content) {
            const shipmentVolumes = Array.isArray(contentItem?.shipment_order_volume_array)
                ? contentItem.shipment_order_volume_array
                : [];
            for (const shipment of shipmentVolumes) {
                const invoiceKey = normalizeInvoiceAccessKey(shipment?.shipment_order_volume_invoice?.invoice_key);
                if (invoiceKey) {
                    normalizedInvoiceCandidates.push(invoiceKey);
                }
                const trackingCode = toSafeText(shipment?.tracking_code || shipment?.logistic_provider_tracking_code);
                if (trackingCode && !identifiers.trackingCode) {
                    identifiers.trackingCode = trackingCode;
                }
                events.push(...extractTrackingEventsFromShipment(shipment));
            }
            const orderNumberCandidates = [
                contentItem?.order_number,
                contentItem?.orderNumber,
                contentItem?.sales_order_number,
                contentItem?.external_order_numbers?.sales,
                contentItem?.external_order_numbers?.marketplace,
                contentItem?.external_order_numbers?.erp,
                contentItem?.external_order_numbers?.plataforma,
            ]
                .map((value) => toSafeText(value))
                .filter(Boolean);
            identifiers.orderNumbers.push(...orderNumberCandidates);
            if (!identifiers.freightType) {
                identifiers.freightType = toSafeText(contentItem?.delivery_method_name || contentItem?.logistic_provider_name);
            }
        }
    }
    if (!identifiers.trackingCode) {
        identifiers.trackingCode = toSafeText(payload?.tracking_code ||
            payload?.logistic_provider_tracking_code ||
            payload?.tracking?.code);
    }
    const rootEventsFromTrackingHistory = Array.isArray(payload?.tracking?.history)
        ? normalizeTrackingEvents(payload.tracking.history.map((item) => ({
            status: item?.status_label || item?.status || 'Evento',
            description: item?.provider_message || item?.status_label || 'Evento',
            city: item?.city ||
                payload?.end_customer?.address?.city ||
                payload?.shipping_address?.city ||
                null,
            state: item?.state ||
                payload?.end_customer?.address?.state ||
                payload?.shipping_address?.state ||
                null,
            eventDate: item?.event_date || item?.event_date_iso || null,
        })))
        : [];
    events.push(...rootEventsFromTrackingHistory);
    events.push(...extractTrackingEventsFromRootHistory(payload));
    if (events.length === 0) {
        const fallbackStatus = toSafeText(payload?.tracking?.status_label ||
            payload?.tracking?.status ||
            payload?.provider_state ||
            payload?.shipment_order_volume_state ||
            payload?.shipment_order_volume_state_localized ||
            payload?.status);
        const fallbackDescription = toSafeText(payload?.provider_message ||
            payload?.tracking?.provider_message ||
            payload?.message ||
            fallbackStatus);
        const fallbackDate = toSafeDate(payload?.event_date_iso ||
            payload?.event_date ||
            payload?.created_iso ||
            payload?.created);
        if (fallbackStatus || fallbackDescription) {
            events.push(...normalizeTrackingEvents([
                {
                    status: fallbackStatus || 'Evento',
                    description: fallbackDescription || 'Evento de rastreamento',
                    city: payload?.end_customer?.shipping_city ||
                        payload?.end_customer?.address?.city ||
                        payload?.shipping_city ||
                        null,
                    state: payload?.end_customer?.shipping_state ||
                        payload?.end_customer?.address?.state ||
                        payload?.shipping_state_code ||
                        null,
                    eventDate: fallbackDate || new Date(),
                },
            ]));
        }
    }
    const rootOrderNumberCandidates = [
        payload?.order_number,
        payload?.orderNumber,
        payload?.sales_order_number,
        payload?.external_order_numbers?.sales,
        payload?.external_order_numbers?.marketplace,
        payload?.external_order_numbers?.erp,
        payload?.external_order_numbers?.plataforma,
    ]
        .map((value) => toSafeText(value))
        .filter(Boolean);
    identifiers.orderNumbers.push(...rootOrderNumberCandidates);
    identifiers.freightType =
        identifiers.freightType ||
            toSafeText(payload?.delivery_method_name || payload?.logistic_provider_name);
    const normalizedEvents = normalizeTrackingEvents(events);
    identifiers.invoiceKey = normalizedInvoiceCandidates[0] || '';
    identifiers.orderNumbers = Array.from(new Set(identifiers.orderNumbers.map((value) => toSafeText(value)).filter(Boolean)));
    return {
        identifiers,
        events: normalizedEvents,
    };
};
const resolveStatusFromEventsAndPayload = (events, payload, fallbackStatus) => {
    const latestEvent = events[0];
    const statusParts = [
        latestEvent?.status,
        latestEvent?.description,
        payload?.tracking?.status,
        payload?.tracking?.status_label,
        payload?.status,
    ]
        .map((value) => toSafeText(value))
        .filter(Boolean);
    if (statusParts.length === 0) {
        return fallbackStatus;
    }
    return mapIntelipostStatusToEnum(statusParts.join(' '));
};
const buildWebhookLogMessage = (message, metadata) => {
    if (!metadata)
        return message;
    const suffix = Object.entries(metadata)
        .filter(([, value]) => value !== null && value !== undefined && value !== '')
        .map(([key, value]) => `${key}=${String(value)}`)
        .join(' ');
    return suffix ? `${message} (${suffix})` : message;
};
const shouldUseInvoiceKeyOnlyMatching = (company) => toSafeText(company?.name).toUpperCase().includes('MPOZENATO');
const normalizeOrderLookupToken = (value) => toSafeText(value)
    .replace(/[^A-Za-z0-9]/g, '')
    .toUpperCase();
class IntelipostWebhookService {
    async findCompanyApiKeyById(companyId) {
        const result = await (0, db_1.dbQuery)(`
        SELECT c."intelipostApiKey"
        FROM "Company" c
        WHERE c."id" = $1
        LIMIT 1
      `, [companyId]);
        return toSafeText(result.rows[0]?.intelipostApiKey);
    }
    async findCompanyByApiKey(apiKey) {
        const result = await (0, db_1.dbQuery)(`
        SELECT
          c."id",
          c."name",
          c."intelipostIntegrationEnabled"
        FROM "Company" c
        WHERE TRIM(COALESCE(c."intelipostApiKey", '')) = $1
        LIMIT 1
      `, [apiKey]);
        return result.rows[0] || null;
    }
    async findOrderForWebhook(companyId, identifiers, options) {
        if (identifiers.invoiceKey) {
            const invoiceResult = await (0, db_1.dbQuery)(`
          SELECT o.*
          FROM "Order" o
          WHERE o."companyId" = $1
            AND regexp_replace(UPPER(COALESCE(o."invoiceAccessKey", '')), '[^A-Z0-9]', '', 'g') = $2
          ORDER BY o."createdAt" DESC
          LIMIT 1
        `, [companyId, identifiers.invoiceKey]);
            const byInvoice = invoiceResult.rows[0] || null;
            if (byInvoice) {
                return {
                    order: byInvoice,
                    matchedBy: 'invoiceAccessKey',
                };
            }
        }
        for (const orderNumber of identifiers.orderNumbers) {
            const normalizedOrderNumber = normalizeOrderLookupToken(orderNumber);
            const digitsOnlyOrderNumber = toDigits(orderNumber);
            const numberResult = await (0, db_1.dbQuery)(`
          SELECT o.*
          FROM "Order" o
          WHERE o."companyId" = $1
            AND (
              o."orderNumber" = $2
              OR (
                $3 <> ''
                AND regexp_replace(UPPER(COALESCE(o."orderNumber", '')), '[^A-Z0-9]', '', 'g') = $3
              )
              OR (
                $4 <> ''
                AND regexp_replace(COALESCE(o."orderNumber", ''), '\D', '', 'g') = $4
              )
              OR (
                $3 <> ''
                AND (
                  regexp_replace(UPPER(COALESCE(o."apiRawPayload"->>'partnerId', '')), '[^A-Z0-9]', '', 'g') = $3
                  OR regexp_replace(UPPER(COALESCE(o."apiRawPayload"->>'marketPlaceId', '')), '[^A-Z0-9]', '', 'g') = $3
                  OR regexp_replace(UPPER(COALESCE(o."apiRawPayload"->>'shippingId', '')), '[^A-Z0-9]', '', 'g') = $3
                  OR regexp_replace(UPPER(COALESCE(o."apiRawPayload"->>'marketPlaceNumberOrder', '')), '[^A-Z0-9]', '', 'g') = $3
                  OR regexp_replace(UPPER(COALESCE(o."apiRawPayload"->>'marketPlaceID', '')), '[^A-Z0-9]', '', 'g') = $3
                  OR regexp_replace(UPPER(COALESCE(o."apiRawPayload"->'jetMeta'->>'marketPlaceNumberOrder', '')), '[^A-Z0-9]', '', 'g') = $3
                  OR regexp_replace(UPPER(COALESCE(o."apiRawPayload"->'jetMeta'->>'marketPlaceID', '')), '[^A-Z0-9]', '', 'g') = $3
                )
              )
            )
          ORDER BY o."createdAt" DESC
          LIMIT 1
        `, [companyId, orderNumber, normalizedOrderNumber, digitsOnlyOrderNumber]);
            const byOrderNumber = numberResult.rows[0] || null;
            if (byOrderNumber) {
                return {
                    order: byOrderNumber,
                    matchedBy: 'orderNumber',
                };
            }
        }
        return {
            order: null,
            matchedBy: null,
        };
    }
    async findOrderByInvoiceKeyOnly(companyId, invoiceKey) {
        const normalizedInvoiceKey = normalizeInvoiceAccessKey(invoiceKey);
        if (!normalizedInvoiceKey) {
            return null;
        }
        const invoiceResult = await (0, db_1.dbQuery)(`
        SELECT o.*
        FROM "Order" o
        WHERE o."companyId" = $1
          AND regexp_replace(UPPER(COALESCE(o."invoiceAccessKey", '')), '[^A-Z0-9]', '', 'g') = $2
        ORDER BY o."createdAt" DESC
        LIMIT 1
      `, [companyId, normalizedInvoiceKey]);
        return invoiceResult.rows[0] || null;
    }
    async getCompanyErpFlags(companyId) {
        const result = await (0, db_1.dbQuery)(`
        SELECT
          c."trayIntegrationEnabled",
          c."magazordIntegrationEnabled",
          c."anymarketIntegrationEnabled",
          c."jetIntegrationEnabled"
        FROM "Company" c
        WHERE c."id" = $1
        LIMIT 1
      `, [companyId]);
        return (result.rows[0] || {
            trayIntegrationEnabled: null,
            magazordIntegrationEnabled: null,
            anymarketIntegrationEnabled: null,
            jetIntegrationEnabled: null,
        });
    }
    resolveEnabledErpIntegrations(flags) {
        const enabled = [];
        if (flags.trayIntegrationEnabled !== false)
            enabled.push('tray');
        if (flags.magazordIntegrationEnabled === true)
            enabled.push('magazord');
        if (flags.anymarketIntegrationEnabled === true)
            enabled.push('anymarket');
        if (flags.jetIntegrationEnabled === true)
            enabled.push('jet');
        return enabled;
    }
    async fetchOrderFromTray(companyId, orderNumber) {
        const trayApi = new trayApiService_1.TrayApiService(companyId);
        const completeOrder = await trayApi.getOrderComplete(orderNumber);
        const trayOrder = completeOrder?.Order;
        if (!trayOrder) {
            return null;
        }
        return trayApi.mapTrayOrderToSystem(trayOrder);
    }
    async fetchOrderFromAnymarket(companyId, orderNumber) {
        const anymarketApi = new anymarketApiService_1.AnymarketApiService(companyId);
        const attempts = [
            { partnerId: orderNumber },
            { marketplaceId: orderNumber },
            { shippingId: orderNumber },
        ];
        for (const params of attempts) {
            const response = await anymarketApi.listOrders({
                limit: 5,
                offset: 0,
                ...params,
            });
            const orders = Array.isArray(response?.content) ? response.content : [];
            if (orders.length > 0) {
                return anymarketApi.mapAnymarketOrderToSystem(orders[0]);
            }
        }
        return null;
    }
    resolveMagazordOrderCode(candidate) {
        const code = [
            candidate?.codigo,
            candidate?.codigoPedido,
            candidate?.idPedido,
            candidate?.id,
            candidate?.codigoMarketplace,
        ]
            .map((value) => toSafeText(value))
            .find(Boolean);
        return code || null;
    }
    async fetchOrderFromMagazord(companyId, orderNumber) {
        const magazordApi = new magazordApiService_1.MagazordApiService(companyId);
        const hydrateByOrderCode = async (orderCode) => {
            const detail = await magazordApi.getOrderByCode(orderCode);
            if (!detail) {
                return null;
            }
            const trackingItems = await magazordApi.getOrderTrackingByCode(orderCode);
            return magazordApi.mapMagazordOrderToSystem({
                ...detail,
                arrayPedidoRastreio: trackingItems,
            });
        };
        const direct = await hydrateByOrderCode(orderNumber).catch(() => null);
        if (direct) {
            return direct;
        }
        const listResponse = await magazordApi.listOrders({
            limit: 5,
            page: 1,
            codigoMarketplace: orderNumber,
            orderDirection: 'desc',
        });
        const listedOrders = Array.isArray(listResponse?.data?.items)
            ? listResponse.data.items
            : [];
        for (const listedOrder of listedOrders) {
            const orderCode = this.resolveMagazordOrderCode(listedOrder);
            if (!orderCode)
                continue;
            const mappedOrder = await hydrateByOrderCode(orderCode).catch(() => null);
            if (mappedOrder) {
                return mappedOrder;
            }
        }
        return null;
    }
    async fetchOrderFromJet(companyId, orderNumber) {
        const normalizedDigits = toDigits(orderNumber);
        if (!normalizedDigits) {
            return null;
        }
        const jetApi = new jetApiService_1.JetApiService(companyId);
        const jetOrder = await jetApi.getOrderById(normalizedDigits);
        return jetApi.mapJetOrderToSystem(jetOrder);
    }
    async fetchOrderFromErpIntegration(integration, companyId, orderNumber) {
        switch (integration) {
            case 'tray':
                return this.fetchOrderFromTray(companyId, orderNumber);
            case 'magazord':
                return this.fetchOrderFromMagazord(companyId, orderNumber);
            case 'anymarket':
                return this.fetchOrderFromAnymarket(companyId, orderNumber);
            case 'jet':
                return this.fetchOrderFromJet(companyId, orderNumber);
            default:
                return null;
        }
    }
    async recoverMissingOrderFromErp(input) {
        const flags = await this.getCompanyErpFlags(input.company.id);
        const integrations = this.resolveEnabledErpIntegrations(flags);
        const orderNumbers = Array.from(new Set(input.identifiers.orderNumbers.map((value) => toSafeText(value)).filter(Boolean)));
        if (integrations.length === 0 || orderNumbers.length === 0) {
            return {
                recoveredMatch: null,
                attempts: [],
            };
        }
        const attempts = [];
        for (const integration of integrations) {
            for (const orderNumber of orderNumbers) {
                try {
                    const mappedOrder = await this.fetchOrderFromErpIntegration(integration, input.company.id, orderNumber);
                    if (!mappedOrder) {
                        attempts.push({
                            integration,
                            orderNumber,
                            imported: false,
                            message: 'Pedido nao encontrado no ERP.',
                        });
                        continue;
                    }
                    const importResult = await (0, orderImportService_1.importOrdersForCompany)(input.company.id, [mappedOrder], {
                        ignoreCarrierExceptions: true,
                    });
                    const imported = importResult.results.created > 0 || importResult.results.updated > 0;
                    attempts.push({
                        integration,
                        orderNumber,
                        imported,
                        message: imported
                            ? 'Pedido importado via ERP para processamento do webhook.'
                            : importResult.results.errors[0] ||
                                importResult.results.skippedOrders?.[0]?.reason ||
                                'Pedido retornado, mas nao importado.',
                    });
                    if (imported) {
                        const rematchOrderNumbers = Array.from(new Set([...input.identifiers.orderNumbers, toSafeText(mappedOrder.orderNumber)].filter(Boolean)));
                        const rematch = await this.findOrderForWebhook(input.company.id, {
                            invoiceKey: input.identifiers.invoiceKey,
                            orderNumbers: rematchOrderNumbers,
                        }, {
                            invoiceKeyOnly: input.invoiceKeyOnly,
                        });
                        if (rematch.order) {
                            return {
                                recoveredMatch: rematch,
                                attempts,
                            };
                        }
                    }
                }
                catch (error) {
                    attempts.push({
                        integration,
                        orderNumber,
                        imported: false,
                        message: error instanceof Error
                            ? error.message
                            : 'Falha ao consultar ERP para recuperar pedido do webhook.',
                    });
                }
            }
        }
        return {
            recoveredMatch: null,
            attempts,
        };
    }
    async recordWebhookLog(input) {
        await (0, db_1.dbQuery)(`
        INSERT INTO "SyncNotification" (
          "id",
          "companyId",
          "category",
          "type",
          "title",
          "message",
          "payload",
          "createdAt"
        )
        VALUES ($1, $2, 'WEBHOOK', $3, $4, $5, $6::jsonb, NOW())
      `, [
            crypto_1.default.randomUUID(),
            input.companyId,
            input.type,
            input.title,
            input.message,
            input.payload ? JSON.stringify(input.payload) : null,
        ]);
    }
    async readExistingTrackingEvents(orderId) {
        const result = await (0, db_1.dbQuery)(`
        SELECT
          te."status",
          te."description",
          te."city",
          te."state",
          te."eventDate"
        FROM "TrackingEvent" te
        WHERE te."orderId" = $1
        ORDER BY te."eventDate" DESC
      `, [orderId]);
        return normalizeTrackingEvents(result.rows.map((row) => ({
            status: row.status,
            description: row.description,
            city: row.city,
            state: row.state,
            eventDate: row.eventDate,
        })));
    }
    async updateOrderTrackingFromWebhook(input) {
        const order = input.order;
        const existingEvents = await this.readExistingTrackingEvents(order.id);
        const mergedEvents = normalizeTrackingEvents([
            ...existingEvents,
            ...input.webhookEvents,
        ]);
        const eventCountChanged = mergedEvents.length !== existingEvents.length;
        const nextStatus = resolveStatusFromEventsAndPayload(mergedEvents, input.payload, order.status);
        const carrierEstimatedDateFromPayload = resolveCarrierEstimatedDateFromPayload(input.payload);
        const carrierEstimatedDate = carrierEstimatedDateFromPayload ||
            resolveCarrierEstimatedDate(mergedEvents) ||
            order.carrierEstimatedDeliveryDate ||
            null;
        const estimatedDeliveryDate = order.estimatedDeliveryDate || null;
        const isDelayed = !!estimatedDeliveryDate &&
            nextStatus !== orderStatus_1.OrderStatus.DELIVERED &&
            nextStatus !== orderStatus_1.OrderStatus.CANCELED &&
            new Date(estimatedDeliveryDate).getTime() < Date.now();
        const nextFreightType = input.identifiers.freightType ||
            toSafeText(input.payload?.logistic_provider_name) ||
            toSafeText(input.payload?.delivery_method_name) ||
            order.freightType ||
            null;
        const previousPayload = order.apiRawPayload && typeof order.apiRawPayload === 'object' ? order.apiRawPayload : {};
        const nextPayload = {
            ...previousPayload,
            intelipostWebhook: {
                receivedAt: new Date().toISOString(),
                invoiceKey: input.identifiers.invoiceKey || null,
                orderNumbers: input.identifiers.orderNumbers || [],
                eventCount: mergedEvents.length,
                carrierEstimatedDeliveryDate: carrierEstimatedDate
                    ? carrierEstimatedDate.toISOString()
                    : null,
            },
        };
        const toComparableIso = (value) => toSafeDate(value)?.toISOString() || '';
        const changed = eventCountChanged ||
            order.status !== nextStatus ||
            Boolean(order.isDelayed) !== Boolean(isDelayed) ||
            toComparableIso(order.carrierEstimatedDeliveryDate) !==
                toComparableIso(carrierEstimatedDate) ||
            toSafeText(order.freightType) !== toSafeText(nextFreightType) ||
            normalizeInvoiceAccessKey(order.invoiceAccessKey) !== input.identifiers.invoiceKey ||
            (toSafeText(order.trackingCode) === '' && toSafeText(input.identifiers.trackingCode) !== '');
        await (0, db_1.withDbTransaction)(async (client) => {
            await client.query(`
          UPDATE "Order"
          SET
            "status" = $2,
            "isDelayed" = $3,
            "freightType" = $4,
            "carrierEstimatedDeliveryDate" = $5,
            "trackingCode" = $6,
            "invoiceAccessKey" = $7,
            "lastApiSync" = NOW(),
            "lastApiError" = NULL,
            "apiRawPayload" = $8::jsonb,
            "lastUpdate" = NOW()
          WHERE "id" = $1
        `, [
                order.id,
                nextStatus,
                Boolean(isDelayed),
                nextFreightType,
                carrierEstimatedDate,
                toSafeText(order.trackingCode) || input.identifiers.trackingCode || null,
                normalizeInvoiceAccessKey(order.invoiceAccessKey) || input.identifiers.invoiceKey || null,
                JSON.stringify(nextPayload),
            ]);
            if (mergedEvents.length > 0) {
                await client.query(`
            DELETE FROM "TrackingEvent"
            WHERE "orderId" = $1
          `, [order.id]);
                for (const event of mergedEvents) {
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
                        order.id,
                        event.status,
                        event.description,
                        event.city,
                        event.state,
                        event.eventDate,
                    ]);
                }
            }
        });
        const latestEvent = mergedEvents[0] || null;
        return {
            changed,
            eventCount: mergedEvents.length,
            status: nextStatus,
            isDelayed: Boolean(isDelayed),
            latestEvent,
        };
    }
    async processWebhook(input) {
        const apiKey = toSafeText(input.apiKey);
        if (!apiKey) {
            return {
                success: false,
                statusCode: 401,
                message: 'api-key nao informada',
            };
        }
        const company = await this.findCompanyByApiKey(apiKey);
        if (!company) {
            return {
                success: false,
                statusCode: 401,
                message: 'api-key invalida',
            };
        }
        if (company.intelipostIntegrationEnabled === false) {
            await this.recordWebhookLog({
                companyId: company.id,
                type: 'INTELIPOST_WEBHOOK_IGNORED',
                title: 'Webhook Intelipost ignorado',
                message: 'Integracao Intelipost desabilitada para a empresa.',
                payload: {
                    requestIp: input.requestIp || null,
                    userAgent: input.userAgent || null,
                },
            });
            return {
                success: true,
                statusCode: 200,
                message: 'Integracao Intelipost desabilitada',
                companyId: company.id,
            };
        }
        const { identifiers, events } = extractIdentifiersAndEvents(input.payload);
        const invoiceKeyOnly = shouldUseInvoiceKeyOnlyMatching(company);
        if (invoiceKeyOnly && !identifiers.invoiceKey) {
            await this.recordWebhookLog({
                companyId: company.id,
                type: 'INTELIPOST_WEBHOOK_IGNORED',
                title: 'Webhook Intelipost ignorado sem chave XML',
                message: 'Empresa MPOZENATO exige identificacao por chave XML; payload sem invoiceKey foi ignorado.',
                payload: {
                    orderNumbers: identifiers.orderNumbers,
                    trackingCode: identifiers.trackingCode || null,
                    requestIp: input.requestIp || null,
                    userAgent: input.userAgent || null,
                },
            });
            return {
                success: true,
                statusCode: 200,
                message: 'Webhook recebido sem chave XML obrigatoria para MPOZENATO.',
                companyId: company.id,
                matchedBy: null,
                eventCount: events.length,
            };
        }
        let match = await this.findOrderForWebhook(company.id, {
            invoiceKey: identifiers.invoiceKey,
            orderNumbers: identifiers.orderNumbers,
        }, {
            invoiceKeyOnly,
        });
        let recoveryAttempts = [];
        if (!match.order) {
            if (identifiers.invoiceKey) {
                const invoiceRecheck = await this.findOrderByInvoiceKeyOnly(company.id, identifiers.invoiceKey);
                if (invoiceRecheck) {
                    match = {
                        order: invoiceRecheck,
                        matchedBy: 'invoiceAccessKey',
                    };
                }
            }
        }
        if (!match.order) {
            const recovery = await this.recoverMissingOrderFromErp({
                company,
                identifiers,
                invoiceKeyOnly,
            });
            recoveryAttempts = recovery.attempts;
            const recoveredMatch = recovery.recoveredMatch;
            if (recoveredMatch?.order) {
                match = recoveredMatch;
                await this.recordWebhookLog({
                    companyId: company.id,
                    type: 'INTELIPOST_WEBHOOK_ORDER_RECOVERED',
                    title: 'Pedido recuperado via ERP para webhook Intelipost',
                    message: buildWebhookLogMessage('Pedido localizado apos consulta no ERP', {
                        orderNumber: recoveredMatch.order.orderNumber,
                        matchedBy: recoveredMatch.matchedBy,
                    }),
                    payload: {
                        invoiceKey: identifiers.invoiceKey || null,
                        orderNumbers: identifiers.orderNumbers,
                        attempts: recoveryAttempts,
                        eventCount: events.length,
                        requestIp: input.requestIp || null,
                        userAgent: input.userAgent || null,
                    },
                });
            }
        }
        if (!match.order) {
            if (identifiers.invoiceKey) {
                const invoiceRecheckAfterRecovery = await this.findOrderByInvoiceKeyOnly(company.id, identifiers.invoiceKey);
                if (invoiceRecheckAfterRecovery) {
                    match = {
                        order: invoiceRecheckAfterRecovery,
                        matchedBy: 'invoiceAccessKey',
                    };
                }
            }
        }
        if (!match.order) {
            await this.recordWebhookLog({
                companyId: company.id,
                type: 'INTELIPOST_WEBHOOK_ORDER_NOT_FOUND',
                title: 'Webhook Intelipost sem pedido correspondente',
                message: buildWebhookLogMessage('Pedido nao encontrado para webhook', {
                    invoiceKey: identifiers.invoiceKey || null,
                    orderNumber: identifiers.orderNumbers[0] || null,
                }),
                payload: {
                    invoiceKey: identifiers.invoiceKey || null,
                    orderNumbers: identifiers.orderNumbers,
                    erpRecoveryAttempts: recoveryAttempts,
                    eventCount: events.length,
                    requestIp: input.requestIp || null,
                    userAgent: input.userAgent || null,
                },
            });
            return {
                success: true,
                statusCode: 200,
                message: 'Webhook recebido sem pedido correspondente',
                companyId: company.id,
                matchedBy: null,
                eventCount: events.length,
            };
        }
        const updateResult = await this.updateOrderTrackingFromWebhook({
            order: match.order,
            payload: input.payload,
            identifiers,
            webhookEvents: events,
        });
        await this.recordWebhookLog({
            companyId: company.id,
            type: 'INTELIPOST_WEBHOOK_PROCESSED',
            title: 'Webhook Intelipost processado',
            message: buildWebhookLogMessage('Pedido atualizado via webhook', {
                orderNumber: match.order.orderNumber,
                matchedBy: match.matchedBy,
                events: updateResult.eventCount,
            }),
            payload: {
                orderId: match.order.id,
                orderNumber: match.order.orderNumber,
                matchedBy: match.matchedBy,
                changed: updateResult.changed,
                status: updateResult.status,
                isDelayed: updateResult.isDelayed,
                latestEvent: updateResult.latestEvent
                    ? {
                        status: updateResult.latestEvent.status,
                        description: updateResult.latestEvent.description,
                        city: updateResult.latestEvent.city,
                        state: updateResult.latestEvent.state,
                        eventDate: updateResult.latestEvent.eventDate?.toISOString?.() || null,
                    }
                    : null,
                invoiceKey: identifiers.invoiceKey || null,
                eventCount: updateResult.eventCount,
                requestIp: input.requestIp || null,
                userAgent: input.userAgent || null,
            },
        });
        return {
            success: true,
            statusCode: 200,
            message: 'Webhook processado com sucesso',
            companyId: company.id,
            orderId: match.order.id,
            matchedBy: match.matchedBy,
            eventCount: updateResult.eventCount,
            changed: updateResult.changed,
        };
    }
    async listWebhookLogs(companyId, limit = 100) {
        const safeLimit = Math.max(1, Math.min(500, Number(limit) || 100));
        const result = await (0, db_1.dbQuery)(`
        SELECT
          sn."id",
          sn."type",
          sn."title",
          sn."message",
          sn."payload",
          sn."createdAt"
        FROM "SyncNotification" sn
        WHERE sn."companyId" = $1
          AND sn."category" = 'WEBHOOK'
          AND sn."type" LIKE 'INTELIPOST_WEBHOOK_%'
        ORDER BY sn."createdAt" DESC
        LIMIT $2
      `, [companyId, safeLimit]);
        return result.rows.map((row) => ({
            id: String(row.id),
            type: String(row.type || ''),
            title: String(row.title || ''),
            message: String(row.message || ''),
            payload: row.payload && typeof row.payload === 'object' ? row.payload : {},
            createdAt: row.createdAt instanceof Date
                ? row.createdAt.toISOString()
                : new Date(String(row.createdAt || '')).toISOString(),
        }));
    }
    async clearFailureLogs(companyId) {
        const result = await (0, db_1.dbQuery)(`
        DELETE FROM "SyncNotification" sn
        WHERE sn."companyId" = $1
          AND sn."category" = 'WEBHOOK'
          AND sn."type" LIKE 'INTELIPOST_WEBHOOK_%'
          AND (
            sn."type" = 'INTELIPOST_WEBHOOK_ORDER_NOT_FOUND'
            OR sn."type" = 'INTELIPOST_WEBHOOK_IGNORED'
            OR sn."type" ILIKE '%FAILED%'
            OR sn."type" ILIKE '%ERROR%'
          )
        RETURNING sn."id"
      `, [companyId]);
        return {
            removed: result.rows.length,
        };
    }
    async reprocessFailureLogs(companyId, limit = 120) {
        const apiKey = await this.findCompanyApiKeyById(companyId);
        if (!apiKey) {
            return {
                attempted: 0,
                reprocessed: 0,
                stillFailed: 0,
                skipped: 0,
            };
        }
        const safeLimit = Math.max(1, Math.min(500, Number(limit) || 120));
        const logsResult = await (0, db_1.dbQuery)(`
        SELECT sn."id", sn."payload"
        FROM "SyncNotification" sn
        WHERE sn."companyId" = $1
          AND sn."category" = 'WEBHOOK'
          AND sn."type" LIKE 'INTELIPOST_WEBHOOK_%'
          AND (
            sn."type" = 'INTELIPOST_WEBHOOK_ORDER_NOT_FOUND'
            OR sn."type" = 'INTELIPOST_WEBHOOK_IGNORED'
            OR sn."type" ILIKE '%FAILED%'
            OR sn."type" ILIKE '%ERROR%'
          )
        ORDER BY sn."createdAt" DESC
        LIMIT $2
      `, [companyId, safeLimit]);
        let attempted = 0;
        let reprocessed = 0;
        let stillFailed = 0;
        let skipped = 0;
        for (const row of logsResult.rows) {
            const payload = row.payload && typeof row.payload === 'object' ? row.payload : {};
            const invoiceKey = normalizeInvoiceAccessKey(payload.invoiceKey);
            const orderNumbersFromPayload = Array.isArray(payload.orderNumbers)
                ? payload.orderNumbers
                : [];
            const firstOrderNumber = toSafeText(orderNumbersFromPayload[0] || payload.orderNumber || payload.anymarketOrderId);
            const orderNumbers = Array.from(new Set([firstOrderNumber, ...orderNumbersFromPayload.map((value) => toSafeText(value))]
                .map((value) => toSafeText(value))
                .filter(Boolean)));
            if (!invoiceKey && orderNumbers.length === 0) {
                skipped += 1;
                continue;
            }
            const syntheticPayload = {};
            if (invoiceKey) {
                syntheticPayload.invoice_key = invoiceKey;
                syntheticPayload.invoiceKey = invoiceKey;
            }
            if (orderNumbers.length > 0) {
                syntheticPayload.order_number = orderNumbers[0];
                syntheticPayload.orderNumber = orderNumbers[0];
                syntheticPayload.external_order_numbers = {
                    sales: orderNumbers[0],
                    marketplace: orderNumbers[0],
                };
                syntheticPayload.content = [
                    {
                        order_number: orderNumbers[0],
                        external_order_numbers: {
                            sales: orderNumbers[0],
                            marketplace: orderNumbers[0],
                        },
                    },
                ];
            }
            attempted += 1;
            const result = await this.processWebhook({
                apiKey,
                payload: syntheticPayload,
                requestIp: 'manual-reprocess',
                userAgent: 'admin-webhook-reprocess',
            });
            if (result.orderId) {
                reprocessed += 1;
            }
            else {
                stillFailed += 1;
            }
        }
        return {
            attempted,
            reprocessed,
            stillFailed,
            skipped,
        };
    }
}
exports.intelipostWebhookService = new IntelipostWebhookService();
