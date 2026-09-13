import { dbQuery } from '../lib/db';
import { AnymarketApiService } from '../services/anymarketApiService';
import { importOrdersForCompany } from '../services/orderImportService';

type CompanyRow = {
  id: string;
  name: string;
  anymarketIntegrationEnabled: boolean;
  anymarketToken: string | null;
};

type OrderRow = {
  id: string;
  orderNumber: string;
  status: string;
  isArchived: boolean;
  salesChannel: string | null;
  invoiceNumber: string | null;
  invoiceAccessKey: string | null;
  revisitReason: 'PENDING_STATUS' | 'MISSING_XML_ACTIVE' | 'OTHER';
};

const APPLY_CHANGES =
  ['1', 'true', 'yes', 'sim'].includes(
    String(process.env.APPLY_CHANGES || '').trim().toLowerCase(),
  );
const INCLUDE_ARCHIVED =
  ['1', 'true', 'yes', 'sim'].includes(
    String(process.env.INCLUDE_ARCHIVED || '').trim().toLowerCase(),
  );
const IGNORE_CARRIER_EXCEPTIONS =
  ['1', 'true', 'yes', 'sim'].includes(
    String(process.env.IGNORE_CARRIER_EXCEPTIONS || 'true').trim().toLowerCase(),
  );
const COMPANY_ID = String(process.env.COMPANY_ID || '').trim();
const COMPANY_NAME = String(process.env.COMPANY_NAME || '')
  .trim()
  .toUpperCase();
const LIMIT_PER_COMPANY = Number(process.env.LIMIT_PER_COMPANY || 0);
const OFFSET_PER_COMPANY = Number(process.env.OFFSET_PER_COMPANY || 0);

const normalizeText = (value: unknown) => String(value || '').trim();
const formatError = (error: unknown) =>
  error instanceof Error ? error.message : 'Erro desconhecido';

const fetchCompanies = async () => {
  const result = await dbQuery<CompanyRow>(
    `
      SELECT
        c."id",
        c."name",
        c."anymarketIntegrationEnabled",
        c."anymarketToken"
      FROM "Company" c
      WHERE ($1::text = '' OR c."id" = $1)
        AND ($2::text = '' OR UPPER(c."name") = $2)
        AND c."anymarketIntegrationEnabled" = TRUE
        AND COALESCE(c."anymarketToken", '') <> ''
      ORDER BY c."name" ASC
    `,
    [COMPANY_ID, COMPANY_NAME],
  );

  return result.rows;
};

const listTargetOrders = async (companyId: string) => {
  const result = await dbQuery<OrderRow>(
    `
      SELECT
        o."id",
        o."orderNumber",
        o."status",
        o."isArchived",
        o."salesChannel",
        o."invoiceNumber",
        o."invoiceAccessKey",
        CASE
          WHEN o."status" = 'PENDING'::"OrderStatus" THEN 'PENDING_STATUS'
          WHEN COALESCE(o."invoiceAccessKey", '') = '' THEN 'MISSING_XML_ACTIVE'
          ELSE 'OTHER'
        END AS "revisitReason"
      FROM "Order" o
      WHERE o."companyId" = $1
        AND (
          o."status" = 'PENDING'::"OrderStatus"
          OR (
            COALESCE(o."invoiceAccessKey", '') = ''
            AND o."isArchived" = FALSE
            AND o."status" <> 'DELIVERED'::"OrderStatus"
          )
        )
        AND (
          o."status" <> 'PENDING'::"OrderStatus"
          OR ($2::boolean = TRUE OR o."isArchived" = FALSE)
        )
        AND COALESCE(o."orderNumber", '') <> ''
        AND (
          UPPER(COALESCE(o."salesChannel", '')) LIKE '%ANYMARKET%'
          OR UPPER(COALESCE(o."apiRawPayload"->>'source', '')) = 'ANYMARKET'
        )
      ORDER BY o."orderNumber" ASC
      LIMIT CASE WHEN $3::int > 0 THEN $3::int ELSE NULL END
      OFFSET CASE WHEN $4::int > 0 THEN $4::int ELSE 0 END
    `,
    [companyId, INCLUDE_ARCHIVED, LIMIT_PER_COMPANY, OFFSET_PER_COMPANY],
  );

  return result.rows;
};

const fetchAnymarketOrderByIdentifiers = async (
  api: AnymarketApiService,
  orderNumber: string,
) => {
  const normalizedDigits = String(orderNumber || '').replace(/\D/g, '').trim();
  if (normalizedDigits) {
    const directOrderResponse = await api.getOrderById(normalizedDigits);
    if (directOrderResponse) {
      return directOrderResponse;
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
  const companies = await fetchCompanies();

  if (companies.length === 0) {
    console.log('Nenhuma empresa com AnyMarket habilitada e token configurado foi encontrada.');
    return;
  }

  console.log(`Empresas alvo: ${companies.length}`);
  console.log(`Modo: ${APPLY_CHANGES ? 'APLICAR ALTERACOES' : 'SIMULACAO (dry-run)'}`);
  console.log(
    `Incluir arquivados: ${INCLUDE_ARCHIVED ? 'SIM' : 'NAO'} | Ignorar excecoes de transportadora: ${IGNORE_CARRIER_EXCEPTIONS ? 'SIM' : 'NAO'}`,
  );
  console.log(
    `Limit/offset por empresa: ${LIMIT_PER_COMPANY > 0 ? LIMIT_PER_COMPANY : 'sem limite'} / ${OFFSET_PER_COMPANY > 0 ? OFFSET_PER_COMPANY : 0}`,
  );

  let totalOrders = 0;
  let totalFoundOnAny = 0;
  let totalImported = 0;
  let totalCreated = 0;
  let totalUpdated = 0;
  let totalSkipped = 0;
  let totalNotFound = 0;
  let totalXmlFilled = 0;
  let totalErrors = 0;

  for (const company of companies) {
    const api = new AnymarketApiService(company.id);
    const targetOrders = await listTargetOrders(company.id);

    console.log(`\nEmpresa: ${company.name} (${company.id})`);
    const companyPendingCount = targetOrders.filter(
      (row) => row.revisitReason === 'PENDING_STATUS',
    ).length;
    const companyMissingXmlActiveCount = targetOrders.filter(
      (row) => row.revisitReason === 'MISSING_XML_ACTIVE',
    ).length;
    console.log(
      `Pedidos alvo no banco: ${targetOrders.length} (PENDENTE=${companyPendingCount}, sem XML ativo=${companyMissingXmlActiveCount})`,
    );

    let companyFoundOnAny = 0;
    let companyImported = 0;
    let companyCreated = 0;
    let companyUpdated = 0;
    let companySkipped = 0;
    let companyNotFound = 0;
    let companyXmlFilled = 0;
    let companyErrors = 0;

    for (let index = 0; index < targetOrders.length; index += 1) {
      const order = targetOrders[index];
      const orderNumber = normalizeText(order.orderNumber);
      const progress = `${index + 1}/${targetOrders.length}`;
      const reasonLabel =
        order.revisitReason === 'MISSING_XML_ACTIVE'
          ? 'SEM_XML_ATIVO'
          : order.revisitReason === 'PENDING_STATUS'
            ? 'PENDENTE'
            : 'OUTRO';

      try {
        const anymarketOrder = await fetchAnymarketOrderByIdentifiers(api, orderNumber);

        if (!anymarketOrder) {
          companyNotFound += 1;
          console.log(
            `  [${progress}] ${orderNumber} [${reasonLabel}]: nao encontrado na AnyMarket`,
          );
          continue;
        }

        companyFoundOnAny += 1;
        const mapped = api.mapAnymarketOrderToSystem(anymarketOrder);

        if (!mapped.invoiceAccessKey) {
          const anymarketOrderId = normalizeText(anymarketOrder?.id);
          if (anymarketOrderId) {
            const xmlLookup = await api.getOrderNfeXmlAccessKey(anymarketOrderId);
            if (xmlLookup.accessKey) {
              mapped.invoiceAccessKey = xmlLookup.accessKey;
              mapped.invoiceXmlUrl =
                mapped.invoiceXmlUrl ||
                `https://api.anymarket.com.br/v2${xmlLookup.endpoint}`;
              companyXmlFilled += 1;
            }
          }
        }

        if (!APPLY_CHANGES) {
          console.log(
            `  [${progress}] ${orderNumber} [${reasonLabel}]: status atual any=${normalizeText(anymarketOrder?.status) || '-'} | chaveNF=${mapped.invoiceAccessKey ? 'SIM' : 'NAO'}`,
          );
          continue;
        }

        const importResult = await importOrdersForCompany(company.id, [mapped], {
          ignoreCarrierExceptions: IGNORE_CARRIER_EXCEPTIONS,
        });

        const importedNow =
          importResult.results.created +
          importResult.results.updated +
          importResult.results.skipped;
        companyImported += importedNow;
        companyCreated += importResult.results.created;
        companyUpdated += importResult.results.updated;
        companySkipped += importResult.results.skipped;

        console.log(
          `  [${progress}] ${orderNumber} [${reasonLabel}]: criado=${importResult.results.created} atualizado=${importResult.results.updated} ignorado=${importResult.results.skipped}`,
        );
      } catch (error) {
        companyErrors += 1;
        console.log(
          `  [${progress}] ${orderNumber} [${reasonLabel}]: erro=${formatError(error)}`,
        );
      }
    }

    totalOrders += targetOrders.length;
    totalFoundOnAny += companyFoundOnAny;
    totalImported += companyImported;
    totalCreated += companyCreated;
    totalUpdated += companyUpdated;
    totalSkipped += companySkipped;
    totalNotFound += companyNotFound;
    totalXmlFilled += companyXmlFilled;
    totalErrors += companyErrors;

    console.log(
      `Resumo ${company.name}: encontradosAny=${companyFoundOnAny}, importados=${companyImported}, criados=${companyCreated}, atualizados=${companyUpdated}, ignorados=${companySkipped}, naoEncontrados=${companyNotFound}, xmlPreenchido=${companyXmlFilled}, erros=${companyErrors}`,
    );
  }

  console.log('\n===== Resumo Geral =====');
  console.log(`Pedidos alvo varridos: ${totalOrders}`);
  console.log(`Pedidos encontrados na AnyMarket: ${totalFoundOnAny}`);
  console.log(`Pedidos importados (criado + atualizado + ignorado): ${totalImported}`);
  console.log(`Criados: ${totalCreated}`);
  console.log(`Atualizados: ${totalUpdated}`);
  console.log(`Ignorados: ${totalSkipped}`);
  console.log(`Nao encontrados na AnyMarket: ${totalNotFound}`);
  console.log(`Chave XML preenchida via endpoint NFe: ${totalXmlFilled}`);
  console.log(`Erros: ${totalErrors}`);

  if (!APPLY_CHANGES) {
    console.log(
      '\nDry-run finalizado. Para aplicar alteracoes, execute novamente com APPLY_CHANGES=true.',
    );
  }
}

main().catch((error) => {
  console.error(
    'Falha no script de revisita AnyMarket para pedidos PENDENTE:',
    formatError(error),
  );
  process.exitCode = 1;
});
