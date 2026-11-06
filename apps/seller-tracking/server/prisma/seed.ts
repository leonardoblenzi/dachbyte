import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.AVANTRACKING_DATABASE_URL || process.env.DATABASE_URL,
});

type UserRole = 'ADMIN' | 'USER';

async function main() {
  // Senhas de seed vem exclusivamente de variaveis de ambiente. Usuarios sem
  // senha configurada sao ignorados (sem credenciais embutidas no codigo).
  const users: Array<{
    name: string;
    email: string;
    password: string;
    role: UserRole;
  }> = [
    {
      name: 'Admin',
      email: process.env.SEED_ADMIN_EMAIL || 'admin@avantracking.com.br',
      password: process.env.SEED_ADMIN_PASSWORD || '',
      role: 'ADMIN',
    },
    {
      name: 'Josy Rossi',
      email: process.env.SEED_USER1_EMAIL || 'dmovambientes@gmail.com',
      password: process.env.SEED_USER1_PASSWORD || '',
      role: 'USER',
    },
    {
      name: 'Nath Zanin',
      email: process.env.SEED_USER2_EMAIL || 'coordenacao@drossiinteriores.com.br',
      password: process.env.SEED_USER2_PASSWORD || '',
      role: 'USER',
    },
  ].filter((user) => {
    if (!user.password) {
      console.log(`Seed ignorado (senha nao configurada): ${user.email}`);
      return false;
    }
    return true;
  });

  for (const user of users) {
    const existingUser = await pool.query<{ id: string }>(
      `
        SELECT u."id"
        FROM "User" u
        WHERE u."email" = $1
        LIMIT 1
      `,
      [user.email],
    );

    if (existingUser.rows.length === 0) {
      const hashedPassword = await bcrypt.hash(user.password, 10);
      await pool.query(
        `
          INSERT INTO "User" (
            "id",
            "name",
            "email",
            "password",
            "role",
            "createdAt",
            "updatedAt"
          )
          VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
        `,
        [crypto.randomUUID(), user.name, user.email, hashedPassword, user.role],
      );
      console.log(`User created: ${user.email}`);
    } else {
      console.log(`User already exists: ${user.email}`);
    }
  }

}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await pool.end();
  });
