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

assertTokenEncryptionConfigured("job semanal de historico de precos por SKU ML");

const {
  enqueueWeeklySkuPriceHistory,
  runDueWeeklySkuPriceHistory,
} = require("../services/mercadolivreSkuPriceHistoryScheduler");

function parseArgs(argv) {
  const args = {};
  for (const part of argv) {
    const match = String(part || "").match(/^--([^=]+)=(.*)$/);
    if (match) args[match[1]] = match[2];
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const accountIds = String(args.accounts || "")
    .split(",")
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isFinite(value) && value > 0);
  const force = ["1", "true", "yes", "sim"].includes(String(args.force || "").toLowerCase());
  const options = { accountIds: accountIds.length ? accountIds : null, force };
  const result = force
    ? await enqueueWeeklySkuPriceHistory(options)
    : await runDueWeeklySkuPriceHistory(options);

  console.log(JSON.stringify(result, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("[Preco SKU ML] Job semanal falhou:", error?.message || error);
    process.exit(1);
  });
