"use strict";

const path = require("node:path");
const { loadRuntimeEnv } = require("../../lib/runtimeEnv");
const { startExpressApp } = require("../../platform/runtime/startExpressApp");

loadRuntimeEnv({
  defaultCandidates: [
    path.join(__dirname, ".env"),
    path.join(__dirname, "..", ".env"),
  ],
});

// O app só é carregado depois do ambiente: a config lê process.env ao iniciar.
const { createApp } = require("./index");

startExpressApp({
  createApp,
  name: "seller-hub",
  mountPath: "/hub",
}).catch((error) => {
  console.error("[seller-hub] bootstrap failed", error);
  process.exit(1);
});
