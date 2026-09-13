import type {
  TraySyncOrderReport,
  TraySyncSkippedOrderReport,
} from '../types/syncReport';
import { dbQuery } from '../lib/db';
import { isDemoCompany } from './demoCompanyService';
import { importOrdersForCompany } from './orderImportService';
import { SyncCancellationError } from '../utils/syncCancellation';
import { JetApiService } from './jetApiService';
import { refreshInvoiceXmlRevisitState } from './integrationInvoiceXmlRevisitService';

const VALID_DAY_OPTIONS = [120, 90, 60, 30, 15, 7, 2] as const;
const DEFAULT_REFRESH_LIMIT = 200;
const BATCH_SIZE = 20;

export interface JetSyncFiltersInput {
  days?: number;
  statusMode?: 'selected' | 'all_except_canceled';
  statuses?: string[];
}

interface JetSyncHooks {
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

const normalizeText = (value: unknown) => String(value || '').trim();
const normalizeDigits = (value: unknown) =>
  String(value || '')
    .replace(/\D/g, '')
    .trim();

const normalizeRequestedIds = (value: unknown) => {
  if (!Array.isArray(value)) {
    return [];
  }

  return Array.from(
    new Set(
      value
        .map((item) => normalizeDigits(item))
        .filter((item) => item.length > 0),
    ),
  );
};

const dedupe = (items: string[]) => Array.from(new Set(items));

export class JetSyncService {
  async executeSync(
    companyId: string,
    filters: JetSyncFiltersInput,
    hooks?: JetSyncHooks,
  ) {
    const companyResult = await dbQuery<any>(
      `
        SELECT
          c."name",
          c."cnpj",
          c."documentNumber",
          c."jetIntegrationEnabled",
          c."integrationManualStatuses"
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

    if (company?.jetIntegrationEnabled !== true) {
      throw new Error('A integracao JET esta desativada para esta empresa.');
    }

    const selectedDays = Number(filters.days);
    const days = VALID_DAY_OPTIONS.includes(
      selectedDays as (typeof VALID_DAY_OPTIONS)[number],
    )
      ? selectedDays
      : 7;
    const statusMode =
      filters.statusMode === 'selected' ? 'selected' : 'all_except_canceled';
    const requestedIds = normalizeRequestedIds(filters.statuses);
    const configuredManualIds = normalizeRequestedIds(
      Array.isArray(company?.integrationManualStatuses)
        ? company.integrationManualStatuses
        : [],
    );

    let idsToSync: string[] = [];

    if (statusMode === 'selected') {
      idsToSync = requestedIds;
      if (idsToSync.length === 0) {
        throw new Error(
          'Selecione ao menos um idOrder da JET para sincronizar. Dica: configure os idOrder em Configuracoes > Integracao > Status manuais da integradora.',
        );
      }
    } else {
      const refreshResult = await dbQuery<{
        orderNumber: string;
        apiRawPayload: any;
      }>(
        `
          SELECT
            o."orderNumber",
            o."apiRawPayload"
          FROM "Order" o
          WHERE o."companyId" = $1
            AND o."isArchived" = FALSE
            AND o."lastUpdate" >= NOW() - ($2::int * INTERVAL '1 day')
          ORDER BY o."lastUpdate" DESC
          LIMIT $3
        `,
        [companyId, days, DEFAULT_REFRESH_LIMIT],
      );

      const idsFromRecentOrders = refreshResult.rows
        .map((order) => {
          const payload = order.apiRawPayload || {};
          return (
            normalizeDigits(payload?.jetMeta?.idOrder) ||
            normalizeDigits(payload?.jetOrderId) ||
            normalizeDigits(order.orderNumber)
          );
        })
        .filter(Boolean);

      idsToSync = dedupe([...configuredManualIds, ...idsFromRecentOrders]).slice(
        0,
        DEFAULT_REFRESH_LIMIT,
      );
    }

    if (idsToSync.length === 0) {
      hooks?.onLog?.(
        'Nenhum idOrder da JET foi encontrado para sincronizar nesta empresa.',
      );

      return {
        success: true,
        message:
          'Nenhum idOrder da JET foi encontrado para sincronizacao com os filtros atuais.',
        statuses: [],
        windowType: 'ids_manual_or_recent',
        range: {
          createdAfter: null,
          createdBefore: null,
          updatedAfter: null,
          updatedBefore: null,
        },
        results: {
          created: 0,
          updated: 0,
          skipped: 0,
          totalTrackingEvents: 0,
          errors: [],
          createdOrders: [] as TraySyncOrderReport[],
          updatedOrders: [] as TraySyncOrderReport[],
          skippedOrders: [] as TraySyncSkippedOrderReport[],
        },
      };
    }

    const jetApi = new JetApiService(companyId);
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

    hooks?.onStart?.({ total: idsToSync.length });
    hooks?.onLog?.(
      `Sincronizacao JET iniciada com ${idsToSync.length} idOrder(s) para consulta.`,
    );

    const mappedOrdersBatch: any[] = [];

    for (let index = 0; index < idsToSync.length; index += 1) {
      if (hooks?.shouldCancel?.()) {
        throw new SyncCancellationError();
      }

      const idOrder = idsToSync[index];

      hooks?.onStatusStart?.({
        status: idOrder,
        index: index + 1,
        total: idsToSync.length,
      });
      hooks?.onLog?.(`Consultando pedido idOrder ${idOrder} na JET.`);

      try {
        const jetOrder = await jetApi.getOrderById(idOrder);
        const mappedOrder = jetApi.mapJetOrderToSystem(jetOrder);
        mappedOrdersBatch.push(mappedOrder);
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : `Falha ao consultar idOrder ${idOrder} na JET.`;
        aggregateResults.errors.push(message);
        aggregateResults.skipped += 1;
        hooks?.onLog?.(message);
      }

      if (
        mappedOrdersBatch.length >= BATCH_SIZE ||
        index === idsToSync.length - 1
      ) {
        if (mappedOrdersBatch.length > 0) {
          const importResult = await importOrdersForCompany(
            companyId,
            mappedOrdersBatch.splice(0, mappedOrdersBatch.length),
          );

          aggregateResults.created += importResult.results.created;
          aggregateResults.updated += importResult.results.updated;
          aggregateResults.skipped += importResult.results.skipped;
          aggregateResults.totalTrackingEvents +=
            importResult.results.totalTrackingEvents;
          aggregateResults.errors.push(...importResult.results.errors);
          aggregateResults.createdOrders.push(...importResult.results.createdOrders);
          aggregateResults.updatedOrders.push(...importResult.results.updatedOrders);
          aggregateResults.skippedOrders.push(
            ...(importResult.results.skippedOrders || []),
          );
          processedOrdersCount +=
            importResult.results.created + importResult.results.updated;

          const refreshedRevisitState = await refreshInvoiceXmlRevisitState(
            companyId,
            importResult.results.updatedOrders
              .concat(importResult.results.createdOrders)
              .map((order) => normalizeText(order.orderNumber))
              .filter(Boolean),
          );
          for (const pendingOrderNumber of refreshedRevisitState.pendingOrderNumbers) {
            pendingRevisitOrderNumbers.add(pendingOrderNumber);
          }
        }
      }

      hooks?.onStatusFinish?.({
        status: idOrder,
        index: index + 1,
        total: idsToSync.length,
        imported: 1,
      });
    }

    if (processedOrdersCount === 0) {
      hooks?.onLog?.(
        'Nenhum pedido da JET foi importado para a empresa com os filtros atuais.',
      );

      return {
        success: true,
        message:
          'Nenhum pedido da JET foi importado para a empresa com os filtros atuais.',
        statuses: idsToSync,
        windowType: 'ids_manual_or_recent',
        range: {
          createdAfter: null,
          createdBefore: null,
          updatedAfter: null,
          updatedBefore: null,
        },
        results: aggregateResults,
      };
    }

    const importMessage =
      `Importacao JET concluida: ${aggregateResults.created} criados, ${aggregateResults.updated} atualizados, ` +
      `${aggregateResults.skipped} ignorados, ${aggregateResults.totalTrackingEvents} evento(s) iniciais de rastreio, ${pendingRevisitOrderNumbers.size} pendente(s) sem NF/Chave NF.`;
    hooks?.onLog?.(importMessage);

    return {
      success: true,
      message: importMessage,
      statuses: idsToSync,
      windowType: 'ids_manual_or_recent',
      range: {
        createdAfter: null,
        createdBefore: null,
        updatedAfter: null,
        updatedBefore: null,
      },
      results: aggregateResults,
    };
  }
}

export const jetSyncService = new JetSyncService();
