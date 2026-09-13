"use strict";

const path = require("path");
const { loadRuntimeEnv } = require("../lib/runtimeEnv");

loadRuntimeEnv({
  defaultCandidates: [
    path.join(__dirname, "..", ".env"),
    path.join(__dirname, "..", "apps", "seller-shopee", "src", ".env"),
    path.join(__dirname, "..", "apps", "seller-shopee", ".env"),
  ],
});

const db = require("../lib/sacDatabase");
const supportService = require("../lib/sacSupportService");

async function main() {
  await supportService.ensureSacSupportSchema();
  await supportService.ensureSacSupportAdmins(supportService.defaultSacSupportAdminSeeds());
  await supportService.cleanupExpiredRetention();
  console.log("[sac:migrate] Tabelas e admins do SAC prontos no DATABASE_URL configurado.");
}

main()
  .catch((error) => {
    console.error("[sac:migrate] Falha ao migrar SAC:", error?.message || error);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (db.pool && typeof db.pool.end === "function") {
      await db.pool.end().catch(() => {});
    }
  });
