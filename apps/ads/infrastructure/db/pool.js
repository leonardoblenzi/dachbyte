"use strict";

const { Pool } = require("pg");
const { env } = require("../../config/env");

let appPool;
let workerPool;

function createPool(connectionString, label) {
  if (!connectionString) throw new Error(`${label} database URL is required`);
  const pool = new Pool({ connectionString, max: 10, idleTimeoutMillis: 30_000 });
  pool.on("error", (error) => console.error(`[dach-ads:${label}] postgres pool error`, error));
  return pool;
}

function getAppPool() {
  if (!appPool) appPool = createPool(env.databaseUrl, "app-db");
  return appPool;
}

function getWorkerPool() {
  if (!workerPool) workerPool = createPool(env.workerDatabaseUrl, "worker-db");
  return workerPool;
}

async function closePools() {
  await Promise.all([
    appPool?.end().catch(() => {}),
    workerPool && workerPool !== appPool ? workerPool.end().catch(() => {}) : Promise.resolve(),
  ]);
}

module.exports = { getAppPool, getWorkerPool, closePools };
