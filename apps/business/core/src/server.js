"use strict";

const { validateProductionEnvironment } = require("../scripts/preflight");

function assertProductionEnvironment() {
  if (String(process.env.NODE_ENV || "").toLowerCase() !== "production") return;
  const result = validateProductionEnvironment(process.env);
  for (const warning of result.warnings) console.warn(`[preflight] AVISO: ${warning}`);
  if (!result.ok) {
    throw new Error(`Configuracao de producao invalida: ${result.errors.join(" ")}`);
  }
}

async function start() {
  assertProductionEnvironment();

  const createApp = require("./app");
  const logger = require("./observability/logger");
  const { startCoreRuntime, stopCoreRuntime } = require("./runtime/coreRuntimeLifecycle");

  const port = Number(process.env.VOLT_CORE_PORT || process.env.PORT || 3100);
  await startCoreRuntime({ source: "standalone", registerProcessHooks: false });

  const app = createApp();
  const server = app.listen(port, () => {
    logger.info("server.started", { port, nodeEnv: process.env.NODE_ENV || "development" });
  });

  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("server.shutdown_started", { signal });

    const forceTimer = setTimeout(() => {
      logger.error("server.shutdown_forced", { signal });
      process.exit(1);
    }, 10_000);
    forceTimer.unref();

    server.close(async (error) => {
      try {
        await stopCoreRuntime({ closePool: true, reason: signal });
      } catch (runtimeError) {
        logger.error("server.runtime_shutdown_error", { error: runtimeError });
      }
      clearTimeout(forceTimer);
      if (error) {
        logger.error("server.shutdown_error", { error });
        process.exit(1);
      }
      process.exit(0);
    });
  }

  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
  return server;
}

if (require.main === module) {
  start().catch((error) => {
    try { require("./observability/logger").error("server.start_failed", { error }); } catch (_loggerError) { console.error("[volt-core] falha ao iniciar:", error.message); }
    process.exit(1);
  });
}

module.exports = { assertProductionEnvironment, start };
