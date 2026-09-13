"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const db_1 = require("../lib/db");
const anymarketApiService_1 = require("../services/anymarketApiService");
const trayApiService_1 = require("../services/trayApiService");
const orderShippingAvailabilityService_1 = require("../services/orderShippingAvailabilityService");
const PAGE_SIZE = 150;
const APPLY_CHANGES = ['1', 'true', 'yes', 'sim'].includes(String(process.env.APPLY_CHANGES || '').trim().toLowerCase());
const FORCE_ALL = ['1', 'true', 'yes', 'sim'].includes(String(process.env.FORCE_ALL || '').trim().toLowerCase());
const VERBOSE = ['1', 'true', 'yes', 'sim'].includes(String(process.env.VERBOSE || '').trim().toLowerCase());
const COMPANY_ID = String(process.env.COMPANY_ID || '').trim() || null;
const COMPANY_NAME = String(process.env.COMPANY_NAME || '')
    .trim()
    .toUpperCase();
const toSafeDate = (value) => {
    if (!value)
        return null;
    if (value instanceof Date) {
        return Number.isNaN(value.getTime()) ? null : value;
    }
    const parsed = new Date(String(value));
    return Number.isNaN(parsed.getTime()) ? null : parsed;
};
const toIsoDate = (value) => value ? value.toISOString().slice(0, 10) : null;
const normalizeSource = (order) => {
    const payloadSource = String(order.apiRawPayload?.source || '')
        .trim()
        .toUpperCase();
    if (payloadSource.includes('ANYMARKET'))
        return 'ANYMARKET';
    if (payloadSource.includes('TRAY'))
        return 'TRAY';
    const salesChannel = String(order.salesChannel || '')
        .trim()
        .toUpperCase();
    if (salesChannel.includes('ANYMARKET'))
        return 'ANYMARKET';
    if (salesChannel.startsWith('TRAY'))
        return 'TRAY';
    return null;
};
const mergePayload = (currentPayload, resolution) => {
    const basePayload = currentPayload && typeof currentPayload === 'object' && !Array.isArray(currentPayload)
        ? { ...currentPayload }
        : {};
    basePayload.shippingAvailability = {
        mode: resolution.mode,
        maxDays: resolution.maxDays,
        sendDate: resolution.sendDate ? resolution.sendDate.toISOString() : null,
        items: resolution.items,
        resolvedAt: new Date().toISOString(),
        resolvedBy: 'backfillOrderShippingDeadlineFromProductAvailability',
    };
    return basePayload;
};
const shouldProcessOrder = (order) => {
    if (FORCE_ALL) {
        return true;
    }
    if (!order.maxShippingDeadline) {
        return true;
    }
    const existingMaxDays = Number(order.apiRawPayload?.shippingAvailability?.maxDays);
    return !Number.isFinite(existingMaxDays);
};
const fetchCompanies = async () => {
    const result = await (0, db_1.dbQuery)(`
      SELECT
        c."id",
        c."name",
        c."anymarketIntegrationEnabled",
        c."trayIntegrationEnabled"
      FROM "Company" c
      WHERE ($1::text = '' OR c."id" = $1)
        AND ($2::text = '' OR UPPER(c."name") = $2)
      ORDER BY c."name" ASC
    `, [COMPANY_ID || '', COMPANY_NAME || '']);
    return result.rows;
};
const listOrdersBatch = async (companyId, cursor) => {
    const result = await (0, db_1.dbQuery)(`
      SELECT
        o."id",
        o."orderNumber",
        o."salesChannel",
        o."shippingDate",
        o."createdAt",
        o."maxShippingDeadline",
        o."apiRawPayload"
      FROM "Order" o
      WHERE o."companyId" = $1
        AND o."isArchived" = FALSE
        AND ($2::text = '' OR o."id" > $2)
      ORDER BY o."id" ASC
      LIMIT $3
    `, [companyId, cursor, PAGE_SIZE]);
    return result.rows;
};
const resolveAvailability = async ({ source, order, anymarketApiService, trayApiService, }) => {
    const payload = order.apiRawPayload || {};
    const baseDate = toSafeDate(order.shippingDate) || toSafeDate(order.createdAt) || new Date();
    const fromOrderPayload = source === 'ANYMARKET'
        ? (0, orderShippingAvailabilityService_1.resolveOrderShippingAvailabilityFromAnymarket)(payload, baseDate)
        : (0, orderShippingAvailabilityService_1.resolveOrderShippingAvailabilityFromTray)(payload, baseDate);
    if (fromOrderPayload.maxDays !== null) {
        return fromOrderPayload;
    }
    const references = source === 'ANYMARKET'
        ? (0, orderShippingAvailabilityService_1.extractAnymarketProductReferences)(payload)
        : (0, orderShippingAvailabilityService_1.extractTrayProductReferences)(payload);
    if (references.length === 0) {
        return fromOrderPayload;
    }
    const productPayloads = [];
    for (const reference of references) {
        if (source === 'ANYMARKET' && anymarketApiService) {
            const product = await anymarketApiService.getProductBySkuId(reference.productRef);
            if (product) {
                productPayloads.push({
                    productRef: reference.productRef,
                    payload: product,
                    integration: 'ANYMARKET',
                });
            }
        }
        if (source === 'TRAY' && trayApiService) {
            const product = await trayApiService.getProductById(reference.productRef);
            if (product) {
                productPayloads.push({
                    productRef: reference.productRef,
                    payload: product,
                    integration: 'TRAY',
                });
            }
        }
    }
    if (productPayloads.length === 0) {
        return fromOrderPayload;
    }
    const fromProducts = (0, orderShippingAvailabilityService_1.resolveOrderShippingAvailabilityFromProductPayloads)(productPayloads, baseDate);
    return fromProducts.maxDays !== null ? fromProducts : fromOrderPayload;
};
const processCompany = async (company) => {
    console.log(`\nEmpresa: ${company.name}`);
    const anymarketApiService = company.anymarketIntegrationEnabled !== false
        ? new anymarketApiService_1.AnymarketApiService(company.id)
        : null;
    const trayApiService = company.trayIntegrationEnabled !== false ? new trayApiService_1.TrayApiService(company.id) : null;
    let cursor = '';
    let scanned = 0;
    let eligible = 0;
    let resolved = 0;
    let updated = 0;
    let unchanged = 0;
    let failed = 0;
    while (true) {
        const batch = await listOrdersBatch(company.id, cursor);
        if (batch.length === 0) {
            break;
        }
        cursor = batch[batch.length - 1].id;
        scanned += batch.length;
        for (const order of batch) {
            try {
                const source = normalizeSource(order);
                if (!source) {
                    continue;
                }
                if (!shouldProcessOrder(order)) {
                    continue;
                }
                eligible += 1;
                const resolution = await resolveAvailability({
                    source,
                    order,
                    anymarketApiService,
                    trayApiService,
                });
                if (resolution.maxDays === null || !resolution.sendDate) {
                    unchanged += 1;
                    continue;
                }
                resolved += 1;
                const currentDate = toIsoDate(toSafeDate(order.maxShippingDeadline));
                const nextDate = toIsoDate(resolution.sendDate);
                const sameDate = currentDate === nextDate;
                if (sameDate) {
                    unchanged += 1;
                    continue;
                }
                if (APPLY_CHANGES) {
                    await (0, db_1.dbQuery)(`
              UPDATE "Order" o
              SET
                "maxShippingDeadline" = $2,
                "apiRawPayload" = $3::jsonb,
                "lastUpdate" = NOW()
              WHERE o."id" = $1
            `, [order.id, resolution.sendDate, JSON.stringify(mergePayload(order.apiRawPayload, resolution))]);
                }
                updated += 1;
                if (VERBOSE) {
                    console.log(`  ${order.orderNumber}: prazo envio ${currentDate || '-'} -> ${nextDate} (${source})`);
                }
            }
            catch (error) {
                failed += 1;
                console.error(`  Erro no pedido ${order.orderNumber}: ${error instanceof Error ? error.message : 'Erro desconhecido'}`);
            }
        }
    }
    console.log(`Resumo ${company.name}: varridos=${scanned}, elegiveis=${eligible}, resolvidos=${resolved}, atualizados=${updated}, sem alteracao=${unchanged}, erros=${failed}`);
    return { scanned, eligible, resolved, updated, unchanged, failed };
};
async function main() {
    console.log(`Backfill de prazo de envio por produto iniciado (${APPLY_CHANGES ? 'APPLY' : 'DRY_RUN'})`);
    const companies = await fetchCompanies();
    if (companies.length === 0) {
        console.log('Nenhuma empresa encontrada para processamento.');
        return;
    }
    let totalScanned = 0;
    let totalEligible = 0;
    let totalResolved = 0;
    let totalUpdated = 0;
    let totalUnchanged = 0;
    let totalFailed = 0;
    for (const company of companies) {
        const result = await processCompany(company);
        totalScanned += result.scanned;
        totalEligible += result.eligible;
        totalResolved += result.resolved;
        totalUpdated += result.updated;
        totalUnchanged += result.unchanged;
        totalFailed += result.failed;
    }
    console.log('\nBackfill finalizado.');
    console.log(`Pedidos varridos: ${totalScanned}`);
    console.log(`Pedidos elegiveis: ${totalEligible}`);
    console.log(`Pedidos com prazo resolvido: ${totalResolved}`);
    console.log(`Pedidos atualizados: ${totalUpdated}`);
    console.log(`Pedidos sem alteracao: ${totalUnchanged}`);
    console.log(`Pedidos com erro: ${totalFailed}`);
}
main().catch((error) => {
    console.error('Falha no backfill de prazo de envio por produto:', error instanceof Error ? error.message : 'Erro desconhecido');
    process.exitCode = 1;
});
