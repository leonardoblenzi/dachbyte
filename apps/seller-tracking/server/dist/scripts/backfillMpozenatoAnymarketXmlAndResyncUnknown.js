"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const db_1 = require("../lib/db");
const anymarketApiService_1 = require("../services/anymarketApiService");
const orderImportService_1 = require("../services/orderImportService");
const trackingService_1 = require("../services/trackingService");
const TARGET_COMPANY_NAME = String(process.env.TARGET_COMPANY_NAME || 'MPOZENATO')
    .trim()
    .toUpperCase();
const APPLY_CHANGES = String(process.env.APPLY_CHANGES || '')
    .trim()
    .toLowerCase() === 'true';
const ONLY_UNKNOWN_ORDERS = String(process.env.ONLY_UNKNOWN_ORDERS || 'true')
    .trim()
    .toLowerCase() !== 'false';
const BATCH_LIMIT = Number(process.env.BATCH_LIMIT || 0);
const BATCH_OFFSET = Number(process.env.BATCH_OFFSET || 0);
const AFTER_ORDER_NUMBER = String(process.env.AFTER_ORDER_NUMBER || '').trim();
const normalizeText = (value) => String(value || '').trim();
const formatError = (error) => error instanceof Error ? error.message : 'Erro desconhecido';
const resolveCompany = async () => {
    const result = await (0, db_1.dbQuery)(`
      SELECT c."id", c."name"
      FROM "Company" c
      WHERE UPPER(c."name") = $1
      LIMIT 1
    `, [TARGET_COMPANY_NAME]);
    return result.rows[0] || null;
};
const listTargetOrders = async (companyId) => {
    const result = await (0, db_1.dbQuery)(`
      SELECT
        o."id",
        o."orderNumber",
        o."status",
        o."isArchived",
        o."invoiceNumber",
        o."invoiceAccessKey",
        latest."status" AS "latestTrackingStatus",
        latest."description" AS "latestTrackingDescription"
      FROM "Order" o
      LEFT JOIN LATERAL (
        SELECT
          te."status",
          te."description"
        FROM "TrackingEvent" te
        WHERE te."orderId" = o."id"
        ORDER BY te."eventDate" DESC
        LIMIT 1
      ) latest ON TRUE
      WHERE o."companyId" = $1
        AND o."status" <> 'DELIVERED'
        AND UPPER(COALESCE(o."salesChannel", '')) LIKE '%ANYMARKET%'
        AND ($5::text = '' OR o."orderNumber" > $5)
        AND (
          $2::boolean = false
          OR UPPER(COALESCE(latest."status", '')) = 'UNKNOWN'
          OR UPPER(COALESCE(latest."description", '')) LIKE 'RASTREAMENTO ANYMARKET: UNKNOWN.%'
          OR UPPER(COALESCE(latest."description", '')) LIKE 'RASTREAMENTO ANYMARKET: UNKNOW.%'
        )
      ORDER BY o."orderNumber" ASC
      LIMIT CASE WHEN $3::int > 0 THEN $3::int ELSE NULL END
      OFFSET CASE WHEN $4::int > 0 THEN $4::int ELSE 0 END
    `, [companyId, ONLY_UNKNOWN_ORDERS, BATCH_LIMIT, BATCH_OFFSET, AFTER_ORDER_NUMBER]);
    return result.rows;
};
const fetchAnymarketOrderByIdentifiers = async (api, orderNumber) => {
    const attempts = [
        { partnerId: orderNumber },
        { marketplaceId: orderNumber },
        { shippingId: orderNumber },
    ];
    for (const params of attempts) {
        const response = await api.listOrders({
            limit: 5,
            offset: 0,
            ...params,
        });
        const orders = Array.isArray(response.content) ? response.content : [];
        if (orders.length > 0) {
            return orders[0];
        }
    }
    return null;
};
const isAnymarketUnknownTracking = (order) => {
    const latestStatus = normalizeText(order.latestTrackingStatus).toUpperCase();
    const latestDescription = normalizeText(order.latestTrackingDescription).toUpperCase();
    return (latestStatus === 'UNKNOWN' ||
        latestDescription.startsWith('RASTREAMENTO ANYMARKET: UNKNOWN.') ||
        latestDescription.startsWith('RASTREAMENTO ANYMARKET: UNKNOW.'));
};
async function main() {
    const company = await resolveCompany();
    if (!company) {
        console.log(`Empresa nao encontrada para o filtro: ${TARGET_COMPANY_NAME}`);
        return;
    }
    const orders = await listTargetOrders(company.id);
    const anymarketApi = new anymarketApiService_1.AnymarketApiService(company.id);
    const trackingService = new trackingService_1.TrackingService();
    console.log(`Empresa alvo: ${company.name} (${company.id})`);
    console.log(`Modo: ${APPLY_CHANGES ? 'APLICAR ALTERACOES' : 'SIMULACAO (dry-run)'}`);
    console.log(`Filtro UNKNOWN: ${ONLY_UNKNOWN_ORDERS ? 'SIM' : 'NAO'} | Batch limit: ${BATCH_LIMIT > 0 ? BATCH_LIMIT : 'sem limite'} | Batch offset: ${BATCH_OFFSET > 0 ? BATCH_OFFSET : 0}`);
    if (AFTER_ORDER_NUMBER) {
        console.log(`Cursor AFTER_ORDER_NUMBER: ${AFTER_ORDER_NUMBER}`);
    }
    console.log(`Pedidos carregados para processamento: ${orders.length}`);
    if (orders.length > 0) {
        console.log(`Faixa deste lote: ${orders[0].orderNumber} -> ${orders[orders.length - 1].orderNumber}`);
    }
    let analyzed = 0;
    let imported = 0;
    let xmlFilled = 0;
    let unknownSyncRequested = 0;
    let unknownSyncSuccess = 0;
    let notFound = 0;
    let errors = 0;
    for (const order of orders) {
        analyzed += 1;
        const orderNumber = normalizeText(order.orderNumber);
        if (analyzed % 25 === 0) {
            console.log(`Progresso: ${analyzed}/${orders.length} pedidos processados...`);
        }
        try {
            const anymarketOrder = await fetchAnymarketOrderByIdentifiers(anymarketApi, orderNumber);
            if (!anymarketOrder) {
                notFound += 1;
            }
            else {
                const mapped = anymarketApi.mapAnymarketOrderToSystem(anymarketOrder);
                if (!mapped.invoiceAccessKey) {
                    const anymarketOrderId = normalizeText(anymarketOrder?.id);
                    if (anymarketOrderId) {
                        const xmlLookup = await anymarketApi.getOrderNfeXmlAccessKey(anymarketOrderId);
                        if (xmlLookup.accessKey) {
                            mapped.invoiceAccessKey = xmlLookup.accessKey;
                            mapped.invoiceXmlUrl =
                                mapped.invoiceXmlUrl ||
                                    `https://api.anymarket.com.br/v2${xmlLookup.endpoint}`;
                            xmlFilled += 1;
                        }
                    }
                }
                if (APPLY_CHANGES) {
                    const importResult = await (0, orderImportService_1.importOrdersForCompany)(company.id, [mapped]);
                    imported += importResult.results.created + importResult.results.updated;
                }
            }
            const shouldSyncOrder = ONLY_UNKNOWN_ORDERS || isAnymarketUnknownTracking(order);
            if (shouldSyncOrder) {
                unknownSyncRequested += 1;
                if (APPLY_CHANGES) {
                    const syncResult = await trackingService.syncOrder(order.id, company.id, {
                        forceFinalized: true,
                    });
                    if (syncResult.success) {
                        unknownSyncSuccess += 1;
                    }
                }
            }
        }
        catch (error) {
            errors += 1;
            console.log(`Erro no pedido ${orderNumber}: ${formatError(error)}`);
        }
    }
    console.log('\n===== Resumo =====');
    console.log(`Pedidos analisados: ${analyzed}`);
    console.log(`Pedidos encontrados na AnyMarket: ${analyzed - notFound}`);
    console.log(`Pedidos importados/atualizados: ${imported}`);
    console.log(`Chave NF preenchida via XML: ${xmlFilled}`);
    console.log(`Pedidos UNKNOWN para sync de rastreio: ${unknownSyncRequested}`);
    console.log(`Sync UNKNOWN com sucesso: ${unknownSyncSuccess}`);
    console.log(`Nao encontrados na AnyMarket: ${notFound}`);
    console.log(`Erros: ${errors}`);
    if (!APPLY_CHANGES) {
        console.log('\nDry-run finalizado. Para aplicar alteracoes, execute novamente com APPLY_CHANGES=true.');
    }
}
main().catch((error) => {
    console.error('Falha no script de backfill AnyMarket XML + resync UNKNOWN:', formatError(error));
    process.exitCode = 1;
});
