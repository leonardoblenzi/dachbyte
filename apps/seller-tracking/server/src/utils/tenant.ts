import { Pool } from 'pg';
import { dbPool, dbQuery } from '../lib/db';

export const mainDbPool = dbPool;

const tenantPools = new Map<string, Pool>();

const buildTenantPool = (connectionString: string) =>
  new Pool({
    connectionString,
  });

export const getTenantDbPool = async (
  companyId?: string | null,
): Promise<Pool> => {
  if (!companyId) {
    return mainDbPool;
  }

  try {
    const companyResult = await dbQuery<{ databaseUrl: string | null }>(
      `
        SELECT c."databaseUrl"
        FROM "Company" c
        WHERE c."id" = $1
        LIMIT 1
      `,
      [companyId],
    );
    const databaseUrl = String(companyResult.rows[0]?.databaseUrl || '').trim();

    if (!databaseUrl) {
      return mainDbPool;
    }

    if (!tenantPools.has(databaseUrl)) {
      tenantPools.set(databaseUrl, buildTenantPool(databaseUrl));
    }

    return tenantPools.get(databaseUrl) || mainDbPool;
  } catch (error) {
    console.error('Erro ao buscar pool tenant:', error);
    return mainDbPool;
  }
};

export const syncToAllTenants = async (
  action: (pool: Pool) => Promise<void>,
) => {
  try {
    const companiesResult = await dbQuery<{ databaseUrl: string | null }>(
      `
        SELECT c."databaseUrl"
        FROM "Company" c
        WHERE c."databaseUrl" IS NOT NULL
      `,
    );

    const urls = Array.from<string>(
      new Set(
        companiesResult.rows
          .map((row) => String(row.databaseUrl || '').trim())
          .filter(Boolean),
      ),
    );

    await action(mainDbPool);

    for (const url of urls) {
      if (!tenantPools.has(url)) {
        tenantPools.set(url, buildTenantPool(url));
      }

      const tenantPool = tenantPools.get(url);
      if (!tenantPool) {
        continue;
      }

      try {
        await action(tenantPool);
      } catch (error) {
        console.error(`Erro ao sincronizar tenant ${url}:`, error);
      }
    }
  } catch (error) {
    console.error('Erro geral no syncToAllTenants:', error);
  }
};

// Compatibilidade com assinatura antiga baseada em Prisma.
export const mainPrisma = mainDbPool;
export const getTenantPrisma = getTenantDbPool;
