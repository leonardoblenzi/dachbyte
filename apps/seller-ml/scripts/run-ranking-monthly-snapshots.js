"use strict";

const path = require("path");
const { loadRuntimeEnv } = require("../../../lib/runtimeEnv");
const {
  assertTokenEncryptionConfigured,
} = require("../services/tokenCrypto");

loadRuntimeEnv({
  defaultCandidates: [
    path.join(__dirname, "..", ".env"),
    path.join(__dirname, "..", "..", ".env"),
  ],
});

assertTokenEncryptionConfigured("job mensal de snapshots do ranking ML");

const { snapshots } = require("../routes/mercadolivreRankingRoutes");

async function main() {
  const result = await snapshots.runDueMonthlySnapshots();
  console.log(JSON.stringify(result, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("[Ranking] Job mensal falhou:", error?.message || error);
    process.exit(1);
  });
