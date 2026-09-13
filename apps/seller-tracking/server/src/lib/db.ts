import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';

const { resolveAvantrackingDatabaseUrl } = require('../../../databaseTarget.cjs');

const globalForDbPool = globalThis as typeof globalThis & {
  __avantrackingDbPool?: Pool;
};

const loadEnvFiles = () => {
  const candidates = [
    path.resolve(process.cwd(), '.env'),
    path.resolve(process.cwd(), '.env.local'),
    path.resolve(process.cwd(), '..', '.env'),
    path.resolve(process.cwd(), '..', '.env.local'),
  ];

  for (const filePath of candidates) {
    if (!fs.existsSync(filePath)) {
      continue;
    }

    dotenv.config({
      path: filePath,
      override: false,
      quiet: true,
    });
  }
};

loadEnvFiles();

export const attachPoolErrorHandler = <TPool extends Pick<Pool, 'on'>>(pool: TPool): TPool => {
  pool.on('error', (error: Error & { code?: string }) => {
    console.error('[AVANTRACKING][DB] Conexao do PostgreSQL encerrada; o pool abrira outra quando necessario.', {
      code: error.code || null,
      message: error.message,
    });
  });

  return pool;
};

const createPool = () =>
  attachPoolErrorHandler(
    new Pool({
      connectionString: resolveAvantrackingDatabaseUrl(process.env),
    }),
  );

export const dbPool = globalForDbPool.__avantrackingDbPool || createPool();

if (process.env.NODE_ENV !== 'production') {
  globalForDbPool.__avantrackingDbPool = dbPool;
}

export const dbQuery = <T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = [],
) => dbPool.query<T>(text, params);

export const withDbTransaction = async <T>(
  callback: (client: PoolClient) => Promise<T>,
): Promise<T> => {
  const client = await dbPool.connect();

  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

export type DbResult<T extends QueryResultRow = QueryResultRow> = QueryResult<T>;
