import type {
  TraySyncOrderReport,
  TraySyncSkippedOrderReport,
} from '../types/syncReport';
import { dbQuery } from '../lib/db';
import { isDemoCompany } from './demoCompanyService';
import { AnymarketApiService } from './anymarketApiService';
import {
  integrationOrderStatusService,
  normalizeAnymarketStatusValue,
} from './integrationOrderStatusService';
import { importOrdersForCompany } from './orderImportService';
import { shouldSkipPlatformOrderImport } from '../utils/orderExclusion';
import { SyncCancellationError } from '../utils/syncCancellation';
import { refreshInvoiceXmlRevisitState } from './integrationInvoiceXmlRevisitService';

const VALID_DAY_OPTIONS = [120, 90, 60, 30, 15, 7, 2] as const;
const ANYMARKET_FALLBACK_STATUSES = [
  'PENDING',
  'DELIVERY_ISSUE',
  'PAID_WAITING_SHIP',
  'INVOICED',
  'PAID_WAITING_DELIVERY',
  'CONCLUDED',
  'CANCELED',
] as const;
const DIRECT_REVISIT_BATCH_SIZE = 20;
const DIRECT_REVISIT_MAX_ORDERS = 200;

export interface AnymarketSyncFiltersInput {
  days?: number;
  statusMode?: 'selected' | 'all_except_canceled';
  statuses?: string[];
  marketplace?: string;
  includeCreatedAndUpdated?: boolean;
}

interface AnymarketSyncHooks {
  onStart?: (data: { total: number }) => void;
  onStatusStart?: (data: { status: string; index: number; total: number }) => void;
  onStatusFinish?: (data: {
    status: string;
    index: number;
    total: number;
    imported: number;
  }) => void;
  onLog?: (message: string) => void;
  shouldCancel?: () => boolean;
}

const normalizeRequestedStatuses = (value: unknown) => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((status) => normalizeAnymarketStatusValue(status))
    .filter(Boolean);
};

const normalizeText = (value: unknown) => String(value || '').trim();

const fetchAnymarketOrderByIdentifiers = async (
  api: AnymarketApiService,
  orderNumber: string,
) => {
  const attempts: Array<Record<string, string>> = [
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

export const resolveAnymarketQueryWindows = (
  days: number,
  includeCreatedAndUpdated = false,
) => {
  const now = new Date();
  const start = new Date(now);
  start.setDate(now.getDate() - days);

  const createdWindow = {
    windowType: 'created' as const,
    createdAfter: start.toISOString(),
    createdBefore: now.toISOString(),
    updatedAfter: undefined,
    updatedBefore: undefined,
  };
  const updatedWindow = {
    windowType: 'updated' as const,
    createdAfter: undefined,
    createdBefore: undefined,
    updatedAfter: start.toISOString(),
    updatedBefore: now.toISOString(),
  };

  if (includeCreatedAndUpdated) {
    return [createdWindow, updatedWindow];
  }

  return [days <= 7 ? updatedWindow : createdWindow];
};

export class AnymarketSyncService {
  async executeSync(
    companyId: string,
    filters: AnymarketSyncFiltersInput,
    hooks?: AnymarketSyncHooks,
  ) {
    const companyResult = await dbQuery<any>(
      `
        SELECT
          c."name",
          c."cnpj",
          c."documentNumber",
          c."anymarketIntegrationEnabled",
          c."integrationCarrierExceptions"
        FROM "Company" c
        WHERE c."id" = $1
        LIMIT 1
      `,
      [companyId],
    );
    const company = companyResult.rows[0] || null;

    if (isDemoCompany(company)) {
      throw new Error(
        'Sincronizacao da Integradora desabilitada para empresa demonstrativa.',
      );
    }

    if (company?.anymarketIntegrationEnabled === false) {
      throw new Error('A integracao ANYMARKET esta desativada para esta empresa.');
    }

    const selectedDays = Number(filters.days);
    const days = VALID_DAY_OPTIONS.includes(
      selectedDays as (typeof VALID_DAY_OPTIONS)[number],
    )
      ? selectedDays
      : 7;
    const queryWindows = resolveAnymarketQueryWindows(
      days,
      filters.includeCreatedAndUpdated === true,
    );
    const statusMode =
      filters.statusMode === 'selected' ? 'selected' : 'all_except_canceled';
    const requestedStatuses = normalizeRequestedStatuses(filters.statuses);
    const availableStatuses =
      await integrationOrderStatusService.getOrderImportStatuses(companyId);
    const cancelStatuses = availableStatuses.cancelStatusValues.map((value) =>
      normalizeAnymarketStatusValue(value),
    );
    const statusesToSync =
      statusMode === 'selected'
        ? requestedStatuses
        : (availableStatuses.integration === 'anymarket'
            ? availableStatuses.statuses
                .map((status) => normalizeAnymarketStatusValue(status.value))
                .filter((status) => status && !cancelStatuses.includes(status))
            : ANYMARKET_FALLBACK_STATUSES.filter(
                (status) => !cancelStatuses.includes(status),
              ));

    if (statusMode === 'selected' && statusesToSync.length === 0) {
      throw new Error('Selecione ao menos um status do ANYMARKET para sincronizar.');
    }

    const storedOrdersResult = await dbQuery<any>(
      `
        SELECT
          o."id",
          o."orderNumber",
          o."invoiceNumber",
          o."invoiceAccessKey",
          o."invoiceXmlRevisitState",
          o."freightType"
        FROM "Order" o
        WHERE o."companyId" = $1
      `,
      [companyId],
    );
    const storedOrders = storedOrdersResult.rows;
    const ordersToRemoveByCarrierException = storedOrders.filter((order) =>
      shouldSkipPlatformOrderImport({
        freightType: order.freightType,
        carrierExceptions: company?.integrationCarrierExceptions,
      }),
    );

    if (ordersToRemoveByCarrierException.length > 0) {
      await dbQuery(
        `
          DELETE FROM "Order"
          WHERE "id" = ANY($1::text[])
        `,
        [ordersToRemoveByCarrierException.map((order) => String(order.id))],
      );
      hooks?.onLog?.(
        `${ordersToRemoveByCarrierException.length} pedido(s) existente(s) foram removidos por baterem com a excecao de transportadora antes do sync ANYMARKET.`,
      );
    }
    const removedOrderIds = new Set(
      ordersToRemoveByCarrierException.map((order) => String(order.id)),
    );
    const eligibleStoredOrders = storedOrders.filter(
      (order) => !removedOrderIds.has(String(order.id)),
    );

    const anymarketApi = new AnymarketApiService(companyId);
    const aggregateResults = {
      created: 0,
      updated: 0,
      skipped: 0,
      totalTrackingEvents: 0,
      errors: [] as string[],
      createdOrders: [] as TraySyncOrderReport[],
      updatedOrders: [] as TraySyncOrderReport[],
      skippedOrders: [] as TraySyncSkippedOrderReport[],
    };
    let processedOrdersCount = 0;
    let revisitedOrdersCount = 0;
    const importedAnymarketOrderIds = new Set<string>();
    const syncStages = statusesToSync.flatMap((status) =>
      queryWindows.map((queryWindow) => ({ status, queryWindow })),
    );
    const existingOrderNumbers = new Set<string>(
      eligibleStoredOrders
        .map((order) => normalizeText(order.orderNumber))
        .filter(Boolean),
    );
    const revisitStateAtStart = await refreshInvoiceXmlRevisitState(
      companyId,
      Array.from(existingOrderNumbers),
    );
    const pendingInvoiceXmlOrderNumbers =
      revisitStateAtStart.pendingOrderNumbers;

    hooks?.onStart?.({ total: syncStages.length });
    hooks?.onLog?.(
      `Sincronizacao ANYMARKET iniciada com janela de ${days} dias, ${queryWindows.length} consulta(s) por status e ${statusesToSync.length} status.`,
    );

    for (let index = 0; index < syncStages.length; index += 1) {
      if (hooks?.shouldCancel?.()) {
        throw new SyncCancellationError();
      }

      const { status: anymarketStatus, queryWindow } = syncStages[index];
      const stageLabel = `${anymarketStatus} (${queryWindow.windowType === 'created' ? 'novos' : 'alterados'})`;

      hooks?.onStatusStart?.({
        status: stageLabel,
        index: index + 1,
        total: syncStages.length,
      });
      hooks?.onLog?.(
        `Buscando pedidos ANYMARKET ${queryWindow.windowType === 'created' ? 'novos' : 'alterados'} com status "${anymarketStatus}".`,
      );

      const importedOrdersCount = await anymarketApi.syncAllOrders(
        {
          status: anymarketStatus,
          marketplace:
            typeof filters.marketplace === 'string' && filters.marketplace.trim()
              ? filters.marketplace.trim()
              : undefined,
          createdAfter: queryWindow.createdAfter,
          createdBefore: queryWindow.createdBefore,
          updatedAfter: queryWindow.updatedAfter,
          updatedBefore: queryWindow.updatedBefore,
        },
        {
          onLog: hooks?.onLog,
          shouldCancel: hooks?.shouldCancel,
          onOrdersBatch: async (batchOrders) => {
            if (hooks?.shouldCancel?.()) {
              throw new SyncCancellationError();
            }

            const uniqueBatchOrders = batchOrders.filter((order) => {
              const anymarketOrderId = normalizeText(order?.id);
              if (!anymarketOrderId) return true;
              if (importedAnymarketOrderIds.has(anymarketOrderId)) return false;
              importedAnymarketOrderIds.add(anymarketOrderId);
              return true;
            });

            if (uniqueBatchOrders.length === 0) {
              return;
            }

            const mappedOrders = await Promise.all(
              uniqueBatchOrders.map(async (order) => {
                const mappedOrder = anymarketApi.mapAnymarketOrderToSystem(order);
                const anymarketOrderId = normalizeText(order?.id);

                if (!mappedOrder.invoiceAccessKey && anymarketOrderId) {
                  const xmlLookup = await anymarketApi.getOrderNfeXmlAccessKey(
                    anymarketOrderId,
                  );
                  if (xmlLookup.accessKey) {
                    mappedOrder.invoiceAccessKey = xmlLookup.accessKey;
                    mappedOrder.invoiceXmlUrl =
                      mappedOrder.invoiceXmlUrl ||
                      `https://api.anymarket.com.br/v2${xmlLookup.endpoint}`;
                    mappedOrder.apiRawPayload = {
                      ...(mappedOrder.apiRawPayload || {}),
                      anymarketInvoiceXmlLookup: {
                        orderId: anymarketOrderId,
                        endpoint: xmlLookup.endpoint,
                        fetchedAt: new Date().toISOString(),
                        accessKey: xmlLookup.accessKey,
                      },
                    };
                  }
                }

                return mappedOrder;
              }),
            );
            const importResult = await importOrdersForCompany(companyId, mappedOrders);

            aggregateResults.created += importResult.results.created;
            aggregateResults.updated += importResult.results.updated;
            aggregateResults.skipped += importResult.results.skipped;
            aggregateResults.totalTrackingEvents +=
              importResult.results.totalTrackingEvents;
            aggregateResults.errors.push(...importResult.results.errors);
            aggregateResults.createdOrders.push(
              ...importResult.results.createdOrders,
            );
            aggregateResults.updatedOrders.push(
              ...importResult.results.updatedOrders,
            );
            aggregateResults.skippedOrders.push(
              ...(importResult.results.skippedOrders || []),
            );
            processedOrdersCount += uniqueBatchOrders.length;

            const processedOrderNumbers = mappedOrders
              .map((mapped) => normalizeText(mapped?.orderNumber))
              .filter(Boolean);
            if (processedOrderNumbers.length > 0) {
              const refreshedRevisitState = await refreshInvoiceXmlRevisitState(
                companyId,
                processedOrderNumbers,
              );

              for (const orderNumber of processedOrderNumbers) {
                existingOrderNumbers.add(orderNumber);
                if (refreshedRevisitState.pendingOrderNumbers.has(orderNumber)) {
                  pendingInvoiceXmlOrderNumbers.add(orderNumber);
                } else {
                  pendingInvoiceXmlOrderNumbers.delete(orderNumber);
                }
              }
            }

            hooks?.onLog?.(
              `Lote ANYMARKET importado: ${importResult.results.created} criado(s), ${importResult.results.updated} atualizado(s), ${importResult.results.skipped} ignorado(s).`,
            );
          },
        },
      );

      hooks?.onStatusFinish?.({
        status: stageLabel,
        index: index + 1,
        total: syncStages.length,
        imported: importedOrdersCount,
      });
      hooks?.onLog?.(
        `Etapa "${stageLabel}" finalizada com ${importedOrdersCount} pedido(s) consultado(s) no ANYMARKET.`,
      );
    }

    const pendingRevisitOrderNumbers = Array.from(pendingInvoiceXmlOrderNumbers).slice(
      0,
      DIRECT_REVISIT_MAX_ORDERS,
    );

    if (pendingRevisitOrderNumbers.length > 0) {
      hooks?.onLog?.(
        `Revisita ANYMARKET iniciada para ${pendingRevisitOrderNumbers.length} pedido(s) sem NF/Chave NF.`,
      );

      for (
        let batchStart = 0;
        batchStart < pendingRevisitOrderNumbers.length;
        batchStart += DIRECT_REVISIT_BATCH_SIZE
      ) {
        if (hooks?.shouldCancel?.()) {
          throw new SyncCancellationError();
        }

        const batchOrderNumbers = pendingRevisitOrderNumbers.slice(
          batchStart,
          batchStart + DIRECT_REVISIT_BATCH_SIZE,
        );
        const revisitedPayloads: any[] = [];

        for (const orderNumber of batchOrderNumbers) {
          const anymarketOrder = await fetchAnymarketOrderByIdentifiers(
            anymarketApi,
            orderNumber,
          );
          if (!anymarketOrder) {
            continue;
          }

          const mappedOrder = anymarketApi.mapAnymarketOrderToSystem(anymarketOrder);
          const anymarketOrderId = normalizeText(anymarketOrder?.id);

          if (!mappedOrder.invoiceAccessKey && anymarketOrderId) {
            const xmlLookup = await anymarketApi.getOrderNfeXmlAccessKey(anymarketOrderId);
            if (xmlLookup.accessKey) {
              mappedOrder.invoiceAccessKey = xmlLookup.accessKey;
              mappedOrder.invoiceXmlUrl =
                mappedOrder.invoiceXmlUrl ||
                `https://api.anymarket.com.br/v2${xmlLookup.endpoint}`;
            }
          }

          revisitedPayloads.push(mappedOrder);
        }

        if (revisitedPayloads.length === 0) {
          continue;
        }

        const importResult = await importOrdersForCompany(companyId, revisitedPayloads);
        aggregateResults.created += importResult.results.created;
        aggregateResults.updated += importResult.results.updated;
        aggregateResults.skipped += importResult.results.skipped;
        aggregateResults.totalTrackingEvents += importResult.results.totalTrackingEvents;
        aggregateResults.errors.push(...importResult.results.errors);
        aggregateResults.createdOrders.push(...importResult.results.createdOrders);
        aggregateResults.updatedOrders.push(...importResult.results.updatedOrders);
        aggregateResults.skippedOrders.push(...(importResult.results.skippedOrders || []));
        processedOrdersCount += revisitedPayloads.length;
        revisitedOrdersCount += revisitedPayloads.length;

        const refreshedRevisitState = await refreshInvoiceXmlRevisitState(
          companyId,
          revisitedPayloads
            .map((payload) => normalizeText(payload?.orderNumber))
            .filter(Boolean),
        );
        for (const orderNumber of batchOrderNumbers) {
          if (refreshedRevisitState.pendingOrderNumbers.has(orderNumber)) {
            pendingInvoiceXmlOrderNumbers.add(orderNumber);
          } else {
            pendingInvoiceXmlOrderNumbers.delete(orderNumber);
          }
        }
      }
    }

    if (processedOrdersCount === 0) {
      hooks?.onLog?.(
        'Nenhum pedido ANYMARKET encontrado para importacao com os filtros selecionados.',
      );

      return {
        success: true,
        message:
          'Nenhum pedido ANYMARKET encontrado para importacao com os filtros selecionados.',
        statuses: statusesToSync,
        windowType: queryWindows.length > 1 ? 'created_and_updated' : queryWindows[0].windowType,
        range: {
          createdAfter: queryWindows.find((window) => window.windowType === 'created')?.createdAfter || null,
          createdBefore: queryWindows.find((window) => window.windowType === 'created')?.createdBefore || null,
          updatedAfter: queryWindows.find((window) => window.windowType === 'updated')?.updatedAfter || null,
          updatedBefore: queryWindows.find((window) => window.windowType === 'updated')?.updatedBefore || null,
        },
        results: {
          created: 0,
          updated: 0,
          skipped: 0,
          totalTrackingEvents: 0,
          errors: [],
          createdOrders: [],
          updatedOrders: [],
          skippedOrders: [],
        },
      };
    }

    const importMessage =
      `Importacao ANYMARKET concluida: ${aggregateResults.created} criados, ${aggregateResults.updated} atualizados, ` +
      `${aggregateResults.skipped} ignorados, ${aggregateResults.totalTrackingEvents} evento(s) iniciais de rastreio, ${revisitedOrdersCount} revisitado(s) por falta de NF/Chave NF.`;
    hooks?.onLog?.(importMessage);

    return {
      success: true,
      message: importMessage,
      statuses: statusesToSync,
      windowType: queryWindows.length > 1 ? 'created_and_updated' : queryWindows[0].windowType,
      range: {
        createdAfter: queryWindows.find((window) => window.windowType === 'created')?.createdAfter || null,
        createdBefore: queryWindows.find((window) => window.windowType === 'created')?.createdBefore || null,
        updatedAfter: queryWindows.find((window) => window.windowType === 'updated')?.updatedAfter || null,
        updatedBefore: queryWindows.find((window) => window.windowType === 'updated')?.updatedBefore || null,
      },
      results: aggregateResults,
    };
  }
}

export const anymarketSyncService = new AnymarketSyncService();
