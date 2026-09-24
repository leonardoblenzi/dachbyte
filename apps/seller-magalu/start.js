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

// Require do produto somente depois de carregar o ambiente: os módulos de
// config leem process.env na inicialização.
const { createApp } = require("./index");

startExpressApp({
  createApp,
  name: "seller-magalu",
  mountPath: "/magalu",
}).catch((error) => {
  console.error("[seller-magalu] bootstrap failed", error);
  process.exit(1);
});
