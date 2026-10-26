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
  const window = await queueMissingCurrentPeriodMeasurements(db, options.now || new Date(), options);
  await db.query(
    `UPDATE ml_closed_month_order_measurements
        SET status = 'queued', updated_at = NOW()
      WHERE status = 'running' AND started_at < NOW() - INTERVAL '10 minutes'`
  );
  const pending = await db.query(
    `SELECT account_id, period_start
       FROM ml_closed_month_order_measurements
      WHERE status = 'queued' AND period_start = $1::date
      ORDER BY created_at
      LIMIT 20`,
    [window.periodStart]
  );
  const processRow = options.processRow || ((accountId, periodStart) =>
    processClosedMonthMeasurement(db, accountId, periodStart));
  for (const row of pending.rows) {
    const periodStart = new Date(row.period_start).toISOString().slice(0, 10);
    await processRow(Number(row.account_id), periodStart);
  }
  await syncPendingHubMeasurements(db, options);
  return pending.rows.length;
}

async function queueMissingCurrentPeriodMeasurements(db, now = new Date(), options = {}) {
  const window = previousClosedMonthWindow(now);
  const includePostpaid = options.includePostpaid === true;
  await db.query(
    `INSERT INTO ml_closed_month_order_measurements
       (account_id, period_start, period_end_exclusive, status)
     SELECT mc.id, $1::date, $2::date, 'queued'
       FROM meli_contas mc
      WHERE mc.status = 'ativa'
        AND (mc.billing_mode = 'trial' OR ($3::boolean AND mc.billing_mode = 'paid'))
     ON CONFLICT (account_id, period_start) DO NOTHING`,
    [window.periodStart, window.periodEndExclusive, includePostpaid]
  );
  return window;
}

async function postHubOrderMeasurement(payload, options = {}) {
  const baseUrl = String(options.baseUrl ?? process.env.HUB_BASE_URL ?? "").trim().replace(/\/+$/, "");
  const token = String(options.token ?? process.env.HUB_INTERNAL_TOKEN ?? "").trim();
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (!baseUrl || !token || typeof fetchImpl !== "function") throw new Error("hub_measurement_unavailable");
  const response = await fetchImpl(`${baseUrl}/v1/internal/resources/orders/measurement`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`hub_measurement_http_${response.status}`);
  const body = await response.json().catch(() => null);
  if (body?.ok !== true || body?.measurement?.resourceKey !== payload.resource_key) {
    throw new Error("hub_measurement_confirmation_invalid");
  }
}

async function syncPendingHubMeasurements(db, options = {}) {
  const window = previousClosedMonthWindow(options.now || new Date());
  const pending = await db.query(
    `SELECT m.account_id, m.period_start, m.period_end_exclusive,
            m.order_count, m.source, e.tenant_global_id, mc.meli_user_id
       FROM ml_closed_month_order_measurements m
       JOIN meli_contas mc ON mc.id = m.account_id
       JOIN empresas e ON e.id = mc.empresa_id
      WHERE m.status = 'succeeded' AND m.hub_synced_at IS NULL
        AND m.period_start = $1::date
        AND (m.hub_sync_attempts = 0 OR m.updated_at < NOW() - INTERVAL '5 minutes')
      ORDER BY m.measured_at
      LIMIT 20`,
    [window.periodStart]
  );
  const postMeasurement = options.postMeasurement || postHubOrderMeasurement;
  for (const row of pending.rows) {
    const accountId = Number(row.account_id);
    const periodStart = new Date(row.period_start).toISOString().slice(0, 10);
    try {
      const tenantId = String(row.tenant_global_id || "").trim();
      const sellerId = Number(row.meli_user_id);
      const count = Number(row.order_count);
      if (!tenantId || !Number.isSafeInteger(sellerId) || sellerId <= 0 ||
          !Number.isSafeInteger(count) || count < 0) throw new Error("hub_measurement_identity_invalid");
      await postMeasurement({
        tenant_id: tenantId,
        resource_key: `ml:${sellerId}`,
        status: "succeeded",
        period_start: periodStart,
        period_end_exclusive: new Date(row.period_end_exclusive).toISOString().slice(0, 10),
        order_count: count,
        source: String(row.source || ""),
      });
      await db.query(
        `UPDATE ml_closed_month_order_measurements
            SET hub_synced_at = NOW(), hub_sync_error = NULL, updated_at = NOW()
          WHERE account_id = $1 AND period_start = $2::date AND status = 'succeeded'`,
        [accountId, periodStart]
      );
    } catch (error) {
      await db.query(
        `UPDATE ml_closed_month_order_measurements
            SET hub_sync_attempts = hub_sync_attempts + 1,
                hub_sync_error = $3, updated_at = NOW()
          WHERE account_id = $1 AND period_start = $2::date AND status = 'succeeded'
            AND hub_synced_at IS NULL`,
        [accountId, periodStart, String(error?.message || "hub_measurement_failed").slice(0, 300)]
      );
    }
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
function startClosedMonthMeasurementWorker(db = require("../db/db"), options = {}) {
  if (timer) return;
  const run = () => runPendingClosedMonthMeasurements(db, options).catch((error) =>
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
  syncPendingHubMeasurements,
  queueMissingCurrentPeriodMeasurements,
  postHubOrderMeasurement,
  startClosedMonthMeasurementWorker,
  stopClosedMonthMeasurementWorker,
};
