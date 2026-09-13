import type pg from 'pg';
import { pool } from './pool';

export type TenantClient = pg.PoolClient;

export async function withTenant<T>(
  tenantId: string,
  userId: string | undefined,
  handler: (client: TenantClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', ['app.current_tenant_id', tenantId]);

    if (userId) {
      await client.query('SELECT set_config($1, $2, true)', ['app.current_user_id', userId]);
    }

    const result = await handler(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
