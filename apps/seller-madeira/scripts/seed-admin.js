"use strict";

const path = require("path");
const bcrypt = require("bcryptjs");
const dotenv = require("dotenv");
const { Pool } = require("pg");

dotenv.config({
  path: path.join(__dirname, "..", ".env"),
  quiet: true,
});

function normalizeDatabaseUrl() {
  const rawUrl = String(process.env.MAD_DATABASE_URL || "").trim();
  if (!rawUrl) {
    throw new Error("MAD_DATABASE_URL nao configurada.");
  }

  const connectionUrl = new URL(rawUrl);

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
}

async function main() {
  const email = "araphael.fialho@gmail.com".toLowerCase().trim();
  const passwordHash = await bcrypt.hash("Alfenas@172839", 10);
  const now = new Date();
  const pool = new Pool({
    connectionString: normalizeDatabaseUrl(),
    ssl: {
      rejectUnauthorized: false,
    },
    max: 1,
  });

  try {
    const result = await pool.query(
      `
        insert into "MadUser" (
          "id",
          "workspaceId",
          "name",
          "email",
          "passwordHash",
          "role",
          "status",
          "isMaster",
          "metadata",
          "createdAt",
          "updatedAt"
        )
        values (
          'madusr_master_raphael',
          null,
          $1,
          $2,
          $3,
          'admin_master',
          'active',
          true,
          $4::jsonb,
          $5,
          $5
        )
        on conflict ("email") do update
        set
          "name" = excluded."name",
          "passwordHash" = excluded."passwordHash",
          "role" = excluded."role",
          "status" = excluded."status",
          "isMaster" = excluded."isMaster",
          "metadata" = excluded."metadata",
          "updatedAt" = excluded."updatedAt"
        returning "id", "email", "role", "status", "isMaster", "createdAt", "updatedAt"
      `,
      [
        "Raphael Fialho",
        email,
        passwordHash,
        JSON.stringify({
          source: "seed-admin",
          module: "MadeiraMadeira",
        }),
        now,
      ],
    );

    console.log("[seed-admin] usuario master pronto:", result.rows[0]);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error("[seed-admin] erro:", error);
  process.exit(1);
});
