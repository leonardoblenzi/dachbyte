"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.upsertCompanyCustomOrderStatus = exports.listCompanyCustomOrderStatuses = exports.findTrayCheckoutQuoteByQuotationId = exports.listTrayCheckoutQuotesByQuotationIds = exports.getCompanyTrackingSettings = exports.deleteMonitoredOrderByCompanyAndOrder = exports.deleteOrdersByCompanyAndStatus = exports.deleteOrdersByCompany = exports.deleteOrdersByIds = exports.listOrderCleanupBatch = exports.getCompanyBasicById = exports.markOrderDeliveredManuallyById = exports.updateOrderArchivedStateById = exports.updateOrderManualFieldsById = exports.updateOrderFreightTypeById = exports.getOrderById = exports.findLatestOrderByNumberForCompany = exports.findActiveOrderByIdentifier = exports.listOrdersForCompany = void 0;
const crypto_1 = __importDefault(require("crypto"));
const db_1 = require("./db");
const buildArchivedFilterSql = (mode) => {
    if (mode === 'only') {
        return 'AND o."isArchived" = TRUE';
    }
    if (mode === 'exclude') {
        return 'AND o."isArchived" = FALSE';
    }
    return '';
};
const attachTrackingEvents = async (orders) => {
    if (orders.length === 0) {
        return orders;
    }
    const orderIds = orders.map((order) => String(order.id));
    const eventsResult = await (0, db_1.dbQuery)(`
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
    `, [orderIds]);
    const eventsByOrderId = new Map();
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
        }
        else {
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
const listOrdersForCompany = async (companyId, archivedMode) => {
    const archivedFilterSql = buildArchivedFilterSql(archivedMode);
    const ordersResult = await (0, db_1.dbQuery)(`
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
    `, [companyId]);
    return attachTrackingEvents(ordersResult.rows);
};
exports.listOrdersForCompany = listOrdersForCompany;
const findActiveOrderByIdentifier = async ({ companyId, identifier, normalizedDigits, normalizedAlphaNumeric, }) => {
    const result = await (0, db_1.dbQuery)(`
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
    `, [
        companyId,
        identifier,
        normalizedDigits || '',
        normalizedDigits || '',
        normalizedAlphaNumeric || '',
    ]);
    return result.rows[0] || null;
};
exports.findActiveOrderByIdentifier = findActiveOrderByIdentifier;
const findLatestOrderByNumberForCompany = async (companyId, orderNumber) => {
    const result = await (0, db_1.dbQuery)(`
      SELECT o.*
      FROM "Order" o
      WHERE o."companyId" = $1
        AND o."orderNumber" = $2
      ORDER BY o."createdAt" DESC
      LIMIT 1
    `, [companyId, orderNumber]);
    const order = result.rows[0];
    if (!order) {
        return null;
    }
    return (0, exports.getOrderById)(String(order.id));
};
exports.findLatestOrderByNumberForCompany = findLatestOrderByNumberForCompany;
const getOrderById = async (id) => {
    const orderResult = await (0, db_1.dbQuery)(`
      SELECT o.*
      FROM "Order" o
      WHERE o."id" = $1
      LIMIT 1
    `, [id]);
    const order = orderResult.rows[0];
    if (!order) {
        return null;
    }
    const [orderWithTracking] = await attachTrackingEvents([order]);
    if (!orderWithTracking) {
        return null;
    }
    if (orderWithTracking.carrierId) {
        const carrierResult = await (0, db_1.dbQuery)(`
        SELECT c.*
        FROM "Carrier" c
        WHERE c."id" = $1
        LIMIT 1
      `, [orderWithTracking.carrierId]);
        orderWithTracking.carrier = carrierResult.rows[0] || null;
    }
    else {
        orderWithTracking.carrier = null;
    }
    return orderWithTracking;
};
exports.getOrderById = getOrderById;
const updateOrderFreightTypeById = async (id, freightType) => {
    const result = await (0, db_1.dbQuery)(`
      UPDATE "Order"
      SET
        "freightType" = $2,
        "lastUpdate" = NOW()
      WHERE "id" = $1
      RETURNING *
    `, [id, freightType]);
    return result.rows[0] || null;
};
exports.updateOrderFreightTypeById = updateOrderFreightTypeById;
const updateOrderManualFieldsById = async ({ id, customerName, corporateName, cpf, cnpj, phone, mobile, invoiceNumber, trackingCode, address, number, complement, neighborhood, city, state, zipCode, recipient, salesChannel, manualCustomStatus, observation, apiRawPayload, }) => {
    const result = await (0, db_1.dbQuery)(`
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
    `, [
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
    ]);
    return result.rows[0] || null;
};
exports.updateOrderManualFieldsById = updateOrderManualFieldsById;
const updateOrderArchivedStateById = async (id, archived) => {
    const result = await (0, db_1.dbQuery)(`
      UPDATE "Order"
      SET
        "isArchived" = $2,
        "archivedAt" = CASE WHEN $2 = TRUE THEN NOW() ELSE NULL END,
        "lastUpdate" = NOW()
      WHERE "id" = $1
      RETURNING *
    `, [id, archived]);
    return result.rows[0] || null;
};
exports.updateOrderArchivedStateById = updateOrderArchivedStateById;
const markOrderDeliveredManuallyById = async ({ id, description, city, state, eventDate, }) => {
    const deliveredAt = eventDate instanceof Date ? eventDate : new Date();
    return (0, db_1.withDbTransaction)(async (client) => {
        const result = await client.query(`
        UPDATE "Order"
        SET
          "status" = $2,
          "isDelayed" = FALSE,
          "lastApiSync" = $3,
          "lastApiError" = NULL,
          "lastUpdate" = NOW()
        WHERE "id" = $1
        RETURNING *
      `, [id, 'DELIVERED', deliveredAt]);
        const updatedOrder = result.rows[0] || null;
        if (!updatedOrder) {
            return null;
        }
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
            id,
            'DELIVERED',
            description,
            city || null,
            state || null,
            deliveredAt,
        ]);
        return updatedOrder;
    });
};
exports.markOrderDeliveredManuallyById = markOrderDeliveredManuallyById;
const getCompanyBasicById = async (companyId) => {
    const result = await (0, db_1.dbQuery)(`
      SELECT c."id", c."name"
      FROM "Company" c
      WHERE c."id" = $1
      LIMIT 1
    `, [companyId]);
    return result.rows[0] || null;
};
exports.getCompanyBasicById = getCompanyBasicById;
const listOrderCleanupBatch = async ({ companyId, status, cursor, limit, }) => {
    const result = await (0, db_1.dbQuery)(`
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
    `, [companyId, status || '', cursor || '', limit]);
    return result.rows;
};
exports.listOrderCleanupBatch = listOrderCleanupBatch;
const deleteOrdersByIds = async (orderIds) => {
    if (orderIds.length === 0) {
        return 0;
    }
    const result = await (0, db_1.dbQuery)(`
      DELETE FROM "Order"
      WHERE "id" = ANY($1::text[])
    `, [orderIds]);
    return result.rowCount || 0;
};
exports.deleteOrdersByIds = deleteOrdersByIds;
const deleteOrdersByCompany = async (companyId) => {
    const result = await (0, db_1.dbQuery)(`
      DELETE FROM "Order"
      WHERE "companyId" = $1
    `, [companyId]);
    return result.rowCount || 0;
};
exports.deleteOrdersByCompany = deleteOrdersByCompany;
const deleteOrdersByCompanyAndStatus = async (companyId, status) => {
    const result = await (0, db_1.dbQuery)(`
      DELETE FROM "Order"
      WHERE "companyId" = $1
        AND ($2::text = '' OR "status" = $2)
    `, [companyId, status || '']);
    return result.rowCount || 0;
};
exports.deleteOrdersByCompanyAndStatus = deleteOrdersByCompanyAndStatus;
const deleteMonitoredOrderByCompanyAndOrder = async (companyId, orderId) => {
    await (0, db_1.dbQuery)(`
      DELETE FROM "MonitoredOrder"
      WHERE "companyId" = $1
        AND "orderId" = $2
    `, [companyId, orderId]);
};
exports.deleteMonitoredOrderByCompanyAndOrder = deleteMonitoredOrderByCompanyAndOrder;
const getCompanyTrackingSettings = async (companyId) => {
    if (!companyId) {
        return {
            sswRequireEnabled: true,
            sswRequireCnpjs: [],
            intelipostIntegrationEnabled: true,
            intelipostClientId: null,
            correiosIntegrationEnabled: true,
        };
    }
    const companyResult = await (0, db_1.dbQuery)(`
      SELECT
        c."sswRequireEnabled",
        c."sswRequireCnpjs",
        c."intelipostIntegrationEnabled",
        c."intelipostClientId",
        c."correiosIntegrationEnabled"
      FROM "Company" c
      WHERE c."id" = $1
      LIMIT 1
    `, [companyId]);
    const row = companyResult.rows[0];
    if (!row) {
        return {
            sswRequireEnabled: true,
            sswRequireCnpjs: [],
            intelipostIntegrationEnabled: true,
            intelipostClientId: null,
            correiosIntegrationEnabled: true,
        };
    }
    return {
        sswRequireEnabled: row.sswRequireEnabled !== false,
        sswRequireCnpjs: Array.isArray(row.sswRequireCnpjs) ? row.sswRequireCnpjs : [],
        intelipostIntegrationEnabled: row.intelipostIntegrationEnabled !== false,
        intelipostClientId: row.intelipostClientId === undefined || row.intelipostClientId === null
            ? null
            : String(row.intelipostClientId),
        correiosIntegrationEnabled: row.correiosIntegrationEnabled !== false,
    };
};
exports.getCompanyTrackingSettings = getCompanyTrackingSettings;
const listTrayCheckoutQuotesByQuotationIds = async (companyId, quotationIds) => {
    if (!companyId || quotationIds.length === 0) {
        return [];
    }
    const result = await (0, db_1.dbQuery)(`
      SELECT *
      FROM "TrayCheckoutQuote" tcq
      WHERE tcq."companyIdValue" = $1
        AND tcq."quotationId" = ANY($2::text[])
    `, [companyId, quotationIds]);
    return result.rows;
};
exports.listTrayCheckoutQuotesByQuotationIds = listTrayCheckoutQuotesByQuotationIds;
const findTrayCheckoutQuoteByQuotationId = async (companyId, quotationId) => {
    if (!companyId || !quotationId) {
        return null;
    }
    const result = await (0, db_1.dbQuery)(`
      SELECT *
      FROM "TrayCheckoutQuote" tcq
      WHERE tcq."companyIdValue" = $1
        AND tcq."quotationId" = $2
      ORDER BY tcq."createdAt" DESC
      LIMIT 1
    `, [companyId, quotationId]);
    return result.rows[0] || null;
};
exports.findTrayCheckoutQuoteByQuotationId = findTrayCheckoutQuoteByQuotationId;
const listCompanyCustomOrderStatuses = async (companyId) => {
    const result = await (0, db_1.dbQuery)(`
      SELECT
        s."id",
        s."label",
        s."createdAt"
      FROM "CompanyOrderCustomStatus" s
      WHERE s."companyId" = $1
      ORDER BY s."createdAt" DESC
    `, [companyId]);
    return result.rows;
};
exports.listCompanyCustomOrderStatuses = listCompanyCustomOrderStatuses;
const upsertCompanyCustomOrderStatus = async ({ companyId, label, createdById, }) => {
    const id = crypto_1.default.randomUUID();
    const result = await (0, db_1.dbQuery)(`
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
    `, [companyId, label, createdById, id]);
    return result.rows[0] || null;
};
exports.upsertCompanyCustomOrderStatus = upsertCompanyCustomOrderStatus;
