"use strict";

const path = require("path");
const { loadRuntimeEnv } = require("../../../lib/runtimeEnv");

loadRuntimeEnv({
  defaultCandidates: [
    path.join(__dirname, "..", ".env"),
    path.join(__dirname, "..", "..", "..", ".env"),
  ],
});

const { ensureMasterUser } = require("../services/bootstrapMaster");

function envEnabled(value) {
  return ["1", "true", "yes", "on"].includes(
    String(value || "").trim().toLowerCase(),
  );
}

ensureMasterUser({
  enabled: true,
  allowPromote: envEnabled(process.env.ML_BOOTSTRAP_MASTER_ALLOW_PROMOTE),
})
  .then((result) => {
    console.log("[ML] Bootstrap MASTER concluido:", result);
    process.exit(0);
  })
  .catch((error) => {
    console.error("[ML] Bootstrap MASTER falhou:", error?.message || error);
    if (error?.code) console.error("[ML] Codigo:", error.code);
    process.exit(1);
  });
