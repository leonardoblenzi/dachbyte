import type {
  TraySyncOrderReport,
  TraySyncSkippedOrderReport,
} from '../types/syncReport';
import { dbQuery } from '../lib/db';
import { isDemoCompany } from './demoCompanyService';
import { MagazordApiService } from './magazordApiService';
import { integrationOrderStatusService } from './integrationOrderStatusService';
import { importOrdersForCompany } from './orderImportService';
import { shouldSkipPlatformOrderImport } from '../utils/orderExclusion';
import { SyncCancellationError } from '../utils/syncCancellation';
import { refreshInvoiceXmlRevisitState } from './integrationInvoiceXmlRevisitService';

const VALID_DAY_OPTIONS = [120, 90, 60, 30, 15, 7, 2] as const;
const MAGAZORD_FALLBACK_STATUSES = [
  '1',
  '3',
  '4',
  '5',
  '6',
  '7',
  '8',
  '12',
  '15',
  '16',
  '17',
  '18',
  '19',
  '23',
  '25',
  '30',
  '31',
] as const;

export interface MagazordSyncFiltersInput {
  days?: number;
  statusMode?: 'selected' | 'all_except_canceled';
  statuses?: string[];
}

interface MagazordSyncHooks {
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
    .map((status) => String(status || '').trim())
    .filter(Boolean);
};

const resolveQueryWindow = (days: number) => {
  const now = new Date();
  const start = new Date(now);
  start.setDate(now.getDate() - days);

  if (days <= 7) {
    return {
      windowType: 'updated' as const,
      createdAfter: undefined,
      createdBefore: undefined,
      updatedAfter: start.toISOString(),
      updatedBefore: now.toISOString(),
    };
  }

  return {
    windowType: 'created' as const,
    createdAfter: start.toISOString(),
    createdBefore: now.toISOString(),
    updatedAfter: undefined,
    updatedBefore: undefined,
  };
};

const dedupeStatuses = (statuses: string[]) => Array.from(new Set(statuses));
const normalizeText = (value: unknown) => String(value || '').trim();

export class MagazordSyncService {
  async executeSync(
    companyId: string,
    filters: MagazordSyncFiltersInput,
    hooks?: MagazordSyncHooks,
  ) {
    const companyResult = await dbQuery<any>(
      `
        SELECT
          c."name",
          c."cnpj",
          c."documentNumber",
          c."magazordIntegrationEnabled",
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

    if (company?.magazordIntegrationEnabled === false) {
      throw new Error('A integracao Magazord esta desativada para esta empresa.');
    }

    const selectedDays = Number(filters.days);
    const days = VALID_DAY_OPTIONS.includes(
      selectedDays as (typeof VALID_DAY_OPTIONS)[number],
    )
      ? selectedDays
      : 7;
    const queryWindow = resolveQueryWindow(days);
    const statusMode =
      filters.statusMode === 'selected' ? 'selected' : 'all_except_canceled';
    const requestedStatuses = normalizeRequestedStatuses(filters.statuses);
    const availableStatuses =
      await integrationOrderStatusService.getOrderImportStatuses(companyId);
    const cancelStatuses = availableStatuses.cancelStatusValues.map((value) =>
      String(value || '').trim(),
    );
    const statusesToSync = dedupeStatuses(
      statusMode === 'selected'
        ? requestedStatuses
        : (availableStatuses.integration === 'magazord'
            ? availableStatuses.statuses
                .map((status) => String(status.value || '').trim())
                .filter((status) => status && !cancelStatuses.includes(status))
            : MAGAZORD_FALLBACK_STATUSES.filter(
                (status) => !cancelStatuses.includes(status),
              )),
    );

    if (statusMode === 'selected' && statusesToSync.length === 0) {
      throw new Error('Selecione ao menos um status da Magazord para sincronizar.');
    }

    const storedOrdersResult = await dbQuery<any>(
      `
        SELECT
          o."id",
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
        `${ordersToRemoveByCarrierException.length} pedido(s) existente(s) foram removidos por baterem com a excecao de transportadora antes do sync Magazord.`,
      );
    }

    const magazordApi = new MagazordApiService(companyId);
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
    const pendingRevisitOrderNumbers = new Set<string>();

    hooks?.onStart?.({ total: statusesToSync.length });
    hooks?.onLog?.(
      `Sincronizacao Magazord iniciada com janela de ${days} dias baseada em ${queryWindow.windowType} e ${statusesToSync.length} status.`,
    );

    for (let index = 0; index < statusesToSync.length; index += 1) {
      if (hooks?.shouldCancel?.()) {
        throw new SyncCancellationError();
      }

      const magazordStatus = statusesToSync[index];

      hooks?.onStatusStart?.({
        status: magazordStatus,
        index: index + 1,
        total: statusesToSync.length,
      });
      hooks?.onLog?.(`Buscando pedidos Magazord com situacao "${magazordStatus}".`);

      const importedOrdersCount = await magazordApi.syncAllOrders(
        {
          situacao: magazordStatus,
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

            const mappedOrders = batchOrders.map((order) =>
              magazordApi.mapMagazordOrderToSystem(order),
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
            processedOrdersCount += batchOrders.length;
            const refreshedRevisitState = await refreshInvoiceXmlRevisitState(
              companyId,
              mappedOrders
                .map((order) => normalizeText(order?.orderNumber))
                .filter(Boolean),
            );
            for (const pendingOrderNumber of refreshedRevisitState.pendingOrderNumbers) {
              pendingRevisitOrderNumbers.add(pendingOrderNumber);
            }

            hooks?.onLog?.(
              `Lote Magazord importado: ${importResult.results.created} criado(s), ${importResult.results.updated} atualizado(s), ${importResult.results.skipped} ignorado(s).`,
            );
          },
        },
      );

      hooks?.onStatusFinish?.({
        status: magazordStatus,
        index: index + 1,
        total: statusesToSync.length,
        imported: importedOrdersCount,
      });
      hooks?.onLog?.(
        `Situacao "${magazordStatus}" finalizada com ${importedOrdersCount} pedido(s) consultado(s) na Magazord.`,
      );
    }

    if (processedOrdersCount === 0) {
      hooks?.onLog?.(
        'Nenhum pedido Magazord encontrado para importacao com os filtros selecionados.',
      );

      return {
        success: true,
        message:
          'Nenhum pedido Magazord encontrado para importacao com os filtros selecionados.',
        statuses: statusesToSync,
        windowType: queryWindow.windowType,
        range: {
          createdAfter: queryWindow.createdAfter || null,
          createdBefore: queryWindow.createdBefore || null,
          updatedAfter: queryWindow.updatedAfter || null,
          updatedBefore: queryWindow.updatedBefore || null,
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
      `Importacao Magazord concluida: ${aggregateResults.created} criados, ${aggregateResults.updated} atualizados, ` +
      `${aggregateResults.skipped} ignorados, ${aggregateResults.totalTrackingEvents} evento(s) iniciais de rastreio, ${pendingRevisitOrderNumbers.size} pendente(s) sem NF/Chave NF.`;
    hooks?.onLog?.(importMessage);

    return {
      success: true,
      message: importMessage,
      statuses: statusesToSync,
      windowType: queryWindow.windowType,
      range: {
        createdAfter: queryWindow.createdAfter || null,
        createdBefore: queryWindow.createdBefore || null,
        updatedAfter: queryWindow.updatedAfter || null,
        updatedBefore: queryWindow.updatedBefore || null,
      },
      results: aggregateResults,
    };
  }
}

export const magazordSyncService = new MagazordSyncService();
