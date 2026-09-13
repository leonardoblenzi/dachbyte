import { dbQuery } from '../lib/db';
import { anymarketSyncService } from '../services/anymarketSyncService';

const TARGET_COMPANY_NAME = String(process.env.TARGET_COMPANY_NAME || 'MPOZENATO')
  .trim()
  .toUpperCase();
const DAYS = Number(process.env.DAYS || 120);

const formatError = (error: unknown) =>
  error instanceof Error ? error.message : 'Erro desconhecido';

async function main() {
  const companyResult = await dbQuery<{ id: string; name: string }>(
    `
      SELECT c."id", c."name"
      FROM "Company" c
      WHERE UPPER(c."name") = $1
      LIMIT 1
    `,
    [TARGET_COMPANY_NAME],
  );
  const company = companyResult.rows[0] || null;

  if (!company) {
    console.log(`Empresa nao encontrada: ${TARGET_COMPANY_NAME}`);
    return;
  }

  console.log(`Empresa: ${company.name} (${company.id})`);
  console.log(`Iniciando sync ANYMARKET com janela de ${DAYS} dias...`);

  const result = await anymarketSyncService.executeSync(
    company.id,
    {
      days: DAYS,
      statusMode: 'all_except_canceled',
    },
    {
      onStart: ({ total }) => {
        console.log(`Total de status na fila: ${total}`);
      },
      onStatusStart: ({ status, index, total }) => {
        console.log(`[${index}/${total}] Status ${status}...`);
      },
      onStatusFinish: ({ status, imported }) => {
        console.log(`  Status ${status} finalizado. Consultados: ${imported}`);
      },
      onLog: (message) => {
        console.log(`  ${message}`);
      },
    },
  );

  console.log('\nSync ANYMARKET finalizado.');
  console.log(result.message);
  console.log(
    `Resumo: criados=${result.results.created} atualizados=${result.results.updated} ignorados=${result.results.skipped} eventos=${result.results.totalTrackingEvents} erros=${result.results.errors.length}`,
  );
}

main().catch((error) => {
  console.error('Falha no sync ANYMARKET da empresa:', formatError(error));
  process.exitCode = 1;
});
