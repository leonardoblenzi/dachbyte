import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.AVANTRACKING_DATABASE_URL || process.env.DATABASE_URL,
});

type UserRole = 'ADMIN' | 'USER';

async function main() {
  const users: Array<{
    name: string;
    email: string;
    password: string;
    role: UserRole;
  }> = [
    {
      name: 'Admin',
      email: 'admin@avantracking.com.br',
      password: 'admin',
      role: 'ADMIN',
    },
    {
      name: 'Josy Rossi',
      email: 'dmovambientes@gmail.com',
      password: 'Dmov@123',
      role: 'USER',
    },
    {
      name: 'Nath Zanin',
      email: 'coordenacao@drossiinteriores.com.br',
      password: 'Alfenas@123',
      role: 'USER',
    },
  ];

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
