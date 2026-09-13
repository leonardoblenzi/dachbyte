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
  isArchived: boolean;
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
const AFTER_ORDER_NUMBER = String(process.env.AFTER_ORDER_NUMBER || '').trim();
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

const listPendingOrders = async (companyId: string) => {
  const result = await dbQuery<OrderRow>(
    `
      SELECT
        o."id",
        o."orderNumber",
        o."status",
        o."isArchived",
        o."invoiceAccessKey"
      FROM "Order" o
      WHERE o."companyId" = $1
        AND o."status" = 'PENDING'::"OrderStatus"
        AND o."isArchived" = FALSE
        AND COALESCE(o."orderNumber", '') <> ''
        AND (
          UPPER(COALESCE(o."salesChannel", '')) LIKE '%ANYMARKET%'
          OR UPPER(COALESCE(o."apiRawPayload"->>'source', '')) = 'ANYMARKET'
        )
        AND ($2::text = '' OR o."orderNumber" > $2)
      ORDER BY o."orderNumber" ASC
      LIMIT CASE WHEN $3::int > 0 THEN $3::int ELSE NULL END
      OFFSET CASE WHEN $4::int > 0 THEN $4::int ELSE 0 END
    `,
    [companyId, AFTER_ORDER_NUMBER, LIMIT, OFFSET],
  );

  return result.rows;
};

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

async function main() {
  const company = await resolveCompany();

  if (!company) {
    console.log(`Empresa nao encontrada para o filtro: ${TARGET_COMPANY_NAME}`);
    return;
  }

  if (company.anymarketIntegrationEnabled === false || !normalizeText(company.anymarketToken)) {
    console.log(
      `Empresa ${company.name} sem integracao AnyMarket ativa/token salvo. Operacao cancelada.`,
    );
    return;
  }

  if (
    company.intelipostIntegrationEnabled === false ||
    !normalizeText(company.intelipostApiKey)
  ) {
    console.log(
      `Empresa ${company.name} sem Intelipost ativa/api-key salva. Operacao cancelada.`,
    );
    return;
  }

  const orders = await listPendingOrders(company.id);
  const anymarketApi = new AnymarketApiService(company.id);
  const trackingService = new TrackingService();

  console.log(`Empresa alvo: ${company.name} (${company.id})`);
  console.log(`Modo: ${APPLY_CHANGES ? 'APLICAR ALTERACOES' : 'SIMULACAO (dry-run)'}`);
  console.log(
    `Arquivados: NAO | Ignorar excecoes transportadora: ${IGNORE_CARRIER_EXCEPTIONS ? 'SIM' : 'NAO'}`,
  );
  console.log(
    `Limite/offset: ${LIMIT > 0 ? LIMIT : 'sem limite'} / ${OFFSET > 0 ? OFFSET : 0}`,
  );
  if (AFTER_ORDER_NUMBER) {
    console.log(`Cursor AFTER_ORDER_NUMBER: ${AFTER_ORDER_NUMBER}`);
  }
  console.log(`Pedidos pendentes alvo: ${orders.length}`);

  let analyzed = 0;
  let anymarketFound = 0;
  let imported = 0;
  let xmlFilled = 0;
  let readyForIntelipostByXml = 0;
  let syncRequested = 0;
  let syncSuccess = 0;
  let anymarketNotFound = 0;
  let skippedNoXml = 0;
  let errors = 0;

  for (let index = 0; index < orders.length; index += 1) {
    const order = orders[index];
    const progress = `${index + 1}/${orders.length}`;
    const orderNumber = normalizeText(order.orderNumber);

    analyzed += 1;

    try {
      const anymarketOrder = await fetchAnymarketOrderByIdentifiers(
        anymarketApi,
        orderNumber,
      );

      if (!anymarketOrder) {
        anymarketNotFound += 1;
        console.log(`  [${progress}] ${orderNumber}: nao encontrado na AnyMarket.`);
        continue;
      }

      anymarketFound += 1;
      const mappedOrder = anymarketApi.mapAnymarketOrderToSystem(anymarketOrder);
      const hadLocalXmlBefore = Boolean(normalizeInvoiceAccessKey(order.invoiceAccessKey));

      if (!mappedOrder.invoiceAccessKey) {
        const anymarketOrderId = normalizeText(anymarketOrder?.id);
        if (anymarketOrderId) {
          const xmlLookup = await anymarketApi.getOrderNfeXmlAccessKey(anymarketOrderId);
          if (xmlLookup.accessKey) {
            mappedOrder.invoiceAccessKey = xmlLookup.accessKey;
            mappedOrder.invoiceXmlUrl =
              mappedOrder.invoiceXmlUrl ||
              `https://api.anymarket.com.br/v2${xmlLookup.endpoint}`;
          }
        }
      }

      const hasXmlAfterLookup = Boolean(normalizeInvoiceAccessKey(mappedOrder.invoiceAccessKey));
      if (!hadLocalXmlBefore && hasXmlAfterLookup) {
        xmlFilled += 1;
      }

      if (!APPLY_CHANGES) {
        console.log(
          `  [${progress}] ${orderNumber}: statusAny=${normalizeText(anymarketOrder?.status) || '-'} chaveNF=${hasXmlAfterLookup ? 'SIM' : 'NAO'}`,
        );
        if (hasXmlAfterLookup) {
          readyForIntelipostByXml += 1;
        } else {
          skippedNoXml += 1;
        }
        continue;
      }

      const importResult = await importOrdersForCompany(company.id, [mappedOrder], {
        ignoreCarrierExceptions: IGNORE_CARRIER_EXCEPTIONS,
      });
      imported += importResult.results.created + importResult.results.updated;

      if (!hasXmlAfterLookup) {
        skippedNoXml += 1;
        console.log(
          `  [${progress}] ${orderNumber}: importado sem chave XML, sync Intelipost por XML ignorado.`,
        );
        continue;
      }

      readyForIntelipostByXml += 1;
      syncRequested += 1;
      const syncResult = await trackingService.syncOrder(order.id, company.id, {
        forceFinalized: true,
      });

      if (syncResult.success) {
        syncSuccess += 1;
        console.log(
          `  [${progress}] ${orderNumber}: importado + sync Intelipost XML OK.`,
        );
      } else {
        console.log(
          `  [${progress}] ${orderNumber}: importado + sync Intelipost XML sem sucesso (${syncResult.message}).`,
        );
      }
    } catch (error) {
      errors += 1;
      console.log(`  [${progress}] ${orderNumber}: erro=${formatError(error)}`);
    }
  }

  console.log('\n===== Resumo =====');
  console.log(`Pedidos pendentes analisados: ${analyzed}`);
  console.log(`Encontrados na AnyMarket: ${anymarketFound}`);
  console.log(`Nao encontrados na AnyMarket: ${anymarketNotFound}`);
  console.log(`Pedidos criados/atualizados no import: ${imported}`);
  console.log(`Chave XML preenchida no processo: ${xmlFilled}`);
  console.log(`Pedidos aptos para Intelipost por XML: ${readyForIntelipostByXml}`);
  console.log(`Sync Intelipost XML solicitado: ${syncRequested}`);
  console.log(`Sync Intelipost XML com sucesso: ${syncSuccess}`);
  console.log(`Ignorados no sync por falta de XML: ${skippedNoXml}`);
  console.log(`Erros: ${errors}`);

  if (!APPLY_CHANGES) {
    console.log(
      '\nDry-run finalizado. Para aplicar alteracoes, execute novamente com APPLY_CHANGES=true.',
    );
  }
}

main().catch((error) => {
  console.error(
    'Falha no script MPOZENATO pendentes + AnyMarket XML + Intelipost XML:',
    formatError(error),
  );
  process.exitCode = 1;
});
