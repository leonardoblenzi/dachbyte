"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const db_1 = require("../lib/db");
const trayApiService_1 = require("../services/trayApiService");
const PAGE_SIZE = 100;
const forceAll = ['1', 'true', 'yes', 'y', 'sim'].includes(String(process.env.FORCE_ALL || '')
    .trim()
    .toLowerCase());
const companyFilter = String(process.env.COMPANY_ID || '').trim() || null;
const safeString = (value) => {
    const normalized = String(value || '').trim();
    return normalized || null;
};
const formatError = (error) => error instanceof Error ? error.message : 'Erro desconhecido';
const extractStoredQuotationId = (order) => safeString(order.originalQuotedFreightQuotationId) ||
    safeString(order.apiRawPayload?.id_quotation) ||
    safeString(order.apiRawPayload?.quotation_id) ||
    null;
async function processCompany(company) {
    console.log(`\nEmpresa: ${company.name}`);
    const trayApiService = new trayApiService_1.TrayApiService(company.id);
    let cursor = null;
    let scanned = 0;
    let queued = 0;
    let updated = 0;
    let missingInTray = 0;
    let failed = 0;
    while (true) {
        const ordersResult = await (0, db_1.dbQuery)(`
        SELECT
          o."id",
          o."orderNumber",
          o."invoiceNumber",
          o."originalQuotedFreightQuotationId",
          o."originalQuotedFreightValue",
          o."originalQuotedFreightDate",
          o."originalQuotedFreightDetails",
          o."apiRawPayload"
        FROM "Order" o
        WHERE o."companyId" = $1
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
            return !extractStoredQuotationId(order);
        });
        queued += targetOrders.length;
        for (const order of targetOrders) {
            try {
                const completeOrderResponse = await trayApiService.getOrderComplete(order.orderNumber);
                const trayOrder = completeOrderResponse?.Order;
                if (!trayOrder || typeof trayOrder !== 'object') {
                    throw new Error('Pedido nao retornou payload completo na Tray.');
                }
                const mappedOrder = trayApiService.mapTrayOrderToSystem(trayOrder);
                const quotationId = safeString(mappedOrder?.originalQuotedFreightQuotationId) ||
                    safeString(trayOrder?.id_quotation) ||
                    safeString(trayOrder?.quotation_id);
                if (!quotationId) {
                    missingInTray += 1;
                    console.log(`  SEM ID ${order.orderNumber}: a Tray nao retornou quotation_id para este pedido.`);
                    continue;
                }
                await (0, db_1.dbQuery)(`
            UPDATE "Order" o
            SET
              "originalQuotedFreightQuotationId" = $2,
              "originalQuotedFreightValue" = $3,
              "originalQuotedFreightDate" = $4,
              "originalQuotedFreightDetails" = $5::jsonb,
              "apiRawPayload" = $6::jsonb
            WHERE o."id" = $1
          `, [
                    order.id,
                    quotationId,
                    mappedOrder?.originalQuotedFreightValue ?? order.originalQuotedFreightValue,
                    mappedOrder?.originalQuotedFreightDate ?? order.originalQuotedFreightDate,
                    JSON.stringify(mappedOrder?.originalQuotedFreightDetails ??
                        order.originalQuotedFreightDetails ??
                        null),
                    JSON.stringify(trayOrder ?? null),
                ]);
                updated += 1;
                console.log(`  OK ${order.orderNumber}: quotation_id ${quotationId}`);
            }
            catch (error) {
                failed += 1;
                console.error(`  ERRO ${order.orderNumber}: ${formatError(error)}`);
            }
        }
    }
    console.log(`Resumo ${company.name}: ${updated} atualizado(s), ${missingInTray} sem quotation_id na Tray, ${failed} com erro, ${Math.max(scanned - queued, 0)} ja estavam preenchidos no recorte.`);
    return {
        scanned,
        queued,
        updated,
        missingInTray,
        failed,
    };
}
async function main() {
    console.log(`Backfill de quotation_id da Tray iniciado (${forceAll ? 'modo completo' : 'somente faltantes'}).`);
    const companiesResult = await (0, db_1.dbQuery)(`
      SELECT
        c."id",
        c."name",
        ta."id" AS "trayAuthId"
      FROM "Company" c
      LEFT JOIN "TrayAuth" ta ON ta."companyId" = c."id"
      WHERE ($1::text = '' OR c."id" = $1)
    `, [companyFilter || '']);
    const companies = companiesResult.rows;
    const eligibleCompanies = companies.filter((company) => Boolean(company.trayAuthId));
    if (eligibleCompanies.length === 0) {
        console.log('Nenhuma empresa com Tray autorizada foi encontrada.');
        return;
    }
    let totalQueued = 0;
    let totalUpdated = 0;
    let totalMissingInTray = 0;
    let totalFailed = 0;
    for (const company of eligibleCompanies) {
        const result = await processCompany({
            id: company.id,
            name: company.name,
        });
        totalQueued += result.queued;
        totalUpdated += result.updated;
        totalMissingInTray += result.missingInTray;
        totalFailed += result.failed;
    }
    console.log('\nBackfill de quotation_id concluido.');
    console.log(`Pedidos enviados para consulta na Tray: ${totalQueued}`);
    console.log(`Pedidos atualizados: ${totalUpdated}`);
    console.log(`Pedidos sem quotation_id retornado pela Tray: ${totalMissingInTray}`);
    console.log(`Pedidos com erro: ${totalFailed}`);
}
main()
    .catch((error) => {
    console.error('Falha no backfill de quotation_id da Tray:', formatError(error));
    process.exitCode = 1;
});
