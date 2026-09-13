"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const db_1 = require("../lib/db");
const jetOrderLookupService_1 = require("../services/jetOrderLookupService");
const TARGET_COMPANY_NAME = String(process.env.TARGET_COMPANY_NAME || 'MPOZENATO')
    .trim()
    .toUpperCase();
const APPLY_CHANGES = String(process.env.APPLY_CHANGES || '')
    .trim()
    .toLowerCase() === 'true';
const INCLUDE_ARCHIVED = String(process.env.INCLUDE_ARCHIVED || '')
    .trim()
    .toLowerCase() === 'true';
const MAX_ORDERS = Math.max(0, Number(process.env.MAX_ORDERS || 0));
const safeString = (value) => {
    const normalized = String(value || '').trim();
    return normalized || null;
};
const resolveJetOrderIdFromPayload = (rawPayload) => safeString(rawPayload?.jetOrderId) ||
    safeString(rawPayload?.jetMeta?.idOrder) ||
    safeString(rawPayload?.jetMeta?.jetOrderId);
const formatError = (error) => error instanceof Error ? error.message : 'Erro desconhecido';
const resolveCompany = async () => {
    const companyResult = await (0, db_1.dbQuery)(`
      SELECT
        c."id",
        c."name",
        c."jetIntegrationEnabled",
        c."jetOrderLookupUrlTemplate",
        c."jetIntegrationKey",
        c."jetStoreId",
        c."jetUsername",
        c."jetPassword",
        c."jetBearerToken"
      FROM "Company" c
      WHERE UPPER(c."name") = $1
      LIMIT 1
    `, [TARGET_COMPANY_NAME]);
    return companyResult.rows[0] || null;
};
const listTargetOrders = async (companyId) => {
    const result = await (0, db_1.dbQuery)(`
      SELECT
        o."id",
        o."orderNumber",
        o."salesChannel",
        o."isArchived",
        o."apiRawPayload"
      FROM "Order" o
      WHERE o."companyId" = $1
        AND ($2::boolean = true OR o."isArchived" = false)
        AND UPPER(COALESCE(o."salesChannel", '')) LIKE '%ANYMARKET%'
      ORDER BY o."orderNumber" ASC
    `, [companyId, INCLUDE_ARCHIVED]);
    return MAX_ORDERS > 0 ? result.rows.slice(0, MAX_ORDERS) : result.rows;
};
async function main() {
    const company = await resolveCompany();
    if (!company) {
        console.log(`Empresa nao encontrada para o filtro: ${TARGET_COMPANY_NAME}`);
        return;
    }
    const jetConfig = {
        companyId: company.id,
        jetIntegrationEnabled: company.jetIntegrationEnabled === true,
        jetOrderLookupUrlTemplate: company.jetOrderLookupUrlTemplate,
        jetIntegrationKey: company.jetIntegrationKey,
        jetStoreId: company.jetStoreId,
        jetUsername: company.jetUsername,
        jetPassword: company.jetPassword,
        jetBearerToken: company.jetBearerToken,
    };
    const canLookupJet = jetOrderLookupService_1.jetOrderLookupService.isConfigured(jetConfig);
    console.log(`Empresa alvo: ${company.name} (${company.id})`);
    console.log(`Jet habilitada: ${company.jetIntegrationEnabled ? 'SIM' : 'NAO'}`);
    console.log(`Jet lookup configurado: ${canLookupJet ? 'SIM' : 'NAO'}`);
    console.log(`Modo: ${APPLY_CHANGES ? 'APLICAR ALTERACOES' : 'SIMULACAO (dry-run)'}`);
    const orders = await listTargetOrders(company.id);
    if (orders.length === 0) {
        console.log('Nenhum pedido ANYMARKET encontrado para processar.');
        return;
    }
    const existingOrderNumbers = new Set(orders.map((order) => String(order.orderNumber || '').trim()).filter(Boolean));
    const plan = [];
    let alreadyOnJetId = 0;
    let noJetId = 0;
    let conflict = 0;
    let lookupErrors = 0;
    for (const order of orders) {
        const currentOrderNumber = String(order.orderNumber || '').trim();
        const rawPayload = order.apiRawPayload && typeof order.apiRawPayload === 'object'
            ? order.apiRawPayload
            : null;
        let jetOrderId = rawPayload ? resolveJetOrderIdFromPayload(rawPayload) : null;
        let source = 'payload';
        if (!jetOrderId && rawPayload && canLookupJet) {
            try {
                const lookup = await jetOrderLookupService_1.jetOrderLookupService.lookupFromAnyMarketPayload(rawPayload, jetConfig);
                jetOrderId = safeString(lookup?.jetOrderId);
                if (jetOrderId) {
                    source = 'lookup';
                }
            }
            catch (error) {
                lookupErrors += 1;
                console.log(`Falha no lookup Jet para pedido ${currentOrderNumber}: ${formatError(error)}`);
            }
        }
        if (!jetOrderId) {
            noJetId += 1;
            continue;
        }
        if (jetOrderId === currentOrderNumber) {
            alreadyOnJetId += 1;
            continue;
        }
        if (existingOrderNumbers.has(jetOrderId)) {
            conflict += 1;
            console.log(`Conflito: pedido ${currentOrderNumber} nao pode virar ${jetOrderId} porque esse numero ja existe na selecao atual.`);
            continue;
        }
        const nextPayload = rawPayload && typeof rawPayload === 'object'
            ? {
                ...rawPayload,
                jetOrderId,
                jetMeta: {
                    ...(rawPayload.jetMeta && typeof rawPayload.jetMeta === 'object'
                        ? rawPayload.jetMeta
                        : {}),
                    idOrder: jetOrderId,
                    normalizedOrderNumberAt: new Date().toISOString(),
                    previousOrderNumber: currentOrderNumber,
                },
            }
            : rawPayload;
        plan.push({
            id: order.id,
            fromOrderNumber: currentOrderNumber,
            toOrderNumber: jetOrderId,
            source,
            nextPayload,
        });
        existingOrderNumbers.add(jetOrderId);
    }
    console.log('\nResumo do planejamento:');
    console.log(`- Pedidos ANYMARKET avaliados: ${orders.length}`);
    console.log(`- Ja estavam com idOrder Jet: ${alreadyOnJetId}`);
    console.log(`- Sem idOrder Jet disponivel: ${noJetId}`);
    console.log(`- Conflitos de numero: ${conflict}`);
    console.log(`- Erros de lookup: ${lookupErrors}`);
    console.log(`- Prontos para atualizar: ${plan.length}`);
    if (plan.length > 0) {
        console.log('\nAmostra das trocas planejadas (max 30):');
        for (const item of plan.slice(0, 30)) {
            console.log(`- ${item.fromOrderNumber} -> ${item.toOrderNumber} [${item.source}]`);
        }
    }
    if (!APPLY_CHANGES) {
        console.log('\nDry-run finalizado. Para aplicar, execute com APPLY_CHANGES=true.');
        return;
    }
    await (0, db_1.withDbTransaction)(async (client) => {
        for (const item of plan) {
            await client.query(`
          UPDATE "Order"
          SET
            "orderNumber" = $2,
            "apiRawPayload" = $3::jsonb,
            "lastUpdate" = NOW()
          WHERE "id" = $1
        `, [
                item.id,
                item.toOrderNumber,
                item.nextPayload ? JSON.stringify(item.nextPayload) : null,
            ]);
        }
    });
    console.log(`\nAtualizacao concluida. Pedidos alterados: ${plan.length}`);
}
main().catch((error) => {
    console.error('Falha no backfill de orderNumber AnyMarket -> idOrder Jet:', formatError(error));
    process.exitCode = 1;
});
