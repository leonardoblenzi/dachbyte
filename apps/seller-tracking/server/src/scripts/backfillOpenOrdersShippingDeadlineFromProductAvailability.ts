import { dbQuery } from '../lib/db';
import { AnymarketApiService } from '../services/anymarketApiService';
import { TrayApiService } from '../services/trayApiService';
import {
  extractAnymarketProductReferences,
  extractTrayProductReferences,
  resolveOrderShippingAvailabilityFromAnymarket,
  resolveOrderShippingAvailabilityFromProductPayloads,
  resolveOrderShippingAvailabilityFromTray,
  type ShippingAvailabilityResolution,
} from '../services/orderShippingAvailabilityService';

const PAGE_SIZE = 150;

const APPLY_CHANGES =
  ['1', 'true', 'yes', 'sim'].includes(
    String(process.env.APPLY_CHANGES || '').trim().toLowerCase(),
  );
const VERBOSE =
  ['1', 'true', 'yes', 'sim'].includes(
    String(process.env.VERBOSE || '').trim().toLowerCase(),
  );

const COMPANY_ID = String(process.env.COMPANY_ID || '').trim() || null;
const COMPANY_NAME = String(process.env.COMPANY_NAME || '')
  .trim()
  .toUpperCase();

type CompanyRow = {
  id: string;
  name: string;
  anymarketIntegrationEnabled: boolean;
  trayIntegrationEnabled: boolean;
};

type OrderRow = {
  id: string;
  orderNumber: string;
  salesChannel: string | null;
  status: string | null;
  shippingDate: Date | null;
  createdAt: Date | null;
  maxShippingDeadline: Date | null;
  apiRawPayload: any;
};

const toSafeDate = (value: unknown) => {
  if (!value) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const toIsoDate = (value: Date | null) =>
  value ? value.toISOString().slice(0, 10) : null;

const normalizeSource = (order: OrderRow): 'ANYMARKET' | 'TRAY' | null => {
  const payloadSource = String(order.apiRawPayload?.source || '')
    .trim()
    .toUpperCase();
  if (payloadSource.includes('ANYMARKET')) return 'ANYMARKET';
  if (payloadSource.includes('TRAY')) return 'TRAY';

  const salesChannel = String(order.salesChannel || '')
    .trim()
    .toUpperCase();
  if (salesChannel.includes('ANYMARKET')) return 'ANYMARKET';
  if (salesChannel.startsWith('TRAY')) return 'TRAY';

  return null;
};

const mergePayload = (
  currentPayload: any,
  resolution: ShippingAvailabilityResolution,
) => {
  const basePayload =
    currentPayload && typeof currentPayload === 'object' && !Array.isArray(currentPayload)
      ? { ...currentPayload }
      : {};

  basePayload.shippingAvailability = {
    mode: resolution.mode,
    maxDays: resolution.maxDays,
    sendDate: resolution.sendDate ? resolution.sendDate.toISOString() : null,
    items: resolution.items,
    resolvedAt: new Date().toISOString(),
    resolvedBy: 'backfillOpenOrdersShippingDeadlineFromProductAvailability',
  };

  return basePayload;
};

const fetchCompanies = async () => {
  const result = await dbQuery<CompanyRow>(
    `
      SELECT
        c."id",
        c."name",
        c."anymarketIntegrationEnabled",
        c."trayIntegrationEnabled"
      FROM "Company" c
      WHERE ($1::text = '' OR c."id" = $1)
        AND ($2::text = '' OR UPPER(c."name") = $2)
      ORDER BY c."name" ASC
    `,
    [COMPANY_ID || '', COMPANY_NAME || ''],
  );

  return result.rows;
};

const listOrdersBatch = async (companyId: string, cursor: string) => {
  const result = await dbQuery<OrderRow>(
    `
      SELECT
        o."id",
        o."orderNumber",
        o."salesChannel",
        o."status",
        o."shippingDate",
        o."createdAt",
        o."maxShippingDeadline",
        o."apiRawPayload"
      FROM "Order" o
      WHERE o."companyId" = $1
        AND o."isArchived" = FALSE
        AND o."status" IN ('PENDING'::"OrderStatus", 'CREATED'::"OrderStatus")
        AND ($2::text = '' OR o."id" > $2)
      ORDER BY o."id" ASC
      LIMIT $3
    `,
    [companyId, cursor, PAGE_SIZE],
  );

  return result.rows;
};

const resolveAvailability = async ({
  source,
  order,
  anymarketApiService,
  trayApiService,
}: {
  source: 'ANYMARKET' | 'TRAY';
  order: OrderRow;
  anymarketApiService: AnymarketApiService | null;
  trayApiService: TrayApiService | null;
}) => {
  const payload = order.apiRawPayload || {};
  const baseDate = toSafeDate(order.shippingDate) || toSafeDate(order.createdAt) || new Date();

  let payloadForResolution = payload;
  let references =
    source === 'ANYMARKET'
      ? extractAnymarketProductReferences(payloadForResolution)
      : extractTrayProductReferences(payloadForResolution);

  // Em muitos pedidos Tray o payload salvo pode estar sobrescrito por payload de rastreio.
  // Nesses casos, buscamos o pedido completo na Tray para recuperar ProductsSold/OrderItems.
  if (source === 'TRAY' && references.length === 0 && trayApiService) {
    try {
      const completeOrder = await trayApiService.getOrderComplete(order.orderNumber);
      const trayOrderNode =
        completeOrder?.Order && typeof completeOrder.Order === 'object'
          ? completeOrder.Order
          : completeOrder;

      if (trayOrderNode && typeof trayOrderNode === 'object') {
        payloadForResolution = trayOrderNode;
        references = extractTrayProductReferences(payloadForResolution);
      }
    } catch {
      // segue com payload atual
    }
  }

  const productPayloads: Array<{
    productRef: string;
    payload: any;
    integration: 'ANYMARKET' | 'TRAY';
  }> = [];

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

  if (productPayloads.length > 0) {
    const fromProducts = resolveOrderShippingAvailabilityFromProductPayloads(
      productPayloads,
      baseDate,
    );
    if (fromProducts.maxDays !== null) {
      return fromProducts;
    }
  }

  return source === 'ANYMARKET'
    ? resolveOrderShippingAvailabilityFromAnymarket(payloadForResolution, baseDate)
    : resolveOrderShippingAvailabilityFromTray(payloadForResolution, baseDate);
};

const processCompany = async (company: CompanyRow) => {
  console.log(`\nEmpresa: ${company.name}`);

  const anymarketApiService =
    company.anymarketIntegrationEnabled !== false
      ? new AnymarketApiService(company.id)
      : null;
  const trayApiService =
    company.trayIntegrationEnabled !== false ? new TrayApiService(company.id) : null;

  let cursor = '';
  let scanned = 0;
  let eligible = 0;
  let resolved = 0;
  let updated = 0;
  let unchanged = 0;
  let failed = 0;
  let skippedNoSource = 0;

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
          skippedNoSource += 1;
          continue;
        }

        if (source === 'ANYMARKET' && !anymarketApiService) {
          continue;
        }

        if (source === 'TRAY' && !trayApiService) {
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
          await dbQuery(
            `
              UPDATE "Order" o
              SET
                "maxShippingDeadline" = $2,
                "apiRawPayload" = $3::jsonb,
                "lastUpdate" = NOW()
              WHERE o."id" = $1
            `,
            [order.id, resolution.sendDate, JSON.stringify(mergePayload(order.apiRawPayload, resolution))],
          );
        }

        updated += 1;
        if (VERBOSE) {
          console.log(
            `  ${order.orderNumber}: prazo envio ${currentDate || '-'} -> ${nextDate} (${source}, status ${order.status || 'N/A'})`,
          );
        }
      } catch (error) {
        failed += 1;
        console.error(
          `  Erro no pedido ${order.orderNumber}: ${
            error instanceof Error ? error.message : 'Erro desconhecido'
          }`,
        );
      }
    }
  }

  console.log(
    `Resumo ${company.name}: varridos=${scanned}, elegiveis=${eligible}, resolvidos=${resolved}, atualizados=${updated}, sem alteracao=${unchanged}, sem fonte=${skippedNoSource}, erros=${failed}`,
  );

  return { scanned, eligible, resolved, updated, unchanged, skippedNoSource, failed };
};

async function main() {
  console.log(
    `Backfill de prazo de envio (pedidos em aberto) iniciado (${APPLY_CHANGES ? 'APPLY' : 'DRY_RUN'})`,
  );

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
  let totalSkippedNoSource = 0;
  let totalFailed = 0;

  for (const company of companies) {
    const result = await processCompany(company);
    totalScanned += result.scanned;
    totalEligible += result.eligible;
    totalResolved += result.resolved;
    totalUpdated += result.updated;
    totalUnchanged += result.unchanged;
    totalSkippedNoSource += result.skippedNoSource;
    totalFailed += result.failed;
  }

  console.log('\nBackfill finalizado.');
  console.log(`Pedidos varridos: ${totalScanned}`);
  console.log(`Pedidos elegiveis: ${totalEligible}`);
  console.log(`Pedidos com prazo resolvido: ${totalResolved}`);
  console.log(`Pedidos atualizados: ${totalUpdated}`);
  console.log(`Pedidos sem alteracao: ${totalUnchanged}`);
  console.log(`Pedidos sem fonte ANYMARKET/TRAY: ${totalSkippedNoSource}`);
  console.log(`Pedidos com erro: ${totalFailed}`);
}

main().catch((error) => {
  console.error(
    'Falha no backfill de prazo de envio (pedidos em aberto):',
    error instanceof Error ? error.message : 'Erro desconhecido',
  );
  process.exitCode = 1;
});
