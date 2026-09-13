import { dbPool, dbQuery } from '../lib/db';
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

type CompanyRow = {
  id: string;
  name: string;
  anymarketIntegrationEnabled: boolean;
  trayIntegrationEnabled: boolean;
};

type OrderRow = {
  id: string;
  orderNumber: string;
  status: string | null;
  salesChannel: string | null;
  shippingDate: Date | null;
  createdAt: Date | null;
  maxShippingDeadline: Date | null;
  apiRawPayload: any;
};

type SourceType = 'ANYMARKET' | 'TRAY' | null;

const toSafeDate = (value: unknown) => {
  if (!value) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const toIso = (value: Date | null) => (value ? value.toISOString().slice(0, 19).replace('T', ' ') : null);

const normalizeSource = (order: OrderRow): SourceType => {
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

const findCompanyByNameLike = async (nameLike: string) => {
  const result = await dbQuery<CompanyRow>(
    `
      SELECT
        c."id",
        c."name",
        c."anymarketIntegrationEnabled",
        c."trayIntegrationEnabled"
      FROM "Company" c
      WHERE UPPER(c."name") LIKE $1
      ORDER BY c."name" ASC
      LIMIT 1
    `,
    [`%${nameLike.toUpperCase()}%`],
  );

  return result.rows[0] || null;
};

const listCandidateOrders = async (companyId: string) => {
  const result = await dbQuery<OrderRow>(
    `
      SELECT
        o."id",
        o."orderNumber",
        o."status",
        o."salesChannel",
        o."shippingDate",
        o."createdAt",
        o."maxShippingDeadline",
        o."apiRawPayload"
      FROM "Order" o
      WHERE o."companyId" = $1
        AND o."isArchived" = FALSE
        AND o."status" IN ('PENDING'::"OrderStatus", 'CREATED'::"OrderStatus")
      ORDER BY o."lastUpdate" DESC
      LIMIT 80
    `,
    [companyId],
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

  let resolution: ShippingAvailabilityResolution | null = null;
  let origin: 'products-api' | 'order-payload' | 'none' = 'none';

  if (productPayloads.length > 0) {
    const fromProducts = resolveOrderShippingAvailabilityFromProductPayloads(
      productPayloads,
      baseDate,
    );
    if (fromProducts.maxDays !== null) {
      resolution = fromProducts;
      origin = 'products-api';
    }
  }

  if (!resolution) {
    const fromPayload =
      source === 'ANYMARKET'
        ? resolveOrderShippingAvailabilityFromAnymarket(payloadForResolution, baseDate)
        : resolveOrderShippingAvailabilityFromTray(payloadForResolution, baseDate);
    if (fromPayload.maxDays !== null) {
      resolution = fromPayload;
      origin = 'order-payload';
    }
  }

  return {
    resolution,
    origin,
    referencesCount: references.length,
    productsFound: productPayloads.length,
    baseDate,
  };
};

const testCompany = async (nameLike: string) => {
  const company = await findCompanyByNameLike(nameLike);
  if (!company) {
    console.log(`Empresa com nome contendo "${nameLike}" nao encontrada.`);
    return;
  }

  const anymarketApiService =
    company.anymarketIntegrationEnabled !== false
      ? new AnymarketApiService(company.id)
      : null;
  const trayApiService =
    company.trayIntegrationEnabled !== false ? new TrayApiService(company.id) : null;

  const candidates = await listCandidateOrders(company.id);
  const samples = candidates
    .map((order) => ({ order, source: normalizeSource(order) }))
    .filter((item) => item.source === 'ANYMARKET' || item.source === 'TRAY')
    .slice(0, 3);

  console.log(`\nEmpresa: ${company.name}`);
  if (samples.length === 0) {
    console.log('Nenhum pedido em aberto com fonte ANYMARKET/TRAY encontrado para amostra.');
    return;
  }

  for (const sample of samples) {
    const source = sample.source as 'ANYMARKET' | 'TRAY';
    const order = sample.order;

    try {
      const result = await resolveAvailability({
        source,
        order,
        anymarketApiService,
        trayApiService,
      });

      const currentDeadline = toIso(toSafeDate(order.maxShippingDeadline));
      const suggestedDeadline = toIso(result.resolution?.sendDate || null);
      const maxDays = result.resolution?.maxDays ?? null;
      const mode = result.resolution?.mode ?? null;

      console.log(
        [
          `Pedido ${order.orderNumber}`,
          `Status ${order.status || 'N/A'}`,
          `Fonte ${source}`,
          `Base ${toIso(result.baseDate) || '-'}`,
          `Atual ${currentDeadline || '-'}`,
          `Sugerido ${suggestedDeadline || '-'}`,
          `Dias ${maxDays === null ? '-' : maxDays}`,
          `Modo ${mode || '-'}`,
          `Origem calc ${result.origin}`,
          `Refs ${result.referencesCount}`,
          `Produtos encontrados ${result.productsFound}`,
        ].join(' | '),
      );
    } catch (error) {
      console.log(
        `Pedido ${order.orderNumber} | Fonte ${source} | Erro ${
          error instanceof Error ? error.message : 'Erro desconhecido'
        }`,
      );
    }
  }
};

async function main() {
  console.log('Teste de amostra de prazo de envio por produto (sem escrita em banco).');
  await testCompany('DROSSI');
  await testCompany('MPOZENATO');
}

main()
  .catch((error) => {
    console.error(
      'Falha no teste de amostra:',
      error instanceof Error ? error.message : 'Erro desconhecido',
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    // encerra o pool do pg para finalizar o processo
    try {
      await dbPool.end();
    } catch {
      // noop
    }
  });
