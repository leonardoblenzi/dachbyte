import { dbQuery } from '../lib/db';
import { AnymarketApiService } from '../services/anymarketApiService';
import { importOrdersForCompany } from '../services/orderImportService';
import { TrackingService } from '../services/trackingService';

type CompanyRow = {
  id: string;
  name: string;
  anymarketIntegrationEnabled: boolean;
  anymarketToken: string | null;
  intelipostIntegrationEnabled: boolean;
  intelipostApiKey: string | null;
};

type OrderRow = {
  id: string;
  orderNumber: string;
  status: string;
  invoiceAccessKey: string | null;
};

const TARGET_COMPANY_NAME = String(process.env.TARGET_COMPANY_NAME || 'MPOZENATO')
  .trim()
  .toUpperCase();
const APPLY_CHANGES =
  ['1', 'true', 'yes', 'sim'].includes(
    String(process.env.APPLY_CHANGES || '').trim().toLowerCase(),
  );
const LIMIT = Number(process.env.BATCH_LIMIT || 0);
const OFFSET = Number(process.env.BATCH_OFFSET || 0);
const IGNORE_CARRIER_EXCEPTIONS =
  ['1', 'true', 'yes', 'sim'].includes(
    String(process.env.IGNORE_CARRIER_EXCEPTIONS || 'true').trim().toLowerCase(),
  );

const normalizeText = (value: unknown) => String(value || '').trim();
const normalizeInvoiceAccessKey = (value: unknown) =>
  String(value || '')
    .replace(/[^A-Za-z0-9]/g, '')
    .toUpperCase()
    .trim();
const formatError = (error: unknown) =>
  error instanceof Error ? error.message : 'Erro desconhecido';

const resolveCompany = async () => {
  const result = await dbQuery<CompanyRow>(
    `
      SELECT
        c."id",
        c."name",
        c."anymarketIntegrationEnabled",
        c."anymarketToken",
        c."intelipostIntegrationEnabled",
        c."intelipostApiKey"
      FROM "Company" c
      WHERE UPPER(c."name") = $1
      LIMIT 1
    `,
    [TARGET_COMPANY_NAME],
  );

  return result.rows[0] || null;
};

const listOrdersWithoutXml = async (companyId: string) => {
  const result = await dbQuery<OrderRow>(
    `
      SELECT
        o."id",
        o."orderNumber",
        o."status",
        o."invoiceAccessKey"
      FROM "Order" o
      WHERE o."companyId" = $1
        AND o."isArchived" = FALSE
        AND o."status" <> 'DELIVERED'::"OrderStatus"
        AND COALESCE(o."invoiceAccessKey", '') = ''
        AND COALESCE(o."orderNumber", '') <> ''
        AND (
          UPPER(COALESCE(o."salesChannel", '')) LIKE '%ANYMARKET%'
          OR UPPER(COALESCE(o."apiRawPayload"->>'source', '')) = 'ANYMARKET'
        )
      ORDER BY o."orderNumber" ASC
      LIMIT CASE WHEN $2::int > 0 THEN $2::int ELSE NULL END
      OFFSET CASE WHEN $3::int > 0 THEN $3::int ELSE 0 END
    `,
    [companyId, LIMIT, OFFSET],
  );

  return result.rows;
};

const fetchOrderByCompanyAndNumber = async (companyId: string, orderNumber: string) => {
  const result = await dbQuery<OrderRow>(
    `
      SELECT
        o."id",
        o."orderNumber",
        o."status",
        o."invoiceAccessKey"
      FROM "Order" o
      WHERE o."companyId" = $1
        AND o."orderNumber" = $2
      ORDER BY o."createdAt" DESC
      LIMIT 1
    `,
    [companyId, orderNumber],
  );

  return result.rows[0] || null;
};

const fetchAnymarketOrderByIdentifiers = async (
  api: AnymarketApiService,
  orderNumber: string,
) => {
  const normalizedDigits = String(orderNumber || '').replace(/\D/g, '').trim();
  if (normalizedDigits) {
    const directOrder = await api.getOrderById(normalizedDigits);
    if (directOrder) {
      return directOrder;
    }
  }

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

async function main() {
  const company = await resolveCompany();
  if (!company) {
    console.log(`Empresa nao encontrada para o filtro: ${TARGET_COMPANY_NAME}`);
    return;
  }

  if (company.anymarketIntegrationEnabled === false || !normalizeText(company.anymarketToken)) {
    console.log(`Empresa ${company.name} sem token/integ AnyMarket ativa.`);
    return;
  }

  if (
    company.intelipostIntegrationEnabled === false ||
    !normalizeText(company.intelipostApiKey)
  ) {
    console.log(`Empresa ${company.name} sem token/integ Intelipost ativa.`);
    return;
  }

  const api = new AnymarketApiService(company.id);
  const trackingService = new TrackingService();
  const targetOrders = await listOrdersWithoutXml(company.id);

  console.log(`Empresa: ${company.name} (${company.id})`);
  console.log(`Modo: ${APPLY_CHANGES ? 'APLICAR ALTERACOES' : 'SIMULACAO (dry-run)'}`);
  console.log(`Filtros: sem XML, nao arquivado, nao entregue, origem AnyMarket`);
  console.log(`Limit/offset: ${LIMIT > 0 ? LIMIT : 'sem limite'} / ${OFFSET > 0 ? OFFSET : 0}`);
  console.log(`Pedidos alvo: ${targetOrders.length}`);

  let foundInAny = 0;
  let notFoundInAny = 0;
  let xmlResolved = 0;
  let stillWithoutXml = 0;
  let imported = 0;
  let syncRequested = 0;
  let syncSuccess = 0;
  let syncFailed = 0;
  let errors = 0;

  for (let index = 0; index < targetOrders.length; index += 1) {
    const target = targetOrders[index];
    const progress = `${index + 1}/${targetOrders.length}`;
    const orderNumber = normalizeText(target.orderNumber);

    try {
      const anyOrder = await fetchAnymarketOrderByIdentifiers(api, orderNumber);

      if (!anyOrder) {
        notFoundInAny += 1;
        console.log(`  [${progress}] ${orderNumber}: nao encontrado na AnyMarket`);
        continue;
      }

      foundInAny += 1;
      const mapped = api.mapAnymarketOrderToSystem(anyOrder);
      if (!mapped.invoiceAccessKey) {
        const anyOrderId = normalizeText(anyOrder?.id);
        if (anyOrderId) {
          const xmlLookup = await api.getOrderNfeXmlAccessKey(anyOrderId);
          if (xmlLookup.accessKey) {
            mapped.invoiceAccessKey = xmlLookup.accessKey;
            mapped.invoiceXmlUrl =
              mapped.invoiceXmlUrl ||
              `https://api.anymarket.com.br/v2${xmlLookup.endpoint}`;
          }
        }
      }

      const hasXmlNow = Boolean(normalizeInvoiceAccessKey(mapped.invoiceAccessKey));
      if (hasXmlNow) {
        xmlResolved += 1;
      } else {
        stillWithoutXml += 1;
      }

      if (!APPLY_CHANGES) {
        console.log(
          `  [${progress}] ${orderNumber}: statusAny=${normalizeText(anyOrder?.status) || '-'} chaveNF=${hasXmlNow ? 'SIM' : 'NAO'}`,
        );
        continue;
      }

      const importResult = await importOrdersForCompany(company.id, [mapped], {
        ignoreCarrierExceptions: IGNORE_CARRIER_EXCEPTIONS,
      });
      imported += importResult.results.created + importResult.results.updated;

      if (!hasXmlNow) {
        console.log(`  [${progress}] ${orderNumber}: sem XML apos revisita, sync ignorado`);
        continue;
      }

      const refreshedOrder = await fetchOrderByCompanyAndNumber(company.id, orderNumber);
      if (!refreshedOrder) {
        syncFailed += 1;
        console.log(`  [${progress}] ${orderNumber}: pedido nao localizado apos import`);
        continue;
      }

      const refreshedKey = normalizeInvoiceAccessKey(refreshedOrder.invoiceAccessKey);
      if (!refreshedKey) {
        syncFailed += 1;
        console.log(`  [${progress}] ${orderNumber}: XML nao persistiu no banco`);
        continue;
      }

      syncRequested += 1;
      const syncResult = await trackingService.syncOrder(refreshedOrder.id, company.id, {
        forceFinalized: true,
      });
      if (syncResult.success) {
        syncSuccess += 1;
        console.log(`  [${progress}] ${orderNumber}: sync Intelipost OK`);
      } else {
        syncFailed += 1;
        console.log(
          `  [${progress}] ${orderNumber}: sync Intelipost falhou (${syncResult.message})`,
        );
      }
    } catch (error) {
      errors += 1;
      console.log(`  [${progress}] ${orderNumber}: erro=${formatError(error)}`);
    }
  }

  console.log('\n===== Resumo =====');
  console.log(`Pedidos alvo: ${targetOrders.length}`);
  console.log(`Encontrados na AnyMarket: ${foundInAny}`);
  console.log(`Nao encontrados na AnyMarket: ${notFoundInAny}`);
  console.log(`XML resolvido via payload/endpoint: ${xmlResolved}`);
  console.log(`Ainda sem XML: ${stillWithoutXml}`);
  console.log(`Pedidos importados/atualizados: ${imported}`);
  console.log(`Sync Intelipost solicitado: ${syncRequested}`);
  console.log(`Sync Intelipost sucesso: ${syncSuccess}`);
  console.log(`Sync Intelipost falha: ${syncFailed}`);
  console.log(`Erros: ${errors}`);

  if (!APPLY_CHANGES) {
    console.log('\nDry-run finalizado. Para aplicar, rode com APPLY_CHANGES=true.');
  }
}

main().catch((error) => {
  console.error(
    'Falha no script de revisita MPOZENATO sem XML + sync Intelipost:',
    formatError(error),
  );
  process.exitCode = 1;
});

