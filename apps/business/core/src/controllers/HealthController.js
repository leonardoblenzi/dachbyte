"use strict";

const { isDatabaseEnabled, query } = require("../../db/db");
const { getIntegrationWorker } = require("../modules/integrations/worker");

function isWorkerDisabled() {
  return String(process.env.VOLT_CORE_WORKER_DISABLED || "").toLowerCase() === "true";
}

async function health(_req, res) {
  const databaseEnabled = isDatabaseEnabled();
  let database = databaseEnabled ? "checking" : "disabled";
  let statusCode = 200;

  if (databaseEnabled) {
    try {
      await query("select 1");
      database = "ok";
    } catch (_error) {
      database = "error";
      statusCode = 503;
    }
  } else if (String(process.env.NODE_ENV || "").toLowerCase() === "production") {
    statusCode = 503;
  }

  const rawWorker = getIntegrationWorker().status();
  const workerDisabled = isWorkerDisabled();
  let workerStatus = "ok";

  if (workerDisabled) workerStatus = "disabled";
  else if (rawWorker.lastError) workerStatus = "degraded";
  else if (databaseEnabled && !rawWorker.started) workerStatus = "stopped";
  else if (rawWorker.started && !rawWorker.lastRunAt) workerStatus = "starting";

  if (databaseEnabled && !workerDisabled && ["degraded", "stopped"].includes(workerStatus)) {
    statusCode = 503;
  }

  res.status(statusCode).json({
    name: "Volt Core API",
    status: statusCode === 200 ? "ok" : "degraded",
    database,
    worker: {
      status: workerStatus,
      started: rawWorker.started,
      running: rawWorker.running,
      lastRunAt: rawWorker.lastRunAt,
      lastError: rawWorker.lastError,
    },
    uptimeSec: Math.floor(process.uptime()),
  });
}

module.exports = { health };
