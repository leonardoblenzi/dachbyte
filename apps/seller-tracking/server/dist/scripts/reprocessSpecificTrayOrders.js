"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const db_1 = require("../lib/db");
const trayApiService_1 = require("../services/trayApiService");
const orderImportService_1 = require("../services/orderImportService");
const DEFAULT_ORDER_NUMBERS = ['319961', '319907', '319829'];
const parseOrderNumbers = () => {
    const raw = String(process.env.ORDER_NUMBERS || '').trim();
    const source = raw.length > 0 ? raw : DEFAULT_ORDER_NUMBERS.join(',');
    return Array.from(new Set(source
        .split(/[,;\s]+/g)
        .map((value) => value.trim())
        .filter(Boolean)));
};
const orderNumbers = parseOrderNumbers();
const companyFilter = String(process.env.COMPANY_ID || '').trim() || null;
const formatError = (error) => error instanceof Error ? error.message : 'Erro desconhecido';
async function main() {
    if (orderNumbers.length === 0) {
        console.log('Nenhum pedido informado para reprocessar.');
        return;
    }
    console.log(`Reprocessamento Tray iniciado para os pedidos: ${orderNumbers.join(', ')}`);
    if (companyFilter) {
        console.log(`Filtro de empresa ativo: ${companyFilter}`);
    }
    const companiesResult = await (0, db_1.dbQuery)(`
      SELECT
        c."id",
        c."name",
        c."trayIntegrationEnabled",
        ta."id" AS "trayAuthId"
      FROM "Company" c
      LEFT JOIN "TrayAuth" ta ON ta."companyId" = c."id"
      WHERE ($1::text = '' OR c."id" = $1)
      ORDER BY c."name" ASC
    `, [companyFilter || '']);
    const companies = companiesResult.rows;
    const eligibleCompanies = companies.filter((company) => company.trayIntegrationEnabled !== false && Boolean(company.trayAuthId));
    if (eligibleCompanies.length === 0) {
        console.log('Nenhuma empresa elegivel com Tray autorizada foi encontrada.');
        return;
    }
    let totalMatched = 0;
    let totalUpdated = 0;
    let totalFailed = 0;
    for (const company of eligibleCompanies) {
        const existingOrdersResult = await (0, db_1.dbQuery)(`
        SELECT
          o."orderNumber",
          o."status",
          o."freightType"
        FROM "Order" o
        WHERE o."companyId" = $1
          AND o."orderNumber" = ANY($2::text[])
        ORDER BY o."orderNumber" ASC
      `, [company.id, orderNumbers]);
        const existingOrders = existingOrdersResult.rows;
        if (existingOrders.length === 0) {
            continue;
        }
        totalMatched += existingOrders.length;
        console.log(`\nEmpresa ${company.name}: ${existingOrders.length} pedido(s) localizado(s).`);
        const trayApiService = new trayApiService_1.TrayApiService(company.id);
        for (const order of existingOrders) {
            const beforeStatus = String(order.status || '');
            const beforeCarrier = String(order.freightType || '');
            try {
                const completeOrderResponse = await trayApiService.getOrderComplete(order.orderNumber);
                const trayOrder = completeOrderResponse?.Order;
                if (!trayOrder || typeof trayOrder !== 'object') {
                    throw new Error('Pedido nao retornou payload completo na Tray.');
                }
                const mappedOrder = trayApiService.mapTrayOrderToSystem(trayOrder, {
                    companyName: company.name,
                });
                const importResult = await (0, orderImportService_1.importOrdersForCompany)(company.id, [mappedOrder]);
                const importUpdated = Number(importResult?.results?.updated || 0) +
                    Number(importResult?.results?.created || 0);
                const refreshedOrderResult = await (0, db_1.dbQuery)(`
            SELECT
              o."status",
              o."freightType",
              o."invoiceNumber",
              o."trackingCode"
            FROM "Order" o
            WHERE o."companyId" = $1
              AND o."orderNumber" = $2
            ORDER BY o."createdAt" DESC
            LIMIT 1
          `, [company.id, order.orderNumber]);
                const refreshedOrder = refreshedOrderResult.rows[0] || null;
                const afterStatus = String(refreshedOrder?.status || '');
                const afterCarrier = String(refreshedOrder?.freightType || '');
                totalUpdated += importUpdated > 0 ? 1 : 0;
                console.log(`  OK ${order.orderNumber}: status ${beforeStatus} -> ${afterStatus} | transportadora ${beforeCarrier} -> ${afterCarrier} | NF ${refreshedOrder?.invoiceNumber || '-'} | rastreio ${refreshedOrder?.trackingCode || '-'}`);
            }
            catch (error) {
                totalFailed += 1;
                console.error(`  ERRO ${order.orderNumber}: ${formatError(error)}`);
            }
        }
    }
    if (totalMatched === 0) {
        console.log('Nenhum dos pedidos informados foi encontrado nas empresas elegiveis.');
        return;
    }
    console.log('\nReprocessamento concluido.');
    console.log(`Pedidos localizados: ${totalMatched}`);
    console.log(`Pedidos reprocessados com sucesso: ${totalUpdated}`);
    console.log(`Pedidos com falha: ${totalFailed}`);
}
main()
    .catch((error) => {
    console.error('Falha no reprocessamento especifico:', formatError(error));
    process.exitCode = 1;
});
