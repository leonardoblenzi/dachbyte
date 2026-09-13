import { dbQuery } from '../lib/db';
import { AnymarketApiService } from '../services/anymarketApiService';
import { importOrdersForCompany } from '../services/orderImportService';

const TARGET_COMPANY_NAME = String(process.env.TARGET_COMPANY_NAME || 'MPOZENATO')
  .trim()
  .toUpperCase();

const formatError = (error: unknown) =>
  error instanceof Error ? error.message : 'Erro desconhecido';

const resolveCompany = async () => {
  const result = await dbQuery<{ id: string; name: string }>(
    `
      SELECT c."id", c."name"
      FROM "Company" c
      WHERE UPPER(c."name") = $1
      LIMIT 1
    `,
    [TARGET_COMPANY_NAME],
  );

  return result.rows[0] || null;
};

const listTargetOrderNumbers = async (companyId: string) => {
  const result = await dbQuery<{ orderNumber: string }>(
    `
      SELECT o."orderNumber"
      FROM "Order" o
      JOIN LATERAL (
        SELECT
          te."status",
          te."description"
        FROM "TrackingEvent" te
        WHERE te."orderId" = o."id"
        ORDER BY te."eventDate" DESC
        LIMIT 1
      ) latest ON TRUE
      WHERE o."companyId" = $1
        AND o."isArchived" = FALSE
        AND UPPER(COALESCE(o."salesChannel", '')) LIKE '%ANYMARKET%'
        AND (
          latest."status" = 'UNKNOWN'
          OR UPPER(COALESCE(latest."description", '')) LIKE 'RASTREAMENTO ANYMARKET: UNKNOWN.%'
        )
      ORDER BY o."orderNumber" ASC
    `,
    [companyId],
  );

  return result.rows.map((row) => String(row.orderNumber || '').trim()).filter(Boolean);
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

  console.log(`Empresa alvo: ${company.name} (${company.id})`);
  const orderNumbers = await listTargetOrderNumbers(company.id);

  if (orderNumbers.length === 0) {
    console.log('Nenhum pedido com ultimo rastreio ANYMARKET UNKNOWN encontrado.');
    return;
  }

  console.log(`Pedidos alvo: ${orderNumbers.length}`);
  const api = new AnymarketApiService(company.id);

  let processed = 0;
  let notFound = 0;
  let errors = 0;
  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const orderNumber of orderNumbers) {
    try {
      console.log(`\n[${processed + notFound + errors + 1}/${orderNumbers.length}] Reprocessando ${orderNumber}...`);
      const anymarketOrder = await fetchAnymarketOrderByIdentifiers(api, orderNumber);

      if (!anymarketOrder) {
        notFound += 1;
        console.log(`  NAO ENCONTRADO no ANYMARKET para ${orderNumber}.`);
        continue;
      }

      const mapped = api.mapAnymarketOrderToSystem(anymarketOrder);
      const importResult = await importOrdersForCompany(company.id, [mapped]);
      created += importResult.results.created;
      updated += importResult.results.updated;
      skipped += importResult.results.skipped;
      processed += 1;

      console.log(
        `  OK ${orderNumber}: criado=${importResult.results.created} atualizado=${importResult.results.updated} ignorado=${importResult.results.skipped}`,
      );
    } catch (error) {
      errors += 1;
      console.log(`  ERRO ${orderNumber}: ${formatError(error)}`);
    }
  }

  console.log('\nReprocessamento finalizado.');
  console.log(`Processados com retorno ANYMARKET: ${processed}`);
  console.log(`Nao encontrados no ANYMARKET: ${notFound}`);
  console.log(`Erros: ${errors}`);
  console.log(`Criados: ${created}`);
  console.log(`Atualizados: ${updated}`);
  console.log(`Ignorados: ${skipped}`);
}

main().catch((error) => {
  console.error('Falha no script de reprocessamento ANYMARKET UNKNOWN:', formatError(error));
  process.exitCode = 1;
});
