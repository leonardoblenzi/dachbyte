import { PoolClient } from 'pg';
import { dbPool } from '../lib/db';

type CompanyScopedTable = {
  tableName: string;
  columns: string[];
};

type DeletionPreview = {
  company: { id: string; name: string; cnpj: string | null };
  users: number;
  userAccessTokens: number;
  orders: number;
  trackingEvents: number;
  companyScoped: Array<{ tableName: string; count: number }>;
};

const quoteIdentifier = (identifier: string) => `"${identifier.replace(/"/g, '""')}"`;

const getArgument = (name: string) => {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length).trim();
};

const listCompanyScopedTables = async (client: PoolClient): Promise<CompanyScopedTable[]> => {
  const result = await client.query<CompanyScopedTable>(`
    SELECT
      table_name AS "tableName",
      array_agg(column_name ORDER BY column_name) AS "columns"
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND column_name IN ('companyId', 'companyIdValue')
    GROUP BY table_name
    ORDER BY table_name
  `);

  return result.rows.filter(
    ({ tableName }) => !['Company', 'Order', 'User'].includes(tableName),
  );
};

const countCompanyScopedRows = async (
  client: PoolClient,
  table: CompanyScopedTable,
  companyId: string,
) => {
  const condition = table.columns
    .map((column, index) => `${quoteIdentifier(column)} = $${index + 1}`)
    .join(' OR ');
  const result = await client.query<{ count: string }>(
    `SELECT COUNT(*)::text AS "count" FROM ${quoteIdentifier(table.tableName)} WHERE ${condition}`,
    table.columns.map(() => companyId),
  );
  return Number(result.rows[0]?.count || 0);
};

const deleteCompanyScopedRows = async (
  client: PoolClient,
  table: CompanyScopedTable,
  companyId: string,
) => {
  const condition = table.columns
    .map((column, index) => `${quoteIdentifier(column)} = $${index + 1}`)
    .join(' OR ');
  await client.query(
    `DELETE FROM ${quoteIdentifier(table.tableName)} WHERE ${condition}`,
    table.columns.map(() => companyId),
  );
};

const buildPreview = async (client: PoolClient, companyName: string): Promise<DeletionPreview> => {
  const companies = await client.query<{ id: string; name: string; cnpj: string | null }>(
    `
      SELECT "id", "name", "cnpj"
      FROM "Company"
      WHERE lower(trim("name")) = lower(trim($1))
    `,
    [companyName],
  );

  if (companies.rows.length !== 1) {
    throw new Error(
      companies.rows.length === 0
        ? `Nenhuma empresa encontrada com o nome exato "${companyName}".`
        : `Foram encontradas ${companies.rows.length} empresas com o nome "${companyName}". A exclusao foi cancelada.`,
    );
  }

  const company = companies.rows[0];
  const [users, userAccessTokens, orders, trackingEvents, companyScopedTables] = await Promise.all([
    client.query<{ count: string }>(
      'SELECT COUNT(*)::text AS "count" FROM "User" WHERE "companyId" = $1',
      [company.id],
    ),
    client.query<{ count: string }>(
      `
        SELECT COUNT(*)::text AS "count"
        FROM "UserAccessToken" token
        JOIN "User" users ON users."id" = token."userId"
        WHERE users."companyId" = $1
      `,
      [company.id],
    ),
    client.query<{ count: string }>(
      'SELECT COUNT(*)::text AS "count" FROM "Order" WHERE "companyId" = $1',
      [company.id],
    ),
    client.query<{ count: string }>(
      `
        SELECT COUNT(*)::text AS "count"
        FROM "TrackingEvent" event
        JOIN "Order" orders ON orders."id" = event."orderId"
        WHERE orders."companyId" = $1
      `,
      [company.id],
    ),
    listCompanyScopedTables(client),
  ]);

  const companyScoped = await Promise.all(
    companyScopedTables.map(async (table) => ({
      tableName: table.tableName,
      count: await countCompanyScopedRows(client, table, company.id),
    })),
  );

  return {
    company,
    users: Number(users.rows[0]?.count || 0),
    userAccessTokens: Number(userAccessTokens.rows[0]?.count || 0),
    orders: Number(orders.rows[0]?.count || 0),
    trackingEvents: Number(trackingEvents.rows[0]?.count || 0),
    companyScoped: companyScoped.filter(({ count }) => count > 0),
  };
};

const main = async () => {
  const companyName = getArgument('company');
  const confirmed = process.argv.includes('--confirm');

  if (!companyName) {
    throw new Error('Informe a empresa com --company="NOME DA EMPRESA".');
  }

  const client = await dbPool.connect();
  try {
    if (!confirmed) {
      const preview = await buildPreview(client, companyName);
      console.log(JSON.stringify({ mode: 'preview', ...preview }, null, 2));
      console.log('\nNenhum dado foi removido. Execute novamente com --confirm para excluir permanentemente.');
      return;
    }

    await client.query('BEGIN');
    const preview = await buildPreview(client, companyName);
    const companyScopedTables = await listCompanyScopedTables(client);

    for (const table of companyScopedTables) {
      await deleteCompanyScopedRows(client, table, preview.company.id);
    }

    await client.query(
      `
        DELETE FROM "TrackingEvent"
        WHERE "orderId" IN (
          SELECT "id" FROM "Order" WHERE "companyId" = $1
        )
      `,
      [preview.company.id],
    );
    await client.query('DELETE FROM "Order" WHERE "companyId" = $1', [preview.company.id]);
    await client.query(
      `
        DELETE FROM "UserAccessToken"
        WHERE "userId" IN (
          SELECT "id" FROM "User" WHERE "companyId" = $1
        )
      `,
      [preview.company.id],
    );
    await client.query('DELETE FROM "User" WHERE "companyId" = $1', [preview.company.id]);

    const deletedCompany = await client.query<{ id: string }>(
      'DELETE FROM "Company" WHERE "id" = $1 RETURNING "id"',
      [preview.company.id],
    );
    if (deletedCompany.rows.length !== 1) {
      throw new Error('A empresa deixou de existir antes da exclusao. A transacao foi cancelada.');
    }

    await client.query('COMMIT');
    console.log(JSON.stringify({ mode: 'deleted', ...preview }, null, 2));
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await dbPool.end();
  }
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
