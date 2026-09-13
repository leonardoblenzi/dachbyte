"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const db_1 = require("../lib/db");
const trayApiService_1 = require("../services/trayApiService");
const PAGE_SIZE = 100;
const forceAll = ['1', 'true', 'yes', 'y', 'sim'].includes(String(process.env.FORCE_ALL || '')
    .trim()
    .toLowerCase());
const dryRun = ['1', 'true', 'yes', 'y', 'sim'].includes(String(process.env.DRY_RUN || '')
    .trim()
    .toLowerCase());
const verbose = ['1', 'true', 'yes', 'y', 'sim'].includes(String(process.env.VERBOSE || '')
    .trim()
    .toLowerCase());
const companyFilter = String(process.env.COMPANY_ID || '').trim() || null;
const startFromCompanyName = String(process.env.START_FROM_COMPANY_NAME || '')
    .trim()
    .toUpperCase();
const formatError = (error) => error instanceof Error ? error.message : 'Erro desconhecido';
const toValidDate = (value) => {
    if (!value)
        return null;
    if (value instanceof Date) {
        return Number.isNaN(value.getTime()) ? null : value;
    }
    const normalized = String(value).trim();
    if (!normalized || normalized === '0000-00-00' || /^\d+$/.test(normalized)) {
        return null;
    }
    const dateOnly = normalized.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (dateOnly) {
        const year = Number(dateOnly[1]);
        const monthIndex = Number(dateOnly[2]) - 1;
        const day = Number(dateOnly[3]);
        const parsed = new Date(Date.UTC(year, monthIndex, day, 12, 0, 0));
        return Number.isNaN(parsed.getTime()) ? null : parsed;
    }
    const parsed = new Date(normalized);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
};
const safeString = (value) => {
    const normalized = String(value || '').trim();
    return normalized || null;
};
const mergeApiRawPayload = (currentPayload, updates) => {
    const basePayload = currentPayload &&
        typeof currentPayload === 'object' &&
        !Array.isArray(currentPayload)
        ? { ...currentPayload }
        : {};
    for (const [key, value] of Object.entries(updates)) {
        if (value === undefined)
            continue;
        if (value === null || value === '') {
            delete basePayload[key];
            continue;
        }
        basePayload[key] = value;
    }
    return Object.keys(basePayload).length > 0 ? basePayload : null;
};
async function processCompany(company) {
    console.log(`\nEmpresa: ${company.name}`);
    const trayApiService = new trayApiService_1.TrayApiService(company.id);
    let cursor = null;
    let scanned = 0;
    let queued = 0;
    let updated = 0;
    let unchanged = 0;
    let withoutForecastInIntegrator = 0;
    let failed = 0;
    let processedInCompany = 0;
    while (true) {
        const ordersResult = await (0, db_1.dbQuery)(`
        SELECT
          o."id",
          o."orderNumber",
          o."estimatedDeliveryDate",
          o."maxShippingDeadline",
          o."apiRawPayload"
        FROM "Order" o
        WHERE o."companyId" = $1
          AND o."isArchived" = FALSE
          AND ($2::text = '' OR o."id" > $2)
        ORDER BY o."id" ASC
        LIMIT $3
      `, [company.id, cursor || '', PAGE_SIZE]);
        const orders = ordersResult.rows;
        if (orders.length === 0) {
            break;
        }
        cursor = orders[orders.length - 1].id;
        scanned += orders.length;
        const targetOrders = orders.filter((order) => {
            if (!safeString(order.orderNumber)) {
                return false;
            }
            if (forceAll) {
                return true;
            }
            return !order.estimatedDeliveryDate;
        });
        queued += targetOrders.length;
        for (const order of targetOrders) {
            try {
                const trayOrderResponse = await trayApiService.getOrderComplete(order.orderNumber);
                const trayOrder = trayOrderResponse?.Order;
                if (!trayOrder || typeof trayOrder !== 'object') {
                    throw new Error('Pedido nao retornou payload completo na Tray.');
                }
                const mappedOrder = trayApiService.mapTrayOrderToSystem(trayOrder, {
                    companyName: company.name,
                });
                const platformEstimatedDeliveryDate = toValidDate(mappedOrder?.estimatedDeliveryDate) ||
                    toValidDate(trayOrder?.estimated_delivery_date);
                if (!platformEstimatedDeliveryDate) {
                    withoutForecastInIntegrator += 1;
                    if (verbose) {
                        console.log(`  SEM PREVISAO ${order.orderNumber}: integradora nao retornou estimativa de entrega da plataforma.`);
                    }
                    continue;
                }
                const currentEstimated = toValidDate(order.estimatedDeliveryDate);
                if (currentEstimated &&
                    currentEstimated.getTime() === platformEstimatedDeliveryDate.getTime()) {
                    unchanged += 1;
                    continue;
                }
                if (!dryRun) {
                    await (0, db_1.dbQuery)(`
              UPDATE "Order" o
              SET
                "estimatedDeliveryDate" = $2,
                "maxShippingDeadline" = $3,
                "apiRawPayload" = $4::jsonb
              WHERE o."id" = $1
            `, [
                        order.id,
                        platformEstimatedDeliveryDate,
                        toValidDate(order.maxShippingDeadline) || platformEstimatedDeliveryDate,
                        JSON.stringify(mergeApiRawPayload(order.apiRawPayload, {
                            trayPlatformEstimatedDeliveryDate: platformEstimatedDeliveryDate.toISOString(),
                            trayPlatformEstimatedDeliveryDateBackfilledAt: new Date().toISOString(),
                        })),
                    ]);
                }
                updated += 1;
                if (verbose) {
                    console.log(`  OK ${order.orderNumber}: previsao plataforma ${platformEstimatedDeliveryDate.toISOString().slice(0, 10)}`);
                }
            }
            catch (error) {
                failed += 1;
                console.error(`  ERRO ${order.orderNumber}: ${formatError(error)}`);
            }
            finally {
                processedInCompany += 1;
                if (processedInCompany % 50 === 0) {
                    console.log(`  Progresso ${company.name}: ${processedInCompany} processados | ${updated} atualizados | ${failed} erros.`);
                }
            }
        }
    }
    console.log(`Resumo ${company.name}: ${updated} atualizado(s), ${unchanged} sem alteracao, ${withoutForecastInIntegrator} sem previsao na integradora, ${failed} com erro, ${Math.max(scanned - queued, 0)} fora do recorte.`);
    return {
        scanned,
        queued,
        updated,
        unchanged,
        withoutForecastInIntegrator,
        failed,
    };
}
async function main() {
    console.log(`Backfill de previsao de entrega da plataforma iniciado (${forceAll ? 'modo completo' : 'somente faltantes'}${dryRun ? ', DRY_RUN' : ''}).`);
    const companiesResult = await (0, db_1.dbQuery)(`
      SELECT
        c."id",
        c."name",
        c."trayIntegrationEnabled",
        c."magazordIntegrationEnabled",
        c."blingIntegrationEnabled",
        c."sysempIntegrationEnabled",
        ta."id" AS "trayAuthId"
      FROM "Company" c
      LEFT JOIN "TrayAuth" ta ON ta."companyId" = c."id"
      WHERE ($1::text = '' OR c."id" = $1)
      ORDER BY c."name" ASC
    `, [companyFilter || '']);
    const companies = companiesResult.rows;
    const filteredByName = startFromCompanyName
        ? companies.filter((company) => String(company.name || '').trim().toUpperCase() >= startFromCompanyName)
        : companies;
    const eligibleTrayCompanies = filteredByName.filter((company) => company.trayIntegrationEnabled !== false && Boolean(company.trayAuthId));
    const notSupportedYet = filteredByName.filter((company) => !company.trayAuthId &&
        (company.magazordIntegrationEnabled ||
            company.blingIntegrationEnabled ||
            company.sysempIntegrationEnabled));
    if (notSupportedYet.length > 0) {
        console.log(`Aviso: ${notSupportedYet.length} empresa(s) com integradora ativa sem cliente de backfill implementado neste script (Magazord/Bling/Sysemp).`);
    }
    if (eligibleTrayCompanies.length === 0) {
        console.log('Nenhuma empresa com Tray autorizada e integracao ativa foi encontrada para backfill.');
        return;
    }
    if (startFromCompanyName) {
        console.log(`Retomando processamento a partir de: ${startFromCompanyName}`);
    }
    let totalQueued = 0;
    let totalUpdated = 0;
    let totalUnchanged = 0;
    let totalWithoutForecastInIntegrator = 0;
    let totalFailed = 0;
    for (const company of eligibleTrayCompanies) {
        const result = await processCompany({
            id: company.id,
            name: company.name,
        });
        totalQueued += result.queued;
        totalUpdated += result.updated;
        totalUnchanged += result.unchanged;
        totalWithoutForecastInIntegrator += result.withoutForecastInIntegrator;
        totalFailed += result.failed;
    }
    console.log('\nBackfill de previsao de entrega da plataforma concluido.');
    console.log(`Pedidos enviados para consulta na integradora: ${totalQueued}`);
    console.log(`Pedidos atualizados: ${totalUpdated}`);
    console.log(`Pedidos sem alteracao: ${totalUnchanged}`);
    console.log(`Pedidos sem previsao retornada pela integradora: ${totalWithoutForecastInIntegrator}`);
    console.log(`Pedidos com erro: ${totalFailed}`);
}
main()
    .catch((error) => {
    console.error('Falha no backfill de previsao de entrega da plataforma:', formatError(error));
    process.exitCode = 1;
});
