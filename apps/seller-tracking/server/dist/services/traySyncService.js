"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.traySyncService = exports.TraySyncService = void 0;
const trayApiService_1 = require("./trayApiService");
const trayAuthService_1 = require("./trayAuthService");
const orderImportService_1 = require("./orderImportService");
const db_1 = require("../lib/db");
const trayFreightService_1 = require("./trayFreightService");
const orderExclusion_1 = require("../utils/orderExclusion");
const freightRecalculationService_1 = require("./freightRecalculationService");
const integrationOrderStatusService_1 = require("./integrationOrderStatusService");
const demoCompanyService_1 = require("./demoCompanyService");
const syncCancellation_1 = require("../utils/syncCancellation");
const integrationInvoiceXmlRevisitService_1 = require("./integrationInvoiceXmlRevisitService");
const TRAY_STATUS_OPTIONS = [
    'pedido cadastrado',
    'a enviar',
    '5- aguardando faturamento',
    'enviado',
    'finalizado',
    'entregue',
    'cancelado',
    'aguardando envio',
];
const VALID_DAY_OPTIONS = [90, 60, 30, 15, 7, 2];
const normalizeRequestedStatuses = (value) => {
    if (!Array.isArray(value)) {
        return [];
    }
    return value
        .map((status) => String(status || '').trim().toLowerCase())
        .filter(Boolean);
};
const resolveModifiedDate = (days) => {
    const modified = new Date();
    modified.setHours(0, 0, 0, 0);
    modified.setDate(modified.getDate() - days);
    return modified.toISOString().slice(0, 10);
};
const DIRECT_REVISIT_BATCH_SIZE = 20;
class TraySyncService {
    async executeSync(companyId, filters, hooks) {
        const requestedStoreId = typeof filters.storeId === 'string' && filters.storeId.trim()
            ? filters.storeId.trim()
            : undefined;
        const companyResult = await (0, db_1.dbQuery)(`
        SELECT
          c."name",
          c."cnpj",
          c."documentNumber",
          c."trayIntegrationEnabled",
          c."integrationCarrierExceptions"
        FROM "Company" c
        WHERE c."id" = $1
        LIMIT 1
      `, [companyId]);
        const company = companyResult.rows[0] || null;
        if ((0, demoCompanyService_1.isDemoCompany)(company)) {
            throw new Error('Sincronizacao da Integradora desabilitada para empresa demonstrativa.');
        }
        if (company?.trayIntegrationEnabled === false) {
            throw new Error('A integracao da Integradora esta desativada para esta empresa.');
        }
        const auth = await trayAuthService_1.trayAuthService.getCurrentAuth(companyId, requestedStoreId);
        if (!auth) {
            throw new Error('Nenhuma integracao Tray autorizada foi encontrada.');
        }
        const selectedDays = Number(filters.days);
        const days = VALID_DAY_OPTIONS.includes(selectedDays)
            ? selectedDays
            : 30;
        const statusMode = filters.statusMode === 'selected' ? 'selected' : 'all_except_canceled';
        const requestedStatuses = normalizeRequestedStatuses(filters.statuses);
        const availableStatuses = await integrationOrderStatusService_1.integrationOrderStatusService.getOrderImportStatuses(companyId);
        const statusesToSync = statusMode === 'selected'
            ? requestedStatuses
            : (availableStatuses.statuses.length > 0
                ? availableStatuses.statuses
                    .map((status) => String(status.value || '').trim().toLowerCase())
                    .filter((status) => status &&
                    !availableStatuses.cancelStatusValues
                        .map((value) => String(value || '').trim().toLowerCase())
                        .includes(status))
                : TRAY_STATUS_OPTIONS.filter((status) => status !== 'cancelado'));
        if (statusMode === 'selected' && statusesToSync.length === 0) {
            throw new Error('Selecione ao menos um status da Tray para sincronizar.');
        }
        const modified = resolveModifiedDate(days);
        const trayApi = new trayApiService_1.TrayApiService(companyId);
        const freightService = new trayFreightService_1.TrayFreightService(companyId);
        const storedOrdersResult = await (0, db_1.dbQuery)(`
        SELECT
          o."id",
          o."orderNumber",
          o."invoiceNumber",
          o."invoiceAccessKey",
          o."invoiceXmlRevisitState",
          o."trackingCode",
          o."estimatedDeliveryDate",
          o."freightType",
          o."status"
        FROM "Order" o
        WHERE o."companyId" = $1
      `, [companyId]);
        const storedOrders = storedOrdersResult.rows;
        const ordersToRemoveByCarrierException = storedOrders.filter((order) => (0, orderExclusion_1.shouldSkipPlatformOrderImport)({
            freightType: order.freightType,
            carrierExceptions: company?.integrationCarrierExceptions,
        }));
        if (ordersToRemoveByCarrierException.length > 0) {
            await (0, db_1.dbQuery)(`
          DELETE FROM "Order"
          WHERE "id" = ANY($1::text[])
        `, [ordersToRemoveByCarrierException.map((order) => String(order.id))]);
            hooks?.onLog?.(`${ordersToRemoveByCarrierException.length} pedido(s) existente(s) foram removidos por baterem com a excecao de transportadora antes do sync.`);
        }
        const removedOrderIds = new Set(ordersToRemoveByCarrierException.map((order) => String(order.id)));
        const eligibleStoredOrders = storedOrders.filter((order) => !removedOrderIds.has(order.id));
        const existingOrderNumbers = new Set(eligibleStoredOrders.map((order) => String(order.orderNumber)));
        const revisitStateAtStart = await (0, integrationInvoiceXmlRevisitService_1.refreshInvoiceXmlRevisitState)(companyId, Array.from(existingOrderNumbers));
        const pendingInvoiceXmlOrderNumbers = revisitStateAtStart.pendingOrderNumbers;
        // A listagem por modified deve abrir tambem pedidos que ja existem no banco.
        const skipOrderNumbers = new Set();
        const aggregateResults = {
            created: 0,
            updated: 0,
            skipped: 0,
            totalTrackingEvents: 0,
            errors: [],
            createdOrders: [],
            updatedOrders: [],
            skippedOrders: [],
        };
        let processedOrdersCount = 0;
        let revisitedOrdersCount = 0;
        let shippingOverdueCheckedCount = 0;
        let shippingOverdueUpdatedCount = 0;
        hooks?.onStart?.({ total: statusesToSync.length });
        hooks?.onLog?.(`Sincronizacao Tray iniciada com janela de alteracoes dos ultimos ${days} dias e ${statusesToSync.length} status.`);
        if (pendingInvoiceXmlOrderNumbers.size > 0) {
            hooks?.onLog?.(`${pendingInvoiceXmlOrderNumbers.size} pedido(s) existente(s) sem NF/Chave NF serao revisitados na Tray.`);
        }
        for (let index = 0; index < statusesToSync.length; index += 1) {
            if (hooks?.shouldCancel?.()) {
                throw new syncCancellation_1.SyncCancellationError();
            }
            const trayStatus = statusesToSync[index];
            hooks?.onStatusStart?.({
                status: trayStatus,
                index: index + 1,
                total: statusesToSync.length,
            });
            hooks?.onLog?.(`Buscando pedidos Tray com status "${trayStatus}".`);
            const importedTrayOrdersCount = await trayApi.syncAllOrders({
                status: trayStatus,
                modified,
                skipOrderNumbers,
            }, {
                onLog: hooks?.onLog,
                shouldCancel: hooks?.shouldCancel,
                onOrdersBatch: async (batchOrders) => {
                    if (hooks?.shouldCancel?.()) {
                        throw new syncCancellation_1.SyncCancellationError();
                    }
                    // O filtro modified da Tray inclui pedidos novos e pedidos ja existentes alterados.
                    const ordersToProcess = batchOrders;
                    if (ordersToProcess.length === 0) {
                        return;
                    }
                    const revisitedOrders = ordersToProcess.filter((order) => pendingInvoiceXmlOrderNumbers.has(String(order.id)));
                    const mappedOrders = ordersToProcess.map((order) => trayApi.mapTrayOrderToSystem(order, {
                        companyName: company?.name,
                    }));
                    const importResult = await (0, orderImportService_1.importOrdersForCompany)(companyId, mappedOrders);
                    aggregateResults.created += importResult.results.created;
                    aggregateResults.updated += importResult.results.updated;
                    aggregateResults.skipped += importResult.results.skipped;
                    aggregateResults.totalTrackingEvents +=
                        importResult.results.totalTrackingEvents;
                    aggregateResults.errors.push(...importResult.results.errors);
                    aggregateResults.createdOrders.push(...importResult.results.createdOrders);
                    aggregateResults.updatedOrders.push(...importResult.results.updatedOrders);
                    aggregateResults.skippedOrders.push(...(importResult.results.skippedOrders || []));
                    processedOrdersCount += ordersToProcess.length;
                    revisitedOrdersCount += revisitedOrders.length;
                    const affectedOrderIds = [
                        ...importResult.results.createdOrders,
                        ...importResult.results.updatedOrders,
                    ]
                        .map((order) => order.orderId)
                        .filter((orderId) => Boolean(orderId));
                    if (affectedOrderIds.length > 0) {
                        const ordersForFreightResult = await (0, db_1.dbQuery)(`
                  SELECT
                    o."id",
                    o."orderNumber",
                    o."freightType",
                    o."zipCode",
                    o."freightValue",
                    o."apiRawPayload",
                    o."recalculatedFreightValue",
                    o."recalculatedFreightDate",
                    o."recalculatedFreightDetails"
                  FROM "Order" o
                  WHERE o."id" = ANY($1::text[])
                `, [affectedOrderIds]);
                        const ordersForFreight = ordersForFreightResult.rows;
                        let recalculatedCount = 0;
                        let skippedRecalculationCount = 0;
                        for (const order of ordersForFreight) {
                            if (hooks?.shouldCancel?.()) {
                                throw new syncCancellation_1.SyncCancellationError();
                            }
                            try {
                                if (!(0, freightRecalculationService_1.needsFreightRecalculation)(order)) {
                                    skippedRecalculationCount += 1;
                                    continue;
                                }
                                await (0, freightRecalculationService_1.recalculateStoredOrderFreight)({
                                    order,
                                    companyId,
                                    freightService,
                                });
                                recalculatedCount += 1;
                            }
                            catch (error) {
                                const message = error instanceof Error ? error.message : 'Erro desconhecido';
                                aggregateResults.errors.push(`Frete ${order.orderNumber}: ${message}`);
                                hooks?.onLog?.(`Falha ao recalcular frete do pedido ${order.orderNumber}: ${message}`);
                            }
                        }
                        hooks?.onLog?.(`Frete recalculado no lote: ${recalculatedCount} pedido(s) atualizado(s), ${skippedRecalculationCount} ja estavam completos.`);
                    }
                    const processedOrderNumbers = ordersToProcess.map((order) => String(order.id));
                    const refreshedRevisitState = await (0, integrationInvoiceXmlRevisitService_1.refreshInvoiceXmlRevisitState)(companyId, processedOrderNumbers);
                    for (const orderNumber of processedOrderNumbers) {
                        existingOrderNumbers.add(orderNumber);
                        if (refreshedRevisitState.pendingOrderNumbers.has(orderNumber)) {
                            pendingInvoiceXmlOrderNumbers.add(orderNumber);
                        }
                        else {
                            pendingInvoiceXmlOrderNumbers.delete(orderNumber);
                        }
                        const shouldSkipOrder = !pendingInvoiceXmlOrderNumbers.has(orderNumber);
                        if (shouldSkipOrder) {
                            skipOrderNumbers.add(orderNumber);
                        }
                        else {
                            skipOrderNumbers.delete(orderNumber);
                        }
                    }
                    hooks?.onLog?.(`Lote importado no banco: ${importResult.results.created} criado(s), ${importResult.results.updated} atualizado(s), ${revisitedOrders.length} revisitado(s) por falta de NF/Chave NF.`);
                },
            });
            hooks?.onStatusFinish?.({
                status: trayStatus,
                index: index + 1,
                total: statusesToSync.length,
                imported: importedTrayOrdersCount,
            });
            hooks?.onLog?.(`Status "${trayStatus}" finalizado com ${importedTrayOrdersCount} pedido(s) consultado(s) na Tray.`);
        }
        const remainingOrderNumbers = Array.from(pendingInvoiceXmlOrderNumbers);
        if (remainingOrderNumbers.length > 0) {
            const pendingIdentifierCount = pendingInvoiceXmlOrderNumbers.size;
            hooks?.onLog?.(`Revisita direta iniciada para ${remainingOrderNumbers.length} pedido(s) fora da janela automatica (${pendingIdentifierCount} sem NF/Chave NF).`);
            for (let batchStart = 0; batchStart < remainingOrderNumbers.length; batchStart += DIRECT_REVISIT_BATCH_SIZE) {
                if (hooks?.shouldCancel?.()) {
                    throw new syncCancellation_1.SyncCancellationError();
                }
                const batchOrderNumbers = remainingOrderNumbers.slice(batchStart, batchStart + DIRECT_REVISIT_BATCH_SIZE);
                const completeOrders = (await Promise.all(batchOrderNumbers.map(async (orderNumber) => {
                    try {
                        const completeData = await trayApi.getOrderComplete(orderNumber);
                        return completeData?.Order || null;
                    }
                    catch (error) {
                        const message = error instanceof Error ? error.message : 'erro desconhecido';
                        aggregateResults.errors.push(`Pedido ${orderNumber}: falha na revisita direta da Tray (${message})`);
                        hooks?.onLog?.(`Falha na revisita direta do pedido ${orderNumber}: ${message}`);
                        return null;
                    }
                }))).filter((order) => Boolean(order));
                if (completeOrders.length === 0) {
                    continue;
                }
                const mappedOrders = completeOrders.map((order) => trayApi.mapTrayOrderToSystem(order, {
                    companyName: company?.name,
                }));
                const importResult = await (0, orderImportService_1.importOrdersForCompany)(companyId, mappedOrders);
                aggregateResults.created += importResult.results.created;
                aggregateResults.updated += importResult.results.updated;
                aggregateResults.skipped += importResult.results.skipped;
                aggregateResults.totalTrackingEvents +=
                    importResult.results.totalTrackingEvents;
                aggregateResults.errors.push(...importResult.results.errors);
                aggregateResults.createdOrders.push(...importResult.results.createdOrders);
                aggregateResults.updatedOrders.push(...importResult.results.updatedOrders);
                aggregateResults.skippedOrders.push(...(importResult.results.skippedOrders || []));
                processedOrdersCount += completeOrders.length;
                revisitedOrdersCount += completeOrders.length;
                const completeOrderNumbers = completeOrders.map((order) => String(order.id));
                const refreshedRevisitState = await (0, integrationInvoiceXmlRevisitService_1.refreshInvoiceXmlRevisitState)(companyId, completeOrderNumbers);
                for (const orderNumber of completeOrderNumbers) {
                    existingOrderNumbers.add(orderNumber);
                    if (refreshedRevisitState.pendingOrderNumbers.has(orderNumber)) {
                        pendingInvoiceXmlOrderNumbers.add(orderNumber);
                        skipOrderNumbers.delete(orderNumber);
                    }
                    else {
                        pendingInvoiceXmlOrderNumbers.delete(orderNumber);
                        skipOrderNumbers.add(orderNumber);
                    }
                }
                hooks?.onLog?.(`Revisita direta importada: ${importResult.results.created} criado(s), ${importResult.results.updated} atualizado(s) em ${completeOrders.length} pedido(s).`);
            }
        }
        if (filters.revisitShippingOverdue === true) {
            const shippingOverdueResult = await (0, db_1.dbQuery)(`
          SELECT o."orderNumber"
          FROM "Order" o
          WHERE o."companyId" = $1
            AND o."isArchived" = FALSE
            AND o."status" IN ('PENDING', 'CREATED')
            AND COALESCE(o."maxShippingDeadline", o."shippingDate") IS NOT NULL
            AND COALESCE(o."maxShippingDeadline", o."shippingDate")::date <
              (NOW() AT TIME ZONE 'America/Sao_Paulo')::date
          ORDER BY COALESCE(o."maxShippingDeadline", o."shippingDate") ASC
        `, [companyId]);
            const shippingOverdueOrderNumbers = shippingOverdueResult.rows.map((order) => String(order.orderNumber));
            hooks?.onLog?.(`Verificacao Tray iniciada para ${shippingOverdueOrderNumbers.length} pedido(s) com envio atrasado.`);
            for (let batchStart = 0; batchStart < shippingOverdueOrderNumbers.length; batchStart += DIRECT_REVISIT_BATCH_SIZE) {
                if (hooks?.shouldCancel?.()) {
                    throw new syncCancellation_1.SyncCancellationError();
                }
                const batchOrderNumbers = shippingOverdueOrderNumbers.slice(batchStart, batchStart + DIRECT_REVISIT_BATCH_SIZE);
                const checkedOrders = (await Promise.all(batchOrderNumbers.map(async (orderNumber) => {
                    try {
                        const completeData = await trayApi.getOrderComplete(orderNumber);
                        return {
                            orderNumber,
                            order: completeData?.Order || null,
                        };
                    }
                    catch (error) {
                        const message = error instanceof Error ? error.message : 'erro desconhecido';
                        aggregateResults.errors.push(`Pedido ${orderNumber}: falha ao verificar envio atrasado na Tray (${message})`);
                        hooks?.onLog?.(`Falha ao verificar o pedido atrasado ${orderNumber} na Tray: ${message}`);
                        return null;
                    }
                }))).filter((entry) => Boolean(entry));
                shippingOverdueCheckedCount += checkedOrders.length;
                const shippedOrders = checkedOrders
                    .map((entry) => entry.order)
                    .filter((order) => order && String(order.status || '').trim().toUpperCase() === 'ENVIADO');
                if (shippedOrders.length === 0) {
                    continue;
                }
                const mappedOrders = shippedOrders.map((order) => trayApi.mapTrayOrderToSystem(order, {
                    companyName: company?.name,
                }));
                const importResult = await (0, orderImportService_1.importOrdersForCompany)(companyId, mappedOrders);
                aggregateResults.created += importResult.results.created;
                aggregateResults.updated += importResult.results.updated;
                aggregateResults.skipped += importResult.results.skipped;
                aggregateResults.totalTrackingEvents +=
                    importResult.results.totalTrackingEvents;
                aggregateResults.errors.push(...importResult.results.errors);
                aggregateResults.createdOrders.push(...importResult.results.createdOrders);
                aggregateResults.updatedOrders.push(...importResult.results.updatedOrders);
                aggregateResults.skippedOrders.push(...(importResult.results.skippedOrders || []));
                processedOrdersCount += shippedOrders.length;
                shippingOverdueUpdatedCount += importResult.results.updated;
                hooks?.onLog?.(`${shippedOrders.length} pedido(s) atrasado(s) retornaram ENVIADO na Tray; ${importResult.results.updated} atualizado(s) na plataforma.`);
            }
            hooks?.onLog?.(`Verificacao de envio atrasado concluida: ${shippingOverdueCheckedCount} consultado(s), ${shippingOverdueUpdatedCount} atualizado(s) para enviado.`);
        }
        if (processedOrdersCount === 0) {
            const emptyMessage = filters.revisitShippingOverdue === true
                ? `Nenhum pedido novo encontrado. ${shippingOverdueCheckedCount} envio(s) atrasado(s) verificado(s), sem novo status ENVIADO na Tray.`
                : 'Nenhum pedido novo ou sem NF encontrado na Tray com os filtros selecionados.';
            hooks?.onLog?.(emptyMessage);
            return {
                success: true,
                message: emptyMessage,
                storeId: auth.storeId,
                statuses: statusesToSync,
                modified,
                results: aggregateResults,
            };
        }
        const importMessage = `Importacao concluida: ${aggregateResults.created} criados, ${aggregateResults.updated} atualizados, ` +
            `${aggregateResults.skipped} ignorados, ${aggregateResults.totalTrackingEvents} evento(s) iniciais de rastreio, ` +
            `${revisitedOrdersCount} pedido(s) revisitado(s) por falta de NF/Chave NF, ` +
            `${shippingOverdueCheckedCount} envio(s) atrasado(s) verificado(s) e ${shippingOverdueUpdatedCount} atualizado(s) para enviado.`;
        hooks?.onLog?.(importMessage);
        return {
            success: true,
            message: importMessage,
            storeId: auth.storeId,
            statuses: statusesToSync,
            modified,
            results: aggregateResults,
        };
    }
}
exports.TraySyncService = TraySyncService;
exports.traySyncService = new TraySyncService();
