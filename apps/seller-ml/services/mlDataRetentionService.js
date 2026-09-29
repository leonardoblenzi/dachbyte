"use strict";

const { withPgAdvisoryLock } = require("./pgAdvisoryLock");

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_INTERVAL_MS = DAY_MS;
const DEFAULT_INITIAL_DELAY_MS = 5 * 60 * 1000;
const DEFAULT_BATCH_SIZE = 2000;
const DEFAULT_MAX_BATCHES = 20;

let started = false;
let timer = null;
let kickoffTimer = null;

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function isEnabled(value, fallback = true) {
  if (value == null || String(value).trim() === "") return fallback;
  return !["0", "false", "off", "disabled", "no"].includes(
    String(value).trim().toLowerCase(),
  );
}

function getRetentionPolicies(env = process.env) {
  return [
    {
      key: "sku_price_history",
      tableCandidates: ["ml.mercadolivre_sku_price_history"],
      column: "snapshot_date",
      kind: "date",
      days: nonNegativeInt(env.ML_DATA_RETENTION_PRICE_HISTORY_DAYS, 730),
    },
    {
      key: "reputation_snapshots",
      tableCandidates: ["ml.reputation_snapshots"],
      column: "snapshot_date",
      kind: "date",
      days: nonNegativeInt(env.ML_DATA_RETENTION_REPUTATION_DAYS, 730),
    },
    {
      key: "ranking_snapshots",
      tableCandidates: [
        "ml.ml_ranking_anuncios_snapshots",
        "public.ml_ranking_anuncios_snapshots",
      ],
      column: "periodo_fim",
      kind: "date",
      days: nonNegativeInt(env.ML_DATA_RETENTION_RANKING_DAYS, 1095),
    },
    {
      key: "stock_watch_events",
      tableCandidates: ["ml.ml_stock_watch_events", "public.ml_stock_watch_events"],
      column: "created_at",
      kind: "timestamp",
      days: nonNegativeInt(env.ML_DATA_RETENTION_STOCK_EVENTS_DAYS, 365),
    },
    {
      key: "sku_sync_runs",
      tableCandidates: ["ml.mercadolivre_sku_sync_runs"],
      column: "created_at",
      kind: "timestamp",
      days: nonNegativeInt(env.ML_DATA_RETENTION_SYNC_RUNS_DAYS, 365),
    },
    {
      key: "hub_usage_cache",
      tableCandidates: ["ml.hub_usage_report_cache"],
      column: "usage_date",
      kind: "date",
      days: nonNegativeInt(env.ML_DATA_RETENTION_HUB_USAGE_CACHE_DAYS, 14),
    },
  ];
}

async function resolveExistingTable(client, candidates) {
  for (const table of candidates) {
    const result = await client.query("select to_regclass($1) as table_name", [table]);
    if (result.rows?.[0]?.table_name) return table;
  }
  return null;
}

function buildDeleteSql(table, column, kind) {
  const cutoff =
    kind === "date"
      ? "current_date - ($1::int * interval '1 day')"
      : "now() - ($1::int * interval '1 day')";

  return `
    delete from ${table}
     where ctid in (
       select ctid
         from ${table}
        where ${column} < ${cutoff}
        order by ${column} asc
        limit $2
     )`;
}

async function cleanupPolicy(client, policy, options = {}) {
  if (!policy.days) {
    return { key: policy.key, skipped: true, reason: "retention_disabled", deleted: 0 };
  }

  const table = await resolveExistingTable(client, policy.tableCandidates);
  if (!table) {
    return { key: policy.key, skipped: true, reason: "table_not_found", deleted: 0 };
  }

  const batchSize = positiveInt(options.batchSize, DEFAULT_BATCH_SIZE);
  const maxBatches = positiveInt(options.maxBatches, DEFAULT_MAX_BATCHES);
  const sql = buildDeleteSql(table, policy.column, policy.kind);
  let deleted = 0;
  let batches = 0;
  let lastBatchCount = 0;

  while (batches < maxBatches) {
    const result = await client.query(sql, [policy.days, batchSize]);
    const count = Number(result.rowCount || 0);
    lastBatchCount = count;
    deleted += count;
    batches += 1;
    if (count < batchSize) break;
  }

  return {
    key: policy.key,
    table,
    retention_days: policy.days,
    deleted,
    batches,
    limited: batches >= maxBatches && lastBatchCount >= batchSize,
  };
}

async function runDataRetentionCleanup(options = {}) {
  const database = options.db || require("../db/db");
  const policies = options.policies || getRetentionPolicies(options.env || process.env);
  const batchSize = positiveInt(
    options.batchSize || process.env.ML_DATA_RETENTION_BATCH_SIZE,
    DEFAULT_BATCH_SIZE,
  );
  const maxBatches = positiveInt(
    options.maxBatches || process.env.ML_DATA_RETENTION_MAX_BATCHES,
    DEFAULT_MAX_BATCHES,
  );

  return withPgAdvisoryLock(
    "ml_data_retention_cleanup",
    async (client) => {
      const startedAt = Date.now();
      const results = [];
      for (const policy of policies) {
        try {
          results.push(await cleanupPolicy(client, policy, { batchSize, maxBatches }));
        } catch (error) {
          results.push({
            key: policy.key,
            ok: false,
            error: error?.message || String(error),
            deleted: 0,
          });
        }
      }
      return {
        ok: results.every((item) => item.ok !== false),
        deleted: results.reduce((sum, item) => sum + Number(item.deleted || 0), 0),
        duration_ms: Date.now() - startedAt,
        results,
      };
    },
    { db: database },
  );
}

async function checkDataRetention() {
  try {
    const result = await runDataRetentionCleanup();
    if (result?.skipped) return result;
    console.log("[ML][Retention] limpeza de historicos concluida:", {
      deleted: result?.deleted || 0,
      duration_ms: result?.duration_ms || 0,
    });
    return result;
  } catch (error) {
    console.error("[ML][Retention] falha na limpeza de historicos:", error?.message || error);
    return { ok: false, error: error?.message || String(error) };
  }
}

function startDataRetentionScheduler() {
  if (started || !isEnabled(process.env.ML_DATA_RETENTION_ENABLED, false)) return;
  started = true;

  const intervalMs = positiveInt(
    process.env.ML_DATA_RETENTION_INTERVAL_MS,
    DEFAULT_INTERVAL_MS,
  );
  const initialDelayMs = positiveInt(
    process.env.ML_DATA_RETENTION_INITIAL_DELAY_MS,
    DEFAULT_INITIAL_DELAY_MS,
  );

  kickoffTimer = setTimeout(() => void checkDataRetention(), initialDelayMs);
  kickoffTimer.unref?.();
  timer = setInterval(() => void checkDataRetention(), intervalMs);
  timer.unref?.();

  console.log("[ML][Retention] scheduler de historicos ativo.");
}

function stopDataRetentionScheduler() {
  if (kickoffTimer) clearTimeout(kickoffTimer);
  if (timer) clearInterval(timer);
  kickoffTimer = null;
  timer = null;
  started = false;
}

module.exports = {
  _test: {
    buildDeleteSql,
    cleanupPolicy,
    getRetentionPolicies,
    isEnabled,
    resolveExistingTable,
  },
  checkDataRetention,
  getRetentionPolicies,
  runDataRetentionCleanup,
  startDataRetentionScheduler,
  stopDataRetentionScheduler,
};
