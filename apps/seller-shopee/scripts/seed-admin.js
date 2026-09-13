"use strict";

const path = require("path");
const bcrypt = require("bcrypt");
const dotenv = require("dotenv");
const { Pool } = require("pg");

dotenv.config({
  path: path.join(__dirname, "..", "src", ".env"),
  quiet: true,
});

dotenv.config({
  path: path.join(__dirname, "..", ".env"),
  quiet: true,
  override: false,
});

function normalizeDatabaseUrl(rawValue) {
  const value = String(rawValue || "").trim();
  if (!value) {
    throw new Error("SHOPEE_DATABASE_URL ou DATABASE_URL nao configurada para seed SQL.");
  }

  try {
    const connectionUrl = new URL(value);

    if (
      process.platform === "win32" &&
      connectionUrl.searchParams.get("channel_binding") === "require"
    ) {
      connectionUrl.searchParams.set("channel_binding", "disable");
    }

    if (
      connectionUrl.searchParams.get("sslmode") === "require" &&
      !connectionUrl.searchParams.has("uselibpqcompat")
    ) {
      connectionUrl.searchParams.set("uselibpqcompat", "true");
    }

    return connectionUrl.toString();
  } catch (_error) {
    return value;
  }
}

function resolveSslOptions(connectionString) {
  try {
    const parsed = new URL(connectionString);
    const sslMode = String(parsed.searchParams.get("sslmode") || "").toLowerCase();
    const sslFlag = String(parsed.searchParams.get("ssl") || "").toLowerCase();

    if (
      sslMode === "require" ||
      sslMode === "prefer" ||
      sslMode === "verify-ca" ||
      sslMode === "verify-full" ||
      sslFlag === "true" ||
      /\.neon\.(tech|build)$/i.test(parsed.hostname)
    ) {
      return { rejectUnauthorized: false };
    }
  } catch (_error) {
    return undefined;
  }

  return undefined;
}

async function main() {
  const connectionString = normalizeDatabaseUrl(
    process.env.SHOPEE_DATABASE_URL || process.env.DATABASE_URL,
  );
  const pool = new Pool({
    connectionString,
    ssl: resolveSslOptions(connectionString),
    max: 1,
  });

  const superAdminEmail = (
    process.env.MASTER_ADMIN_EMAIL || "cadastro6@drossiinteriores.com.br"
  )
    .toLowerCase()
    .trim();
  const superAdminPassword = String(process.env.SUPER_ADMIN_PASSWORD || "").trim();
  if (!superAdminPassword) {
    throw new Error("SUPER_ADMIN_PASSWORD obrigatoria para executar o bootstrap do administrador.");
  }
  const passwordHash = await bcrypt.hash(superAdminPassword, 10);

  try {
    await pool.query("BEGIN");

    let legacyAccountResult = await pool.query(
      `
        SELECT id, name
        FROM "Account"
        WHERE name = 'Legacy'
        ORDER BY id ASC
        LIMIT 1
      `,
    );

    if (legacyAccountResult.rowCount === 0) {
      legacyAccountResult = await pool.query(
        `
          INSERT INTO "Account" (name, "createdAt", "updatedAt")
          VALUES ('Legacy', NOW(), NOW())
          RETURNING id, name
        `,
      );
    }

    const legacyAccount = legacyAccountResult.rows[0];

    const backfill = await pool.query(
      `
        UPDATE "Shop"
        SET "accountId" = $1, "updatedAt" = NOW()
        WHERE "accountId" IS NULL
      `,
      [legacyAccount.id],
    );

    const userResult = await pool.query(
      `
        INSERT INTO "User" (
          email,
          "passwordHash",
          role,
          "accountId",
          status,
          "activatedAt",
          "passwordChangedAt",
          "createdAt",
          "updatedAt"
        )
        VALUES ($1, $2, 'SUPER_ADMIN', $3, 'ACTIVE', NOW(), NOW(), NOW(), NOW())
        ON CONFLICT (email)
        DO UPDATE SET
          "passwordHash" = EXCLUDED."passwordHash",
          role = EXCLUDED.role,
          "accountId" = EXCLUDED."accountId",
          status = EXCLUDED.status,
          "activatedAt" = NOW(),
          "passwordChangedAt" = NOW(),
          "updatedAt" = NOW()
        RETURNING id, email, role, status, "accountId" AS account_id
      `,
      [superAdminEmail, passwordHash, legacyAccount.id],
    );

    await pool.query("COMMIT");

    console.log("[seed-admin] conta Legacy pronta:", {
      id: Number(legacyAccount.id),
      name: legacyAccount.name,
    });
    console.log("[seed-admin] shops associadas a Legacy:", backfill.rowCount);
    console.log("[seed-admin] super admin pronto:", {
      id: Number(userResult.rows[0].id),
      email: userResult.rows[0].email,
      role: userResult.rows[0].role,
      status: userResult.rows[0].status,
      accountId: Number(userResult.rows[0].account_id),
    });
  } catch (error) {
    await pool.query("ROLLBACK");
    throw error;
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error("[seed-admin] erro:", error);
  process.exit(1);
});
