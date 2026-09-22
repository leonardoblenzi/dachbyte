"use strict";

const path = require("path");
const { loadRuntimeEnv } = require("../../lib/runtimeEnv");
const {
  assertTokenEncryptionConfigured,
} = require("./services/tokenCrypto");

loadRuntimeEnv({
  defaultCandidates: [
    path.join(__dirname, ".env"),
    path.join(__dirname, "..", ".env"),
  ],
});

assertTokenEncryptionConfigured("bootstrap do worker ML");

const PromoJobsService = require("./services/promoJobsService");
const PromoSmartOptimizerService = require("./services/promoSmartOptimizerService");
const PromoBulkRemove = require("./services/promoBulkRemoveAdapter");
const ExclusaoLoteJobService = require("./services/exclusaoLoteJobService");
const filtroAnunciosQueueService = require("./services/filtroAnunciosQueueService");
const FinanceiroMlSkuCatalogSyncService = require("./services/financeiroMlSkuCatalogSyncService");
const prazoProducaoQueueService = require("./services/prazoProducaoQueueService");
const validarDimensoesJobService = require("./services/validarDimensoesJobService");
const estoqueAlertaQueueService = require("./services/estoqueAlertaQueueService");
const estoqueAtualizacaoQueueService = require("./services/estoqueAtualizacaoQueueService");
const CaracteristicasJobsService = require("./services/caracteristicasJobsService");

function boot() {
  PromoJobsService.initWorker();
  PromoSmartOptimizerService.initWorker();
  PromoBulkRemove.initWorker();
  ExclusaoLoteJobService.initWorker();
  filtroAnunciosQueueService.initWorker();
  FinanceiroMlSkuCatalogSyncService.initWorker();
  prazoProducaoQueueService.initWorker();
  estoqueAlertaQueueService.initWorker();
  estoqueAtualizacaoQueueService.initWorker();
  validarDimensoesJobService.iniciarWorker();
  CaracteristicasJobsService.initWorker();

  console.log("[ML Worker] filas principais iniciadas");
}

boot();

function shutdown(signal) {
  console.log(`[ML Worker] Recebido ${signal}, encerrando...`);
  try {
    PromoJobsService.stopWorkerHealth?.();
  } catch {}
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("unhandledRejection", (reason) => {
  console.error("[ML Worker] Unhandled Rejection:", reason);
});
process.on("uncaughtException", (error) => {
  console.error("[ML Worker] Uncaught Exception:", error);
  process.exit(1);
});
