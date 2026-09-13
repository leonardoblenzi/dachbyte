import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.AVANTRACKING_DATABASE_URL || process.env.DATABASE_URL,
});

async function main() {
  console.log('Iniciando limpeza de pedidos...');
  try {
    const deleted = await pool.query<{ count: number }>(
      `
        WITH deleted AS (
          DELETE FROM "Order"
          RETURNING 1
        )
        SELECT COUNT(*)::int AS count
        FROM deleted
      `,
    );
    console.log(`Sucesso! ${Number(deleted.rows[0]?.count || 0)} pedidos foram deletados.`);
  } catch (error) {
    console.error('Erro ao deletar pedidos:', error);
  } finally {
    await pool.end();
  }
}

main();
