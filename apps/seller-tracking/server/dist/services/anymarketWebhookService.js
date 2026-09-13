"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.anymarketWebhookService = void 0;
const crypto_1 = __importDefault(require("crypto"));
const db_1 = require("../lib/db");
const orderStatus_1 = require("../types/orderStatus");
const anymarketApiService_1 = require("./anymarketApiService");
const orderImportService_1 = require("./orderImportService");
const TERMINAL_TRACKING_STATUSES = new Set([
    orderStatus_1.OrderStatus.SHIPPED,
    orderStatus_1.OrderStatus.DELIVERY_ATTEMPT,
    orderStatus_1.OrderStatus.DELIVERED,
    orderStatus_1.OrderStatus.FAILURE,
    orderStatus_1.OrderStatus.RETURNED,
]);
const normalizeText = (value) => String(value || '').trim();
const mapAnymarketEventToStatus = (event) => {
    const normalized = normalizeText(event).toUpperCase();
    const map = {
        PENDING: orderStatus_1.OrderStatus.PENDING,
        PAID_WAITING_SHIP: orderStatus_1.OrderStatus.CREATED,
        INVOICED: orderStatus_1.OrderStatus.CREATED,
        PAID_WAITING_DELIVERY: orderStatus_1.OrderStatus.SHIPPED,
        CONCLUDED: orderStatus_1.OrderStatus.DELIVERED,
        CANCELED: orderStatus_1.OrderStatus.CANCELED,
        DELIVERY_ISSUE: orderStatus_1.OrderStatus.FAILURE,
    };
    return map[normalized] || orderStatus_1.OrderStatus.PENDING;
};
const isCanceledEvent = (event) => normalizeText(event).toUpperCase() === 'CANCELED';
const isPaidEvent = (event) => {
    const normalized = normalizeText(event).toUpperCase();
    return normalized === 'PAID_WAITING_SHIP' || normalized === 'PAGO';
};
const ALLOWED_ANYMARKET_ORDER_EVENTS = new Set([
    'PENDING',
    'PAID_WAITING_SHIP',
    'INVOICED',
    'PAID_WAITING_DELIVERY',
    'CONCLUDED',
    'CANCELED',
    // Mantido por compatibilidade com payloads legados
    'DELIVERY_ISSUE',
    // Alias legado mapeado em algumas contas
    'PAGO',
]);
class AnymarketWebhookService {
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
    async findLocalOrderByAnymarketId(anymarketOrderId) {
        const result = await (0, db_1.dbQuery)(`
        SELECT
          o."id",
          o."companyId",
          o."orderNumber",
          o."status",
          o."isArchived"
        FROM "Order" o
        WHERE o."orderNumber" = $1
        ORDER BY o."createdAt" DESC
        LIMIT 1
      `, [anymarketOrderId]);
        return result.rows[0] || null;
    }
    async listAnymarketEnabledCompanies() {
        const result = await (0, db_1.dbQuery)(`
        SELECT
          c."id"
        FROM "Company" c
        WHERE c."anymarketIntegrationEnabled" = TRUE
          AND TRIM(COALESCE(c."anymarketToken", '')) <> ''
      `);
        return result.rows;
    }
    async fetchAnymarketOrderByIdentifier(companyId, anymarketOrderId) {
        const api = new anymarketApiService_1.AnymarketApiService(companyId);
        const attempts = [
            { partnerId: anymarketOrderId },
            { marketplaceId: anymarketOrderId },
            { shippingId: anymarketOrderId },
        ];
        for (const params of attempts) {
            const response = await api.listOrders({
                limit: 5,
                offset: 0,
                ...params,
            });
            const orders = Array.isArray(response?.content) ? response.content : [];
            if (orders.length > 0) {
                return {
                    mapped: api.mapAnymarketOrderToSystem(orders[0]),
                    raw: orders[0],
                };
            }
        }
        return null;
    }
    async forceCancelOrder(orderId) {
        await (0, db_1.dbQuery)(`
        UPDATE "Order"
        SET
          "status" = $2,
          "isDelayed" = FALSE,
          "lastUpdate" = NOW()
        WHERE "id" = $1
      `, [orderId, orderStatus_1.OrderStatus.CANCELED]);
    }
    async processWebhook(input) {
        const payload = input.payload && typeof input.payload === 'object' ? input.payload : {};
        const type = normalizeText(payload?.type).toUpperCase();
        const event = normalizeText(payload?.event).toUpperCase();
        const anymarketOrderId = normalizeText(payload?.content?.id);
        if (type !== 'ORDER') {
            return {
                success: true,
                statusCode: 200,
                message: 'Webhook ANYMARKET ignorado (type diferente de ORDER).',
            };
        }
        if (!anymarketOrderId) {
            return {
                success: true,
                statusCode: 200,
                message: 'Webhook ANYMARKET recebido sem content.id.',
            };
        }
        if (event && !ALLOWED_ANYMARKET_ORDER_EVENTS.has(event)) {
            return {
                success: true,
                statusCode: 200,
                message: `Webhook ANYMARKET ignorado (evento nao suportado: ${event}).`,
            };
        }
        const localOrder = await this.findLocalOrderByAnymarketId(anymarketOrderId);
        const mappedStatus = mapAnymarketEventToStatus(event);
        if (localOrder) {
            if (isCanceledEvent(event) && localOrder.status !== orderStatus_1.OrderStatus.CANCELED) {
                await this.forceCancelOrder(localOrder.id);
                await this.recordWebhookLog({
                    companyId: localOrder.companyId,
                    type: 'ANYMARKET_WEBHOOK_PROCESSED',
                    title: 'Webhook ANYMARKET processado',
                    message: `Pedido ${localOrder.orderNumber} atualizado para cancelado via webhook ANYMARKET.`,
                    payload: {
                        anymarketOrderId,
                        event,
                        previousStatus: localOrder.status,
                        nextStatus: orderStatus_1.OrderStatus.CANCELED,
                        requestIp: input.requestIp || null,
                        userAgent: input.userAgent || null,
                    },
                });
                return {
                    success: true,
                    statusCode: 200,
                    message: 'Webhook ANYMARKET aplicado com cancelamento.',
                    companyId: localOrder.companyId,
                    orderId: localOrder.id,
                    changed: true,
                };
            }
            if (TERMINAL_TRACKING_STATUSES.has(localOrder.status)) {
                await this.recordWebhookLog({
                    companyId: localOrder.companyId,
                    type: 'ANYMARKET_WEBHOOK_IGNORED',
                    title: 'Webhook ANYMARKET ignorado',
                    message: `Pedido ${localOrder.orderNumber} mantido com rastreio predominante (${localOrder.status}).`,
                    payload: {
                        anymarketOrderId,
                        event,
                        mappedStatus,
                        currentStatus: localOrder.status,
                        requestIp: input.requestIp || null,
                        userAgent: input.userAgent || null,
                    },
                });
                return {
                    success: true,
                    statusCode: 200,
                    message: 'Webhook ANYMARKET ignorado para preservar status de rastreio.',
                    companyId: localOrder.companyId,
                    orderId: localOrder.id,
                    changed: false,
                };
            }
        }
        if (!localOrder && isCanceledEvent(event)) {
            return {
                success: true,
                statusCode: 200,
                message: 'Webhook ANYMARKET cancelado ignorado: pedido inexistente localmente.',
                companyId: null,
                orderId: null,
                changed: false,
            };
        }
        if (!localOrder && !isPaidEvent(event)) {
            return {
                success: true,
                statusCode: 200,
                message: 'Webhook ANYMARKET ignorado para pedido nao encontrado (somente pago dispara busca no ERP).',
                companyId: null,
                orderId: null,
                changed: false,
            };
        }
        const companies = await this.listAnymarketEnabledCompanies();
        const targetCompanies = localOrder
            ? companies.filter((company) => company.id === localOrder.companyId)
            : companies;
        for (const company of targetCompanies) {
            try {
                const orderFromApi = await this.fetchAnymarketOrderByIdentifier(company.id, anymarketOrderId);
                if (!orderFromApi?.mapped) {
                    continue;
                }
                const importResult = await (0, orderImportService_1.importOrdersForCompany)(company.id, [orderFromApi.mapped]);
                const createdOrder = importResult.results.createdOrders[0] || null;
                const updatedOrder = importResult.results.updatedOrders[0] || null;
                const changed = importResult.results.created > 0 ||
                    importResult.results.updated > 0 ||
                    isCanceledEvent(event);
                const orderId = createdOrder?.orderId || updatedOrder?.orderId || localOrder?.id || null;
                if (isCanceledEvent(event) && orderId) {
                    await this.forceCancelOrder(orderId);
                }
                await this.recordWebhookLog({
                    companyId: company.id,
                    type: 'ANYMARKET_WEBHOOK_PROCESSED',
                    title: 'Webhook ANYMARKET processado',
                    message: `Pedido ${anymarketOrderId} processado via webhook ANYMARKET (${event || 'SEM_EVENTO'}).`,
                    payload: {
                        anymarketOrderId,
                        event,
                        mappedStatus,
                        created: importResult.results.created,
                        updated: importResult.results.updated,
                        skipped: importResult.results.skipped,
                        errors: importResult.results.errors,
                        requestIp: input.requestIp || null,
                        userAgent: input.userAgent || null,
                    },
                });
                return {
                    success: true,
                    statusCode: 200,
                    message: 'Webhook ANYMARKET processado com sucesso.',
                    companyId: company.id,
                    orderId,
                    changed,
                };
            }
            catch {
                // continua para a proxima empresa candidata
            }
        }
        if (localOrder) {
            await this.recordWebhookLog({
                companyId: localOrder.companyId,
                type: 'ANYMARKET_WEBHOOK_IGNORED',
                title: 'Webhook ANYMARKET ignorado por configuracao',
                message: `Pedido ${localOrder.orderNumber} ignorado por filtro de status/configuracao.`,
                payload: {
                    anymarketOrderId,
                    event,
                    requestIp: input.requestIp || null,
                    userAgent: input.userAgent || null,
                },
            });
        }
        return {
            success: true,
            statusCode: 200,
            message: 'Webhook ANYMARKET recebido sem pedido elegivel para importacao.',
            companyId: localOrder?.companyId || null,
            orderId: localOrder?.id || null,
            changed: false,
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
          AND sn."type" LIKE 'ANYMARKET_WEBHOOK_%'
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
          AND sn."type" LIKE 'ANYMARKET_WEBHOOK_%'
          AND (
            sn."type" = 'ANYMARKET_WEBHOOK_IGNORED'
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
        const safeLimit = Math.max(1, Math.min(500, Number(limit) || 120));
        const logsResult = await (0, db_1.dbQuery)(`
        SELECT sn."id", sn."payload"
        FROM "SyncNotification" sn
        WHERE sn."companyId" = $1
          AND sn."category" = 'WEBHOOK'
          AND sn."type" LIKE 'ANYMARKET_WEBHOOK_%'
          AND (
            sn."type" = 'ANYMARKET_WEBHOOK_IGNORED'
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
            const anymarketOrderId = normalizeText(payload.anymarketOrderId || payload.orderNumber || payload.id);
            const event = normalizeText(payload.event).toUpperCase() || 'PAID_WAITING_SHIP';
            if (!anymarketOrderId) {
                skipped += 1;
                continue;
            }
            attempted += 1;
            const result = await this.processWebhook({
                payload: {
                    type: 'ORDER',
                    event,
                    content: {
                        id: anymarketOrderId,
                    },
                },
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
exports.anymarketWebhookService = new AnymarketWebhookService();
