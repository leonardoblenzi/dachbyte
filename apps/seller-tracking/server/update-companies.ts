import { Pool } from 'pg';
import crypto from 'crypto';

function requireDbUrl(name: string): string {
  const value = String(process.env[name] || '').trim();
  if (!value) {
    throw new Error(`${name} nao definido. Configure a connection string via variavel de ambiente.`);
  }
  return value;
}

const MAIN_DB_URL = requireDbUrl('DROSSI_DATABASE_URL');

const pool = new Pool({
  connectionString: MAIN_DB_URL,
});

async function main() {
  const drossiResult = await pool.query<{ id: string }>(
    `
      SELECT c."id"
      FROM "Company" c
      WHERE c."name" ILIKE '%DROSSI%'
      ORDER BY c."createdAt" ASC
      LIMIT 1
    `,
  );
  const drossi = drossiResult.rows[0] || null;

  if (drossi) {
    await pool.query(
      `
        UPDATE "Company" c
        SET
          "databaseUrl" = $2,
          "updatedAt" = NOW()
        WHERE c."id" = $1
      `,
      [drossi.id, MAIN_DB_URL],
    );
    console.log('Drossi updated');
  } else {
    await pool.query(
      `
        INSERT INTO "Company" (
          "id",
          "name",
          "databaseUrl",
          "createdAt",
          "updatedAt"
        )
        VALUES ($3, $1, $2, NOW(), NOW())
      `,
      ['DROSSI INTERIORES', MAIN_DB_URL, crypto.randomUUID()],
    );
    console.log('Drossi created');
  }

  const mpozenatoUrl = requireDbUrl('MPOZENATO_DATABASE_URL');
  const mpozenatoResult = await pool.query<{ id: string }>(
    `
      SELECT c."id"
      FROM "Company" c
      WHERE c."name" ILIKE '%MPOZENATO%'
      ORDER BY c."createdAt" ASC
      LIMIT 1
    `,
  );
  const mpozenato = mpozenatoResult.rows[0] || null;

  if (mpozenato) {
    await pool.query(
      `
        UPDATE "Company" c
        SET
          "databaseUrl" = $2,
          "updatedAt" = NOW()
        WHERE c."id" = $1
      `,
      [mpozenato.id, mpozenatoUrl],
    );
    console.log('Mpozenato updated');
  } else {
    await pool.query(
      `
        INSERT INTO "Company" (
          "id",
          "name",
          "databaseUrl",
          "createdAt",
          "updatedAt"
        )
        VALUES ($3, $1, $2, NOW(), NOW())
      `,
      ['MPOZENATO', mpozenatoUrl, crypto.randomUUID()],
    );
    console.log('Mpozenato created');
  }
}

main()
  .catch(console.error)
  .finally(async () => {
    await pool.end();
  });
