import crypto from 'crypto';
import { dbQuery, withDbTransaction } from './db';

export type OrderArchivedFilterMode = 'exclude' | 'only' | 'include';

const buildArchivedFilterSql = (mode: OrderArchivedFilterMode) => {
  if (mode === 'only') {
    return 'AND o."isArchived" = TRUE';
  }

  if (mode === 'exclude') {
    return 'AND o."isArchived" = FALSE';
  }

  return '';
};

const attachTrackingEvents = async (orders: any[]) => {
  if (orders.length === 0) {
    return orders;
  }

  const orderIds = orders.map((order) => String(order.id));
  const eventsResult = await dbQuery<any>(
    `
      SELECT
        te."orderId",
        te."status",
        te."description",
        te."city",
        te."state",
        te."eventDate"
      FROM "TrackingEvent" te
      WHERE te."orderId" = ANY($1::text[])
      ORDER BY te."eventDate" DESC
    `,
    [orderIds],
  );

  const eventsByOrderId = new Map<string, any[]>();
  for (const row of eventsResult.rows) {
    const key = String(row.orderId);
    const current = eventsByOrderId.get(key);
    if (current) {
      current.push({
        status: row.status,
        description: row.description,
        city: row.city,
        state: row.state,
        eventDate: row.eventDate,
      });
    } else {
      eventsByOrderId.set(key, [
        {
          status: row.status,
          description: row.description,
          city: row.city,
          state: row.state,
          eventDate: row.eventDate,
        },
      ]);
    }
  }

  return orders.map((order) => ({
    ...order,
    trackingEvents: eventsByOrderId.get(String(order.id)) || [],
  }));
};

export const listOrdersForCompany = async (
  companyId: string,
  archivedMode: OrderArchivedFilterMode,
) => {
  const archivedFilterSql = buildArchivedFilterSql(archivedMode);
  const ordersResult = await dbQuery<any>(
    `
      SELECT
        o."id",
        o."orderNumber",
        o."invoiceNumber",
        o."invoiceAccessKey",
        o."invoiceXmlUrl",
        o."invoiceXmlRevisitState",
        o."trackingCode",
        o."customerName",
        o."cpf",
        o."salesChannel",
        o."freightType",
        o."freightValue",
        o."quotedFreightValue",
        o."quotedFreightDate",
        o."originalQuotedFreightValue",
        o."originalQuotedFreightDate",
        o."recalculatedFreightValue",
        o."recalculatedFreightDate",
        o."shippingDate",
        o."maxShippingDeadline",
        o."city",
        o."state",
        o."totalValue",
        o."estimatedDeliveryDate",
        o."carrierEstimatedDeliveryDate",
        o."status",
        o."isDelayed",
        o."isArchived",
        o."archivedAt",
        o."manualCustomStatus",
        o."observation",
        o."lastApiSync",
        o."lastUpdate",
        o."createdAt"
      FROM "Order" o
      WHERE o."companyId" = $1
      ${archivedFilterSql}
      ORDER BY o."createdAt" DESC
    `,
    [companyId],
  );

  return attachTrackingEvents(ordersResult.rows);
};

export const findActiveOrderByIdentifier = async ({
  companyId,
  identifier,
  normalizedDigits,
  normalizedAlphaNumeric,
}: {
  companyId: string;
  identifier: string;
  normalizedDigits?: string | null;
  normalizedAlphaNumeric?: string | null;
}) => {
  const result = await dbQuery<any>(
    `
      SELECT o.*
      FROM "Order" o
      WHERE o."companyId" = $1
        AND o."isArchived" = FALSE
        AND (
          o."orderNumber" = $2
          OR ($3::text <> '' AND o."invoiceNumber" = $3)
          OR ($4::text <> '' AND o."trackingCode" = $4)
          OR ($5::text <> '' AND o."trackingCode" = $5)
          OR (
            $5::text <> ''
            AND regexp_replace(UPPER(COALESCE(o."invoiceAccessKey", '')), '[^A-Z0-9]', '', 'g') = $5
          )
        )
      ORDER BY o."createdAt" DESC
      LIMIT 1
    `,
    [
      companyId,
      identifier,
      normalizedDigits || '',
      normalizedDigits || '',
      normalizedAlphaNumeric || '',
    ],
  );

  return result.rows[0] || null;
};

export const findLatestOrderByNumberForCompany = async (
  companyId: string,
  orderNumber: string,
) => {
  const result = await dbQuery<any>(
    `
      SELECT o.*
      FROM "Order" o
      WHERE o."companyId" = $1
        AND o."orderNumber" = $2
      ORDER BY o."createdAt" DESC
      LIMIT 1
    `,
    [companyId, orderNumber],
  );

  const order = result.rows[0];
  if (!order) {
    return null;
  }

  return getOrderById(String(order.id));
};

export const getOrderById = async (id: string) => {
  const orderResult = await dbQuery<any>(
    `
      SELECT o.*
      FROM "Order" o
      WHERE o."id" = $1
      LIMIT 1
    `,
    [id],
  );

  const order = orderResult.rows[0];
  if (!order) {
    return null;
  }

  const [orderWithTracking] = await attachTrackingEvents([order]);
  if (!orderWithTracking) {
    return null;
  }

  if (orderWithTracking.carrierId) {
    const carrierResult = await dbQuery<any>(
      `
        SELECT c.*
        FROM "Carrier" c
        WHERE c."id" = $1
        LIMIT 1
      `,
      [orderWithTracking.carrierId],
    );
    orderWithTracking.carrier = carrierResult.rows[0] || null;
  } else {
    orderWithTracking.carrier = null;
  }

  return orderWithTracking;
};

export const updateOrderFreightTypeById = async (
  id: string,
  freightType: string,
) => {
  const result = await dbQuery<any>(
    `
      UPDATE "Order"
      SET
        "freightType" = $2,
        "lastUpdate" = NOW()
      WHERE "id" = $1
      RETURNING *
    `,
    [id, freightType],
  );

  return result.rows[0] || null;
};

export const updateOrderManualFieldsById = async ({
  id,
  customerName,
  corporateName,
  cpf,
  cnpj,
  phone,
  mobile,
  invoiceNumber,
  trackingCode,
  address,
  number,
  complement,
  neighborhood,
  city,
  state,
  zipCode,
  recipient,
  salesChannel,
  manualCustomStatus,
  observation,
  apiRawPayload,
}: {
  id: string;
  customerName: string;
  corporateName: string | null;
  cpf: string | null;
  cnpj: string | null;
  phone: string | null;
  mobile: string | null;
  invoiceNumber: string | null;
  trackingCode: string | null;
  address: string;
  number: string;
  complement: string | null;
  neighborhood: string;
  city: string;
  state: string;
  zipCode: string;
  recipient: string | null;
  salesChannel: string;
  manualCustomStatus: string | null;
  observation: string | null;
  apiRawPayload: Record<string, unknown> | null;
}) => {
  const result = await dbQuery<any>(
    `
      UPDATE "Order"
      SET
        "customerName" = $2,
        "corporateName" = $3,
        "cpf" = $4,
        "cnpj" = $5,
        "phone" = $6,
        "mobile" = $7,
        "invoiceNumber" = $8,
        "trackingCode" = $9,
        "address" = $10,
        "number" = $11,
        "complement" = $12,
        "neighborhood" = $13,
        "city" = $14,
        "state" = $15,
        "zipCode" = $16,
        "recipient" = $17,
        "salesChannel" = $18,
        "manualCustomStatus" = $19,
        "observation" = $20,
        "apiRawPayload" = $21::jsonb,
        "lastUpdate" = NOW()
      WHERE "id" = $1
      RETURNING *
    `,
    [
      id,
      customerName,
      corporateName,
      cpf,
      cnpj,
      phone,
      mobile,
      invoiceNumber,
      trackingCode,
      address,
      number,
      complement,
      neighborhood,
      city,
      state,
      zipCode,
      recipient,
      salesChannel,
      manualCustomStatus,
      observation,
      apiRawPayload ? JSON.stringify(apiRawPayload) : null,
    ],
  );

  return result.rows[0] || null;
};

export const updateOrderArchivedStateById = async (
  id: string,
  archived: boolean,
) => {
  const result = await dbQuery<any>(
    `
      UPDATE "Order"
      SET
        "isArchived" = $2,
        "archivedAt" = CASE WHEN $2 = TRUE THEN NOW() ELSE NULL END,
        "lastUpdate" = NOW()
      WHERE "id" = $1
      RETURNING *
    `,
    [id, archived],
  );

  return result.rows[0] || null;
};

export const markOrderDeliveredManuallyById = async ({
  id,
  description,
  city,
  state,
  eventDate,
}: {
  id: string;
  description: string;
  city?: string | null;
  state?: string | null;
  eventDate?: Date;
}) => {
  const deliveredAt = eventDate instanceof Date ? eventDate : new Date();

  return withDbTransaction(async (client) => {
    const result = await client.query<any>(
      `
        UPDATE "Order"
        SET
          "status" = $2,
          "isDelayed" = FALSE,
          "lastApiSync" = $3,
          "lastApiError" = NULL,
          "lastUpdate" = NOW()
        WHERE "id" = $1
        RETURNING *
      `,
      [id, 'DELIVERED', deliveredAt],
    );

    const updatedOrder = result.rows[0] || null;

    if (!updatedOrder) {
      return null;
    }

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
        id,
        'DELIVERED',
        description,
        city || null,
        state || null,
        deliveredAt,
      ],
    );

    return updatedOrder;
  });
};

export const getCompanyBasicById = async (companyId: string) => {
  const result = await dbQuery<any>(
    `
      SELECT c."id", c."name"
      FROM "Company" c
      WHERE c."id" = $1
      LIMIT 1
    `,
    [companyId],
  );

  return result.rows[0] || null;
};

export const listOrderCleanupBatch = async ({
  companyId,
  status,
  cursor,
  limit,
}: {
  companyId: string;
  status?: string;
  cursor?: string;
  limit: number;
}) => {
  const result = await dbQuery<any>(
    `
      SELECT
        o."id",
        o."shippingDate",
        o."createdAt",
        o."lastUpdate",
        (
          SELECT te."eventDate"
          FROM "TrackingEvent" te
          WHERE te."orderId" = o."id"
          ORDER BY te."eventDate" DESC
          LIMIT 1
        ) AS "latestTrackingEventDate"
      FROM "Order" o
      WHERE o."companyId" = $1
        AND ($2::text = '' OR o."status" = $2)
        AND ($3::text = '' OR o."id" > $3)
      ORDER BY o."id" ASC
      LIMIT $4
    `,
    [companyId, status || '', cursor || '', limit],
  );

  return result.rows;
};

export const deleteOrdersByIds = async (orderIds: string[]) => {
  if (orderIds.length === 0) {
    return 0;
  }

  const result = await dbQuery(
    `
      DELETE FROM "Order"
      WHERE "id" = ANY($1::text[])
    `,
    [orderIds],
  );

  return result.rowCount || 0;
};

export const deleteOrdersByCompany = async (companyId: string) => {
  const result = await dbQuery(
    `
      DELETE FROM "Order"
      WHERE "companyId" = $1
    `,
    [companyId],
  );

  return result.rowCount || 0;
};

export const deleteOrdersByCompanyAndStatus = async (
  companyId: string,
  status: string | null,
) => {
  const result = await dbQuery(
    `
      DELETE FROM "Order"
      WHERE "companyId" = $1
        AND ($2::text = '' OR "status" = $2)
    `,
    [companyId, status || ''],
  );

  return result.rowCount || 0;
};

export const deleteMonitoredOrderByCompanyAndOrder = async (
  companyId: string,
  orderId: string,
) => {
  await dbQuery(
    `
      DELETE FROM "MonitoredOrder"
      WHERE "companyId" = $1
        AND "orderId" = $2
    `,
    [companyId, orderId],
  );
};

export const getCompanyTrackingSettings = async (
  companyId: string | null | undefined,
) => {
  if (!companyId) {
    return {
      sswRequireEnabled: true,
      sswRequireCnpjs: [] as string[],
      intelipostIntegrationEnabled: true,
      intelipostClientId: null as string | null,
      correiosIntegrationEnabled: true,
    };
  }

  const companyResult = await dbQuery<any>(
    `
      SELECT
        c."sswRequireEnabled",
        c."sswRequireCnpjs",
        c."intelipostIntegrationEnabled",
        c."intelipostClientId",
        c."correiosIntegrationEnabled"
      FROM "Company" c
      WHERE c."id" = $1
      LIMIT 1
    `,
    [companyId],
  );

  const row = companyResult.rows[0];
  if (!row) {
    return {
      sswRequireEnabled: true,
      sswRequireCnpjs: [] as string[],
      intelipostIntegrationEnabled: true,
      intelipostClientId: null as string | null,
      correiosIntegrationEnabled: true,
    };
  }

  return {
    sswRequireEnabled: row.sswRequireEnabled !== false,
    sswRequireCnpjs: Array.isArray(row.sswRequireCnpjs) ? row.sswRequireCnpjs : [],
    intelipostIntegrationEnabled: row.intelipostIntegrationEnabled !== false,
    intelipostClientId:
      row.intelipostClientId === undefined || row.intelipostClientId === null
        ? null
        : String(row.intelipostClientId),
    correiosIntegrationEnabled: row.correiosIntegrationEnabled !== false,
  };
};

export const listTrayCheckoutQuotesByQuotationIds = async (
  companyId: string | null | undefined,
  quotationIds: string[],
) => {
  if (!companyId || quotationIds.length === 0) {
    return [];
  }

  const result = await dbQuery<any>(
    `
      SELECT *
      FROM "TrayCheckoutQuote" tcq
      WHERE tcq."companyIdValue" = $1
        AND tcq."quotationId" = ANY($2::text[])
    `,
    [companyId, quotationIds],
  );

  return result.rows;
};

export const findTrayCheckoutQuoteByQuotationId = async (
  companyId: string | null | undefined,
  quotationId: string | null | undefined,
) => {
  if (!companyId || !quotationId) {
    return null;
  }

  const result = await dbQuery<any>(
    `
      SELECT *
      FROM "TrayCheckoutQuote" tcq
      WHERE tcq."companyIdValue" = $1
        AND tcq."quotationId" = $2
      ORDER BY tcq."createdAt" DESC
      LIMIT 1
    `,
    [companyId, quotationId],
  );

  return result.rows[0] || null;
};

export const listCompanyCustomOrderStatuses = async (companyId: string) => {
  const result = await dbQuery<any>(
    `
      SELECT
        s."id",
        s."label",
        s."createdAt"
      FROM "CompanyOrderCustomStatus" s
      WHERE s."companyId" = $1
      ORDER BY s."createdAt" DESC
    `,
    [companyId],
  );

  return result.rows;
};

export const upsertCompanyCustomOrderStatus = async ({
  companyId,
  label,
  createdById,
}: {
  companyId: string;
  label: string;
  createdById: string | null;
}) => {
  const id = crypto.randomUUID();
  const result = await dbQuery<any>(
    `
      INSERT INTO "CompanyOrderCustomStatus" (
        "id",
        "companyId",
        "label",
        "createdById",
        "createdAt",
        "updatedAt"
      )
      VALUES (
        $4,
        $1,
        $2,
        $3,
        NOW(),
        NOW()
      )
      ON CONFLICT ("companyId", "label")
      DO UPDATE SET
        "label" = EXCLUDED."label",
        "updatedAt" = NOW()
      RETURNING
        "id",
        "label",
        "createdAt"
    `,
    [companyId, label, createdById, id],
  );

  return result.rows[0] || null;
};
