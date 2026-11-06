import { Pool } from 'pg';

function requireDbUrl(name: string): string {
  const value = String(process.env[name] || '').trim();
  if (!value) {
    throw new Error(`${name} nao definido. Configure a connection string via variavel de ambiente.`);
  }
  return value;
}

const mpozenatoPool = new Pool({
  connectionString: requireDbUrl('MPOZENATO_DATABASE_URL'),
});

const drossiPool = new Pool({
  connectionString: requireDbUrl('DROSSI_DATABASE_URL'),
});

async function syncCompanies() {
  const drossiCompaniesResult = await drossiPool.query<any>(
    `
      SELECT
        c."id",
        c."name",
        c."cnpj",
        c."databaseUrl"
      FROM "Company" c
    `,
  );
  const drossiCompanies = drossiCompaniesResult.rows;

  for (const c of drossiCompanies) {
    const existsResult = await mpozenatoPool.query<{ id: string }>(
      `
        SELECT c."id"
        FROM "Company" c
        WHERE c."id" = $1
        LIMIT 1
      `,
      [c.id],
    );
    const exists = existsResult.rows[0] || null;
    if (!exists) {
      await mpozenatoPool.query(
        `
          INSERT INTO "Company" (
            "id",
            "name",
            "cnpj",
            "databaseUrl",
            "createdAt",
            "updatedAt"
          )
          VALUES ($1, $2, $3, $4, NOW(), NOW())
        `,
        [c.id, c.name, c.cnpj || null, c.databaseUrl || null],
      );
      console.log(`Synced company ${c.name} to Mpozenato DB`);
    }
  }

  const drossiUsersResult = await drossiPool.query<any>(
    `
      SELECT
        u."id",
        u."email",
        u."name",
        u."password",
        u."role",
        u."companyId"
      FROM "User" u
    `,
  );
  const drossiUsers = drossiUsersResult.rows;

  for (const u of drossiUsers) {
    const existsResult = await mpozenatoPool.query<{ id: string }>(
      `
        SELECT u."id"
        FROM "User" u
        WHERE u."id" = $1
        LIMIT 1
      `,
      [u.id],
    );
    const exists = existsResult.rows[0] || null;
    if (!exists) {
      await mpozenatoPool.query(
        `
          INSERT INTO "User" (
            "id",
            "email",
            "name",
            "password",
            "role",
            "companyId",
            "createdAt",
            "updatedAt"
          )
          VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
        `,
        [u.id, u.email, u.name, u.password, u.role, u.companyId || null],
      );
      console.log(`Synced user ${u.name} to Mpozenato DB`);
    }
  }
}

syncCompanies()
  .catch(console.error)
  .finally(async () => {
    await Promise.all([mpozenatoPool.end(), drossiPool.end()]);
  });
