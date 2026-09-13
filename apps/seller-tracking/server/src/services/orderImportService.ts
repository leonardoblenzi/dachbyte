import crypto from 'crypto';
import { OrderStatus } from '../types/orderStatus';
import { shouldSkipPlatformOrderImport } from '../utils/orderExclusion';
import type {
  TraySyncOrderReport,
  TraySyncSkippedOrderReport,
} from '../types/syncReport';
import { dbQuery, withDbTransaction } from '../lib/db';

const mapStatus = (status: string): OrderStatus => {
  const statusMap: Record<string, OrderStatus> = {
    PENDING: OrderStatus.PENDING,
    CREATED: OrderStatus.CREATED,
    SHIPPED: OrderStatus.SHIPPED,
    DELIVERY_ATTEMPT: OrderStatus.DELIVERY_ATTEMPT,
    DELIVERED: OrderStatus.DELIVERED,
    FAILURE: OrderStatus.FAILURE,
    RETURNED: OrderStatus.RETURNED,
    CANCELED: OrderStatus.CANCELED,
    CHANNEL_LOGISTICS: OrderStatus.CHANNEL_LOGISTICS,
  };

  return statusMap[status] || OrderStatus.PENDING;
};

const STATUS_LABELS: Record<OrderStatus, string> = {
  PENDING: 'Pendente',
  CREATED: 'Criado',
  SHIPPED: 'Em transito',
  DELIVERY_ATTEMPT: 'Em rota',
  DELIVERED: 'Entregue',
  FAILURE: 'Falha na entrega',
  RETURNED: 'Devolvido',
  CANCELED: 'Cancelado',
  CHANNEL_LOGISTICS: 'Logistica do canal',
};

const safeString = (value: any): string | null => {
  if (value === null || value === undefined || value === '') return null;
  return String(value).trim();
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

const parseShippingCutoffTime = (value: unknown) => {
  const normalized = String(value || '').trim();
  const match = normalized.match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  if (!match) return null;

  return {
    raw: `${match[1]}:${match[2]}`,
    hours: Number(match[1]),
    minutes: Number(match[2]),
  };
};

const parseDateAndHour = (dateValue: unknown, hourValue: unknown) => {
  const dateText = String(dateValue || '').trim();
  const hourText = String(hourValue || '').trim();

  const dateMatch = dateText.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const hourMatch = hourText.match(/^([01]?\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/);
  if (!dateMatch || !hourMatch) {
    return null;
  }

  const year = Number(dateMatch[1]);
  const month = Number(dateMatch[2]) - 1;
  const day = Number(dateMatch[3]);
  const hours = Number(hourMatch[1]);
  const minutes = Number(hourMatch[2]);
  const seconds = hourMatch[3] ? Number(hourMatch[3]) : 0;

  const parsed = new Date(year, month, day, hours, minutes, seconds, 0);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const resolvePlatformCreatedAt = (orderData: any) => {
  const payload = orderData?.apiRawPayload || {};
  const fromDateAndHour = parseDateAndHour(payload?.date, payload?.hour);

  return (
    safeDate(orderData?.platformCreatedAt) ||
    safeDate(payload?.platformCreatedAt) ||
    safeDate(payload?.createdAt) ||
    safeDate(payload?.created_at) ||
    safeDate(payload?.date_add) ||
    fromDateAndHour ||
    safeDate(payload?.date) ||
    safeDate(orderData?.shippingDate)
  );
};

const resolveShippingAvailabilityMaxDays = (orderData: any) => {
  const rawValue =
    orderData?.apiRawPayload?.shippingAvailability?.maxDays ??
    orderData?.apiRawPayload?.anymarketMeta?.shippingAvailability?.maxDays ??
    orderData?.shippingAvailability?.maxDays;
  const parsed = Number(rawValue);
  return Number.isFinite(parsed) ? parsed : null;
};

const applyCutoffRuleToZeroDayDeadline = (
  orderData: any,
  maxShippingDeadline: Date | null,
  shippingCutoffTime: string | null | undefined,
) => {
  if (!maxShippingDeadline) return maxShippingDeadline;

  const maxDays = resolveShippingAvailabilityMaxDays(orderData);
  if (maxDays !== 0) {
    return maxShippingDeadline;
  }

  const cutoff = parseShippingCutoffTime(shippingCutoffTime);
  if (!cutoff) {
    return maxShippingDeadline;
  }

  const platformCreatedAt = resolvePlatformCreatedAt(orderData);
  if (!platformCreatedAt) {
    return maxShippingDeadline;
  }

  const createdMinutes =
    platformCreatedAt.getHours() * 60 + platformCreatedAt.getMinutes();
  const cutoffMinutes = cutoff.hours * 60 + cutoff.minutes;

  if (createdMinutes <= cutoffMinutes) {
    return maxShippingDeadline;
  }

  const adjusted = new Date(platformCreatedAt);
  adjusted.setHours(12, 0, 0, 0);
  adjusted.setDate(adjusted.getDate() + 1);
  return adjusted;
};

const safeNumber = (value: any): number => {
  if (value === null || value === undefined || value === '') return 0;
  const num =
    typeof value === 'number'
      ? value
      : parseFloat(String(value).replace(/[^\d.-]/g, ''));

  return Number.isNaN(num) ? 0 : num;
};

const isActiveDelayedByCarrier = (
  status: OrderStatus,
  carrierEstimatedDeliveryDate: Date | null,
) => {
  const closedStatuses: OrderStatus[] = [
    OrderStatus.DELIVERED,
    OrderStatus.FAILURE,
    OrderStatus.RETURNED,
    OrderStatus.CANCELED,
    OrderStatus.CHANNEL_LOGISTICS,
  ];

  return Boolean(
    carrierEstimatedDeliveryDate &&
      !closedStatuses.includes(status) &&
      new Date() > carrierEstimatedDeliveryDate,
  );
};

const buildTrackingEventsData = (orderData: any, fallbackStatus: OrderStatus) => {
  const shippingDate = safeDate(orderData.shippingDate);
  const sourceHistory = Array.isArray(orderData.trackingHistory)
    ? orderData.trackingHistory
    : [];

  if (sourceHistory.length > 0) {
    return sourceHistory.map((event: any) => ({
      status: safeString(event.status) || fallbackStatus,
      description: safeString(event.description) || 'Evento de rastreamento',
      eventDate: safeDate(event.date) || shippingDate || new Date(),
      city: safeString(event.city),
      state: safeString(event.state),
    }));
  }

  const statusDescriptions: Record<string, string> = {
    PENDING: 'Pedido pendente de processamento',
    CREATED: 'Pedido criado',
    SHIPPED: 'Pedido enviado',
    DELIVERY_ATTEMPT: 'Tentativa de entrega',
    DELIVERED: 'Pedido entregue',
    FAILURE: 'Falha na entrega',
    RETURNED: 'Pedido devolvido',
    CANCELED: 'Pedido cancelado',
    CHANNEL_LOGISTICS: 'Logistica gerenciada pelo canal de venda',
  };

  return [
    {
      status: fallbackStatus,
      description: statusDescriptions[fallbackStatus] || 'Status atualizado',
      eventDate: shippingDate || new Date(),
      city: safeString(orderData.city),
      state: safeString(orderData.state),
    },
  ];
};

const normalizeText = (value: string | null | undefined) =>
  value === null || value === undefined ? '' : String(value).trim();

const normalizeDate = (value: Date | null | undefined) =>
  value ? value.getTime() : null;

const formatValueDate = (value: Date | null | undefined) =>
  value ? value.toLocaleDateString('pt-BR') : '-';

const formatValueCurrency = (value: number) =>
  new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  }).format(Number(value || 0));

type ExistingOrderSnapshot = {
  id: string;
  orderNumber: string;
  isArchived: boolean;
  customerName: string | null;
  invoiceNumber: string | null;
  invoiceAccessKey: string | null;
  trackingCode: string | null;
  salesChannel: string | null;
  freightType: string | null;
  status: OrderStatus;
  shippingDate: Date | null;
  estimatedDeliveryDate: Date | null;
  carrierEstimatedDeliveryDate: Date | null;
  totalValue: unknown;
  isDelayed: boolean;
  _count: {
    trackingEvents: number;
  };
};

const describeUpdatedFields = (
  existing: ExistingOrderSnapshot,
  nextOrder: ReturnType<typeof buildOrderData>,
) => {
  const updatedFields: string[] = [];

  if (existing.status !== nextOrder.status) {
    updatedFields.push(
      `Status (${STATUS_LABELS[existing.status]} -> ${STATUS_LABELS[nextOrder.status]})`,
    );
  }

  if (normalizeText(existing.invoiceNumber) !== normalizeText(nextOrder.invoiceNumber)) {
    updatedFields.push(
      `NF (${normalizeText(existing.invoiceNumber) || '-'} -> ${normalizeText(nextOrder.invoiceNumber) || '-'})`,
    );
  }

  if (
    normalizeText(existing.invoiceAccessKey) !==
    normalizeText(nextOrder.invoiceAccessKey)
  ) {
    updatedFields.push(
      `Chave NF (${normalizeText(existing.invoiceAccessKey) || '-'} -> ${normalizeText(nextOrder.invoiceAccessKey) || '-'})`,
    );
  }

  if (normalizeText(existing.trackingCode) !== normalizeText(nextOrder.trackingCode)) {
    updatedFields.push(
      `Codigo de rastreio (${normalizeText(existing.trackingCode) || '-'} -> ${normalizeText(nextOrder.trackingCode) || '-'})`,
    );
  }

  if (normalizeText(existing.customerName) !== normalizeText(nextOrder.customerName)) {
    updatedFields.push(
      `Cliente (${normalizeText(existing.customerName)} -> ${normalizeText(nextOrder.customerName)})`,
    );
  }

  if (normalizeText(existing.salesChannel) !== normalizeText(nextOrder.salesChannel)) {
    updatedFields.push(
      `Canal (${normalizeText(existing.salesChannel)} -> ${normalizeText(nextOrder.salesChannel)})`,
    );
  }

  if (normalizeText(existing.freightType) !== normalizeText(nextOrder.freightType)) {
    updatedFields.push(
      `Frete (${normalizeText(existing.freightType) || '-'} -> ${normalizeText(nextOrder.freightType) || '-'})`,
    );
  }

  if (normalizeDate(existing.shippingDate) !== normalizeDate(nextOrder.shippingDate)) {
    updatedFields.push(
      `Data de envio (${formatValueDate(existing.shippingDate)} -> ${formatValueDate(nextOrder.shippingDate)})`,
    );
  }

  if (
    normalizeDate(existing.estimatedDeliveryDate) !==
    normalizeDate(nextOrder.estimatedDeliveryDate)
  ) {
    updatedFields.push(
      `Previsao de entrega (${formatValueDate(existing.estimatedDeliveryDate)} -> ${formatValueDate(nextOrder.estimatedDeliveryDate)})`,
    );
  }

  if (
    normalizeDate(existing.carrierEstimatedDeliveryDate) !==
    normalizeDate(nextOrder.carrierEstimatedDeliveryDate)
  ) {
    updatedFields.push(
      `Previsao da transportadora (${formatValueDate(existing.carrierEstimatedDeliveryDate)} -> ${formatValueDate(nextOrder.carrierEstimatedDeliveryDate)})`,
    );
  }

  if (Number(existing.totalValue) !== Number(nextOrder.totalValue)) {
    updatedFields.push(
      `Valor (${formatValueCurrency(Number(existing.totalValue || 0))} -> ${formatValueCurrency(nextOrder.totalValue)})`,
    );
  }

  if (existing.isDelayed !== nextOrder.isDelayed) {
    updatedFields.push(
      `Atraso (${existing.isDelayed ? 'Sim' : 'Nao'} -> ${nextOrder.isDelayed ? 'Sim' : 'Nao'})`,
    );
  }

  if (updatedFields.length === 0) {
    return ['Sem alteracao relevante (sincronizacao preventiva)'];
  }

  return updatedFields;
};

const buildOrderData = (
  orderData: any,
  status: OrderStatus,
  options?: { shippingCutoffTime?: string | null },
) => {
  const carrierEstimatedDeliveryDate = safeDate(orderData.carrierEstimatedDeliveryDate);
  const resolvedMaxShippingDeadline = applyCutoffRuleToZeroDayDeadline(
    orderData,
    safeDate(orderData.maxShippingDeadline),
    options?.shippingCutoffTime,
  );

  return {
  orderNumber: String(orderData.orderNumber),
  invoiceNumber: safeString(orderData.invoiceNumber),
  invoiceAccessKey: safeString(orderData.invoiceAccessKey),
  invoiceXmlUrl: safeString(orderData.invoiceXmlUrl),
  trackingCode: safeString(orderData.trackingCode),
  customerName: safeString(orderData.customerName) || 'Desconhecido',
  corporateName: safeString(orderData.corporateName),
  cpf: safeString(orderData.cpf),
  cnpj: safeString(orderData.cnpj),
  phone: safeString(orderData.phone),
  mobile: safeString(orderData.mobile),
  salesChannel: safeString(orderData.salesChannel) || 'Nao identificado',
  freightType: safeString(orderData.freightType) || 'Aguardando',
  freightValue: safeNumber(orderData.freightValue),
  quotedFreightValue:
    orderData.quotedFreightValue === null || orderData.quotedFreightValue === undefined
      ? null
      : safeNumber(orderData.quotedFreightValue),
  quotedFreightDate: safeDate(orderData.quotedFreightDate),
  quotedFreightDetails: orderData.quotedFreightDetails ?? null,
  originalQuotedFreightValue:
    orderData.originalQuotedFreightValue === null ||
    orderData.originalQuotedFreightValue === undefined
      ? null
      : safeNumber(orderData.originalQuotedFreightValue),
  originalQuotedFreightDate: safeDate(orderData.originalQuotedFreightDate),
  originalQuotedFreightDetails: orderData.originalQuotedFreightDetails ?? null,
  originalQuotedFreightQuotationId: safeString(
    orderData.originalQuotedFreightQuotationId,
  ),
  recalculatedFreightValue:
    orderData.recalculatedFreightValue === null ||
    orderData.recalculatedFreightValue === undefined
      ? null
      : safeNumber(orderData.recalculatedFreightValue),
  recalculatedFreightDate: safeDate(orderData.recalculatedFreightDate),
  recalculatedFreightDetails: orderData.recalculatedFreightDetails ?? null,
  shippingDate: safeDate(orderData.shippingDate),
  address: safeString(orderData.address) || '',
  number: safeString(orderData.number) || '',
  complement: safeString(orderData.complement),
  neighborhood: safeString(orderData.neighborhood) || '',
  city: safeString(orderData.city) || '',
  state: safeString(orderData.state) || '',
  zipCode: safeString(orderData.zipCode) || '',
  totalValue: safeNumber(orderData.totalValue),
  recipient: safeString(orderData.recipient),
  maxShippingDeadline: resolvedMaxShippingDeadline,
  estimatedDeliveryDate: safeDate(orderData.estimatedDeliveryDate),
  carrierEstimatedDeliveryDate,
  status,
  isDelayed: isActiveDelayedByCarrier(status, carrierEstimatedDeliveryDate),
  apiRawPayload: orderData.apiRawPayload ?? null,
  };
};

const buildTraySyncOrderReport = (
  orderId: string | null,
  orderPayload: ReturnType<typeof buildOrderData>,
  updateSummary?: string[],
): TraySyncOrderReport => ({
  orderId,
  orderNumber: orderPayload.orderNumber,
  customerName: orderPayload.customerName,
  trackingCode: orderPayload.trackingCode,
  salesChannel: orderPayload.salesChannel,
  freightType: orderPayload.freightType,
  status: orderPayload.status,
  shippingDate: orderPayload.shippingDate?.toISOString() || null,
  estimatedDeliveryDate: orderPayload.estimatedDeliveryDate?.toISOString() || null,
  carrierEstimatedDeliveryDate:
    orderPayload.carrierEstimatedDeliveryDate?.toISOString() || null,
  totalValue: orderPayload.totalValue,
  isDelayed: orderPayload.isDelayed,
  updateSummary,
});

export const importOrdersForCompany = async (
  companyId: string,
  orders: any[],
  options?: {
    ignoreCarrierExceptions?: boolean;
  },
) => {
  if (!Array.isArray(orders) || orders.length === 0) {
    throw new Error('Nenhum pedido valido para importar');
  }

  const normalizedOrders = Array.from(
    new Map(
      orders.map((order, index) => [
        safeString(order?.orderNumber) || `__missing_order_${index}`,
        order,
      ]),
    ).values(),
  );

  const companyResult = await dbQuery<any>(
    `
      SELECT
        c."name",
        c."integrationCarrierExceptions",
        c."shippingCutoffTime"
      FROM "Company" c
      WHERE c."id" = $1
      LIMIT 1
    `,
    [companyId],
  );
  const company = companyResult.rows[0] || null;

  const orderNumbers = normalizedOrders
    .map((order) => safeString(order?.orderNumber))
    .filter((value): value is string => Boolean(value));

  const existingOrdersResult = await dbQuery<any>(
    `
      SELECT
        o."id",
        o."orderNumber",
        o."isArchived",
        o."customerName",
        o."invoiceNumber",
        o."invoiceAccessKey",
        o."trackingCode",
        o."salesChannel",
        o."freightType",
        o."status",
        o."shippingDate",
        o."estimatedDeliveryDate",
        o."carrierEstimatedDeliveryDate",
        o."totalValue",
        o."isDelayed",
        (
          SELECT COUNT(*)::int
          FROM "TrackingEvent" te
          WHERE te."orderId" = o."id"
        ) AS "trackingEventsCount"
      FROM "Order" o
      WHERE o."companyId" = $1
        AND o."orderNumber" = ANY($2::text[])
    `,
    [companyId, orderNumbers],
  );
  const existingOrders = existingOrdersResult.rows.map((row) => ({
    ...row,
    _count: {
      trackingEvents: Number(row.trackingEventsCount || 0),
    },
  }));

  const existingMap = new Map<string, ExistingOrderSnapshot>(
    existingOrders.map((order) => [order.orderNumber, order as ExistingOrderSnapshot]),
  );

  let created = 0;
  let updated = 0;
  let skipped = 0;
  let totalTrackingEvents = 0;
  const createdOrders: TraySyncOrderReport[] = [];
  const updatedOrders: TraySyncOrderReport[] = [];
  const skippedOrders: TraySyncSkippedOrderReport[] = [];
  const errors: string[] = [];

  const registerSkippedOrder = (orderNumber: string | null, reason: string) => {
    skipped += 1;
    skippedOrders.push({
      orderNumber: orderNumber || 'desconhecido',
      reason,
    });
  };

  for (const orderData of normalizedOrders) {
    const orderNumber = safeString(orderData?.orderNumber);
    if (!orderNumber) {
      registerSkippedOrder(null, 'Numero do pedido ausente no payload recebido');
      continue;
    }

    if (
      !options?.ignoreCarrierExceptions &&
      shouldSkipPlatformOrderImport({
        freightType: orderData?.freightType,
        carrierExceptions: company?.integrationCarrierExceptions,
      })
    ) {
      registerSkippedOrder(
        orderNumber,
        'Pedido bloqueado por excecao de transportadora',
      );
      continue;
    }

    try {
      const status = mapStatus(String(orderData.status || 'PENDING'));
      const orderPayload = buildOrderData(
        orderData,
        status,
        {
          shippingCutoffTime: company?.shippingCutoffTime || null,
        },
      );
      const trackingEventsData = buildTrackingEventsData(orderData, status);
      const existing = existingMap.get(orderNumber);

      if (existing) {
        if (existing.isArchived) {
          registerSkippedOrder(orderNumber, 'Pedido arquivado no sistema');
          continue;
        }

        await dbQuery(
          `
            UPDATE "Order"
            SET
              "orderNumber" = $2,
              "invoiceNumber" = $3,
              "trackingCode" = $4,
              "customerName" = $5,
              "corporateName" = $6,
              "cpf" = $7,
              "cnpj" = $8,
              "phone" = $9,
              "mobile" = $10,
              "salesChannel" = $11,
              "freightType" = $12,
              "freightValue" = $13,
              "quotedFreightValue" = $14,
              "quotedFreightDate" = $15,
              "quotedFreightDetails" = $16::jsonb,
              "originalQuotedFreightValue" = $17,
              "originalQuotedFreightDate" = $18,
              "originalQuotedFreightDetails" = $19::jsonb,
              "originalQuotedFreightQuotationId" = $20,
              "recalculatedFreightValue" = $21,
              "recalculatedFreightDate" = $22,
              "recalculatedFreightDetails" = $23::jsonb,
              "shippingDate" = $24,
              "address" = $25,
              "number" = $26,
              "complement" = $27,
              "neighborhood" = $28,
              "city" = $29,
              "state" = $30,
              "zipCode" = $31,
              "totalValue" = $32,
              "recipient" = $33,
              "maxShippingDeadline" = $34,
              "estimatedDeliveryDate" = $35,
              "carrierEstimatedDeliveryDate" = $36,
              "status" = $37,
              "isDelayed" = $38,
              "apiRawPayload" = $39::jsonb,
              "invoiceAccessKey" = COALESCE($40, "invoiceAccessKey"),
              "invoiceXmlUrl" = COALESCE($41, "invoiceXmlUrl"),
              "invoiceXmlRevisitState" = CASE
                WHEN COALESCE($40, '') <> '' THEN NULL
                ELSE "invoiceXmlRevisitState"
              END,
              "lastUpdate" = NOW()
            WHERE "id" = $1
          `,
          [
            existing.id,
            orderPayload.orderNumber,
            orderPayload.invoiceNumber,
            orderPayload.trackingCode,
            orderPayload.customerName,
            orderPayload.corporateName,
            orderPayload.cpf,
            orderPayload.cnpj,
            orderPayload.phone,
            orderPayload.mobile,
            orderPayload.salesChannel,
            orderPayload.freightType,
            orderPayload.freightValue,
            orderPayload.quotedFreightValue,
            orderPayload.quotedFreightDate,
            orderPayload.quotedFreightDetails
              ? JSON.stringify(orderPayload.quotedFreightDetails)
              : null,
            orderPayload.originalQuotedFreightValue,
            orderPayload.originalQuotedFreightDate,
            orderPayload.originalQuotedFreightDetails
              ? JSON.stringify(orderPayload.originalQuotedFreightDetails)
              : null,
            orderPayload.originalQuotedFreightQuotationId,
            orderPayload.recalculatedFreightValue,
            orderPayload.recalculatedFreightDate,
            orderPayload.recalculatedFreightDetails
              ? JSON.stringify(orderPayload.recalculatedFreightDetails)
              : null,
            orderPayload.shippingDate,
            orderPayload.address,
            orderPayload.number,
            orderPayload.complement,
            orderPayload.neighborhood,
            orderPayload.city,
            orderPayload.state,
            orderPayload.zipCode,
            orderPayload.totalValue,
            orderPayload.recipient,
            orderPayload.maxShippingDeadline,
            orderPayload.estimatedDeliveryDate,
            orderPayload.carrierEstimatedDeliveryDate,
            orderPayload.status,
            orderPayload.isDelayed,
            orderPayload.apiRawPayload ? JSON.stringify(orderPayload.apiRawPayload) : null,
            orderPayload.invoiceAccessKey,
            orderPayload.invoiceXmlUrl,
          ],
        );

        if (existing._count.trackingEvents === 0 && trackingEventsData.length > 0) {
          for (const event of trackingEventsData) {
            await dbQuery(
              `
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
              `,
              [
                crypto.randomUUID(),
                existing.id,
                event.status,
                event.description,
                event.city,
                event.state,
                event.eventDate,
              ],
            );
          }
          totalTrackingEvents += trackingEventsData.length;
        }

        updated += 1;
        const updateSummary = describeUpdatedFields(existing, orderPayload);
        updatedOrders.push(
          buildTraySyncOrderReport(existing.id, orderPayload, updateSummary),
        );
        continue;
      }

      const createdOrder = await withDbTransaction(async (client) => {
        const orderId = crypto.randomUUID();

        await client.query(
          `
            INSERT INTO "Order" (
              "id",
              "companyId",
              "orderNumber",
              "invoiceNumber",
              "invoiceAccessKey",
              "invoiceXmlUrl",
              "trackingCode",
              "customerName",
              "corporateName",
              "cpf",
              "cnpj",
              "phone",
              "mobile",
              "salesChannel",
              "freightType",
              "freightValue",
              "quotedFreightValue",
              "quotedFreightDate",
              "quotedFreightDetails",
              "originalQuotedFreightValue",
              "originalQuotedFreightDate",
              "originalQuotedFreightDetails",
              "originalQuotedFreightQuotationId",
              "recalculatedFreightValue",
              "recalculatedFreightDate",
              "recalculatedFreightDetails",
              "shippingDate",
              "address",
              "number",
              "complement",
              "neighborhood",
              "city",
              "state",
              "zipCode",
              "totalValue",
              "recipient",
              "maxShippingDeadline",
              "estimatedDeliveryDate",
              "carrierEstimatedDeliveryDate",
              "status",
              "isDelayed",
              "apiRawPayload",
              "invoiceXmlRevisitState",
              "createdAt",
              "lastUpdate"
            )
            VALUES (
              $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
              $11, $12, $13, $14, $15, $16, $17, $18, $19::jsonb, $20,
              $21, $22::jsonb, $23, $24, $25, $26::jsonb, $27, $28, $29, $30,
              $31, $32, $33, $34, $35, $36, $37, $38, $39, $40, $41, $42::jsonb, $43, NOW(), NOW()
            )
          `,
          [
            orderId,
            companyId,
            orderPayload.orderNumber,
            orderPayload.invoiceNumber,
            orderPayload.invoiceAccessKey,
            orderPayload.invoiceXmlUrl,
            orderPayload.trackingCode,
            orderPayload.customerName,
            orderPayload.corporateName,
            orderPayload.cpf,
            orderPayload.cnpj,
            orderPayload.phone,
            orderPayload.mobile,
            orderPayload.salesChannel,
            orderPayload.freightType,
            orderPayload.freightValue,
            orderPayload.quotedFreightValue,
            orderPayload.quotedFreightDate,
            orderPayload.quotedFreightDetails
              ? JSON.stringify(orderPayload.quotedFreightDetails)
              : null,
            orderPayload.originalQuotedFreightValue,
            orderPayload.originalQuotedFreightDate,
            orderPayload.originalQuotedFreightDetails
              ? JSON.stringify(orderPayload.originalQuotedFreightDetails)
              : null,
            orderPayload.originalQuotedFreightQuotationId,
            orderPayload.recalculatedFreightValue,
            orderPayload.recalculatedFreightDate,
            orderPayload.recalculatedFreightDetails
              ? JSON.stringify(orderPayload.recalculatedFreightDetails)
              : null,
            orderPayload.shippingDate,
            orderPayload.address,
            orderPayload.number,
            orderPayload.complement,
            orderPayload.neighborhood,
            orderPayload.city,
            orderPayload.state,
            orderPayload.zipCode,
            orderPayload.totalValue,
            orderPayload.recipient,
            orderPayload.maxShippingDeadline,
            orderPayload.estimatedDeliveryDate,
            orderPayload.carrierEstimatedDeliveryDate,
            orderPayload.status,
            orderPayload.isDelayed,
            orderPayload.apiRawPayload ? JSON.stringify(orderPayload.apiRawPayload) : null,
            null,
          ],
        );

        for (const event of trackingEventsData) {
          await client.query(
            `
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
            `,
            [
              crypto.randomUUID(),
              orderId,
              event.status,
              event.description,
              event.city,
              event.state,
              event.eventDate,
            ],
          );
        }

        return { id: orderId };
      });

      created += 1;
      totalTrackingEvents += trackingEventsData.length;
      createdOrders.push(buildTraySyncOrderReport(createdOrder.id, orderPayload));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'erro desconhecido';
      registerSkippedOrder(orderNumber, `Erro na importacao: ${message}`);
      errors.push(
        `Pedido ${orderNumber}: ${message}`,
      );
    }
  }

  const message =
    `Importacao concluida: ${created} criados, ${updated} atualizados, ` +
    `${skipped} ignorados, ${totalTrackingEvents} evento(s) iniciais de rastreio.` +
    (errors.length > 0 ? ` ${errors.length} pedido(s) com erro.` : '');

  return {
    message,
    results: {
      created,
      updated,
      skipped,
      totalTrackingEvents,
      errors,
      createdOrders,
      updatedOrders,
      skippedOrders,
    },
  };
};
