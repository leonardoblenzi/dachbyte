"use strict";

const { previousClosedMonthWindow, fetchPaidOrdersTotal, rangeForPaidOrders } = require("./closedMonthOrderMeasurement");

async function queueClosedMonthMeasurement(db, accountId, now = new Date()) {
  const id = Number(accountId);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error("ml_orders_account_invalid");
  const window = previousClosedMonthWindow(now);
  await db.query(
    `INSERT INTO ml_closed_month_order_measurements
       (account_id, period_start, period_end_exclusive, status)
     VALUES ($1, $2, $3, 'queued')
     ON CONFLICT (account_id, period_start) DO NOTHING`,
    [id, window.periodStart, window.periodEndExclusive]
  );
  return window;
}

function measurementWindow(row) {
  const periodStart = new Date(row.period_start);
  const periodEndExclusive = new Date(row.period_end_exclusive);
  if (!Number.isFinite(periodStart.getTime()) || !Number.isFinite(periodEndExclusive.getTime()) ||
      periodEndExclusive <= periodStart) throw new Error("ml_orders_measurement_period_invalid");
  return {
    periodStart: periodStart.toISOString(),
    periodEndExclusive: periodEndExclusive.toISOString(),
    searchEndInclusive: new Date(periodEndExclusive.getTime() - 60 * 60 * 1000).toISOString(),
  };
}

async function processClosedMonthMeasurement(db, accountId, periodStart, deps = {}) {
  const claimed = await db.query(
    `UPDATE ml_closed_month_order_measurements AS m
        SET status = 'running', started_at = NOW(), error_message = NULL, updated_at = NOW()
       FROM meli_contas AS mc
      WHERE m.account_id = $1 AND m.period_start = $2::date
        AND m.account_id = mc.id AND m.status = 'queued'
      RETURNING m.account_id, m.period_start, m.period_end_exclusive, mc.meli_user_id`,
    [accountId, periodStart]
  );
  const row = claimed.rows[0];
  if (!row) return { status: "skipped" };
  try {
    const loadCredentials = deps.loadCredentials || require("./estoqueAtualizacaoWorkerCredentials").loadWorkerCredentials;
    const fetchTotal = deps.fetchTotal || fetchPaidOrdersTotal;
    const credentials = await loadCredentials(row.account_id);
    if (String(credentials?.mlCreds?.meli_user_id) !== String(row.meli_user_id)) {
      throw new Error("ml_orders_seller_identity_mismatch");
    }
    const total = await fetchTotal({
      accessToken: credentials.accessToken,
      sellerId: Number(row.meli_user_id),
      window: measurementWindow(row),
    });
    const rangeCode = rangeForPaidOrders(total);
    if (typeof db.withClient !== "function") throw new Error("ml_orders_transaction_unavailable");
    await db.withClient(async (client) => {
      await client.query("BEGIN");
      try {
        await client.query(
          `UPDATE ml_closed_month_order_measurements
              SET status = 'succeeded', order_count = $3, range_code = $4,
                  source = $5, measured_at = NOW(), error_message = NULL, updated_at = NOW()
            WHERE account_id = $1 AND period_start = $2::date AND status = 'running'`,
          [row.account_id, periodStart, total, rangeCode, "mercado_livre_orders_search"]
        );
        await client.query(
          `UPDATE meli_contas
              SET last_closed_period_start = $2::date,
                  last_closed_period_end = ($3::date - INTERVAL '1 day')::date,
                  last_closed_period_orders = $4, recommended_range_code = $5,
                  atualizado_em = NOW()
            WHERE id = $1`,
          [row.account_id, measurementWindow(row).periodStart,
            measurementWindow(row).periodEndExclusive, total, rangeCode]
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      }
    });
    return { status: "succeeded", total, rangeCode };
  } catch (error) {
    const code = String(error?.message || "ml_orders_measurement_failed").slice(0, 300);
    await db.query(
      `UPDATE ml_closed_month_order_measurements
          SET status = 'failed', error_message = $3, updated_at = NOW()
        WHERE account_id = $1 AND period_start = $2::date AND status = 'running'`,
      [row.account_id, periodStart, code]
    );
    return { status: "failed", error: code };
  }
}

async function runPendingClosedMonthMeasurements(db, options = {}) {
  await db.query(
    `UPDATE ml_closed_month_order_measurements
        SET status = 'queued', updated_at = NOW()
      WHERE status = 'running' AND started_at < NOW() - INTERVAL '10 minutes'`
  );
  const pending = await db.query(
    `SELECT account_id, period_start
       FROM ml_closed_month_order_measurements
      WHERE status = 'queued'
      ORDER BY created_at
      LIMIT 20`
  );
  const processRow = options.processRow || ((accountId, periodStart) =>
    processClosedMonthMeasurement(db, accountId, periodStart));
  for (const row of pending.rows) {
    const periodStart = new Date(row.period_start).toISOString().slice(0, 10);
    await processRow(Number(row.account_id), periodStart);
  }
  return pending.rows.length;
}

async function requeueFailedClosedMonthMeasurement(db, accountId, periodStart) {
  const updated = await db.query(
    `UPDATE ml_closed_month_order_measurements
        SET status = 'queued', error_message = NULL, updated_at = NOW()
      WHERE account_id = $1 AND period_start = $2::date AND status = 'failed'
      RETURNING account_id`,
    [accountId, periodStart]
  );
  return Boolean(updated.rows[0]);
}

let timer = null;
function startClosedMonthMeasurementWorker(db = require("../db/db")) {
  if (timer) return;
  const run = () => runPendingClosedMonthMeasurements(db).catch((error) =>
    console.error("[ML Trial Orders] measurement worker failed:", error?.message || error));
  run();
  timer = setInterval(run, 60_000);
  timer.unref?.();
}

function stopClosedMonthMeasurementWorker() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = {
  queueClosedMonthMeasurement,
  processClosedMonthMeasurement,
  runPendingClosedMonthMeasurements,
  requeueFailedClosedMonthMeasurement,
  startClosedMonthMeasurementWorker,
  stopClosedMonthMeasurementWorker,
};
