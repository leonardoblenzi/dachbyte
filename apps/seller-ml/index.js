// ml/index.js
"use strict";

const path = require("path");
const { loadRuntimeEnv } = require("../../lib/runtimeEnv");
const {
  assertTokenEncryptionConfigured,
} = require("./services/tokenCrypto");

loadRuntimeEnv({
  defaultCandidates: [
    path.join(__dirname, ".env"),
    path.join(__dirname, "..", "..", ".env"),
  ],
});

assertTokenEncryptionConfigured("bootstrap do app ML");

const createMlAppBase = require("./app");

function createMlApp() {
  const app = createMlAppBase();
  return app;
}

if (require.main === module) {
  const port = process.env.PORT || 3000;
  const app = createMlApp();

  const server = app.listen(port, "0.0.0.0", () => {
    console.log("================================");
    console.log(`[ML] Servidor rodando em http://localhost:${port}`);
    console.log("================================");
  });

  async function gracefulShutdown(signal) {
    console.log(`[ML] Recebido ${signal}, encerrando servidor...`);

    const queueService = app.locals?.queueService;
    if (queueService) {
      try {
        console.log("[ML] Pausando sistema de filas...");
        if (typeof queueService.pausarJob === "function") {
          await queueService.pausarJob();
        }
        console.log("[ML] Sistema de filas pausado");
      } catch (error) {
        console.error(
          "[ML] Erro ao pausar sistema de filas:",
          error?.message || error,
        );
      }
    }

    server.close(() => {
      console.log("[ML] Servidor encerrado com sucesso");
      process.exit(0);
    });

    setTimeout(() => {
      console.log("[ML] Forcando encerramento...");
      process.exit(1);
    }, 10000);
  }

  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
  process.on("SIGINT", () => gracefulShutdown("SIGINT"));
  process.on("unhandledRejection", (reason, promise) => {
    console.error("[ML] Unhandled Rejection at:", promise, "reason:", reason);
  });
  process.on("uncaughtException", (error) => {
    console.error("[ML] Uncaught Exception:", error);
    gracefulShutdown("UNCAUGHT_EXCEPTION");
  });
}

module.exports = createMlApp;
