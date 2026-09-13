import crypto from 'crypto';
import { dbQuery } from '../lib/db';
import { OrderStatus } from '../types/orderStatus';
import { AnymarketApiService } from './anymarketApiService';
import { importOrdersForCompany } from './orderImportService';

type ProcessAnymarketWebhookInput = {
  payload: any;
  requestIp?: string | null;
  userAgent?: string | null;
};

type ProcessAnymarketWebhookResult = {
  success: boolean;
  statusCode: number;
  message: string;
  companyId?: string | null;
  orderId?: string | null;
  changed?: boolean;
};

type LocalOrderMatch = {
  id: string;
  companyId: string;
  orderNumber: string;
  status: OrderStatus;
  isArchived: boolean;
};

const TERMINAL_TRACKING_STATUSES = new Set<OrderStatus>([
  OrderStatus.SHIPPED,
  OrderStatus.DELIVERY_ATTEMPT,
  OrderStatus.DELIVERED,
  OrderStatus.FAILURE,
  OrderStatus.RETURNED,
]);

const normalizeText = (value: unknown) => String(value || '').trim();

const mapAnymarketEventToStatus = (event: string): OrderStatus => {
  const normalized = normalizeText(event).toUpperCase();
  const map: Record<string, OrderStatus> = {
    PENDING: OrderStatus.PENDING,
    PAID_WAITING_SHIP: OrderStatus.CREATED,
    INVOICED: OrderStatus.CREATED,
    PAID_WAITING_DELIVERY: OrderStatus.SHIPPED,
    CONCLUDED: OrderStatus.DELIVERED,
    CANCELED: OrderStatus.CANCELED,
    DELIVERY_ISSUE: OrderStatus.FAILURE,
  };

  return map[normalized] || OrderStatus.PENDING;
};

const isCanceledEvent = (event: string) =>
  normalizeText(event).toUpperCase() === 'CANCELED';

const isPaidEvent = (event: string) => {
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
  private async recordWebhookLog(input: {
    companyId: string;
    type: string;
    title: string;
    message: string;
    payload?: Record<string, unknown> | null;
  }) {
    await dbQuery(
      `
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
      `,
      [
        crypto.randomUUID(),
        input.companyId,
        input.type,
        input.title,
        input.message,
        input.payload ? JSON.stringify(input.payload) : null,
      ],
    );
  }

  private async findLocalOrderByAnymarketId(anymarketOrderId: string) {
    const result = await dbQuery<LocalOrderMatch>(
      `
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
      `,
      [anymarketOrderId],
    );

    return result.rows[0] || null;
  }

  private async listAnymarketEnabledCompanies() {
    const result = await dbQuery<{ id: string }>(
      `
        SELECT
          c."id"
        FROM "Company" c
        WHERE c."anymarketIntegrationEnabled" = TRUE
          AND TRIM(COALESCE(c."anymarketToken", '')) <> ''
      `,
    );
    return result.rows;
  }

  private async fetchAnymarketOrderByIdentifier(
    companyId: string,
    anymarketOrderId: string,
  ) {
    const api = new AnymarketApiService(companyId);
    const attempts: Array<Record<string, string>> = [
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

  private async forceCancelOrder(orderId: string) {
    await dbQuery(
      `
        UPDATE "Order"
        SET
          "status" = $2,
          "isDelayed" = FALSE,
          "lastUpdate" = NOW()
        WHERE "id" = $1
      `,
      [orderId, OrderStatus.CANCELED],
    );
  }

  async processWebhook(
    input: ProcessAnymarketWebhookInput,
  ): Promise<ProcessAnymarketWebhookResult> {
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
      if (isCanceledEvent(event) && localOrder.status !== OrderStatus.CANCELED) {
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
            nextStatus: OrderStatus.CANCELED,
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
        message:
          'Webhook ANYMARKET cancelado ignorado: pedido inexistente localmente.',
        companyId: null,
        orderId: null,
        changed: false,
      };
    }

    if (!localOrder && !isPaidEvent(event)) {
      return {
        success: true,
        statusCode: 200,
        message:
          'Webhook ANYMARKET ignorado para pedido nao encontrado (somente pago dispara busca no ERP).',
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
        const orderFromApi = await this.fetchAnymarketOrderByIdentifier(
          company.id,
          anymarketOrderId,
        );
        if (!orderFromApi?.mapped) {
          continue;
        }

        const importResult = await importOrdersForCompany(company.id, [orderFromApi.mapped]);
        const createdOrder = importResult.results.createdOrders[0] || null;
        const updatedOrder = importResult.results.updatedOrders[0] || null;
        const changed =
          importResult.results.created > 0 ||
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
      } catch {
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

  async listWebhookLogs(companyId: string, limit = 100) {
    const safeLimit = Math.max(1, Math.min(500, Number(limit) || 100));
    const result = await dbQuery<any>(
      `
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
      `,
      [companyId, safeLimit],
    );

    return result.rows.map((row) => ({
      id: String(row.id),
      type: String(row.type || ''),
      title: String(row.title || ''),
      message: String(row.message || ''),
      payload: row.payload && typeof row.payload === 'object' ? row.payload : {},
      createdAt:
        row.createdAt instanceof Date
          ? row.createdAt.toISOString()
          : new Date(String(row.createdAt || '')).toISOString(),
    }));
  }

  async clearFailureLogs(companyId: string) {
    const result = await dbQuery<{ id: string }>(
      `
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
      `,
      [companyId],
    );

    return {
      removed: result.rows.length,
    };
  }

  async reprocessFailureLogs(companyId: string, limit = 120) {
    const safeLimit = Math.max(1, Math.min(500, Number(limit) || 120));
    const logsResult = await dbQuery<{
      id: string;
      payload: Record<string, unknown> | null;
    }>(
      `
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
      `,
      [companyId, safeLimit],
    );

    let attempted = 0;
    let reprocessed = 0;
    let stillFailed = 0;
    let skipped = 0;

    for (const row of logsResult.rows) {
      const payload =
        row.payload && typeof row.payload === 'object' ? row.payload : ({} as Record<string, any>);
      const anymarketOrderId = normalizeText(
        payload.anymarketOrderId || payload.orderNumber || payload.id,
      );
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
      } else {
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

export const anymarketWebhookService = new AnymarketWebhookService();
