"use strict";

const { previousClosedMonthWindow, countPaidOrders } = require("./closedMonthOrderMeasurement");

function date(value) {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error("shopee_orders_period_invalid");
  return parsed.toISOString().slice(0, 10);
}

function rangeForPaidOrders(total) {
  if (!Number.isSafeInteger(total) || total < 0) throw new Error("shopee_orders_total_invalid");
  if (total <= 30) return "up_to_30";
  if (total <= 200) return "from_31_to_200";
  if (total <= 700) return "from_201_to_700";
  if (total <= 1500) return "from_701_to_1500";
  if (total <= 3000) return "from_1501_to_3000";
  return "contact_sales";
}

function postpaidMeasurementEnabled() {
  return ["1", "true", "yes", "on"].includes(
    String(process.env.SELLER_POSTPAID_ACCOUNT_MEASUREMENT_ENABLED || "").trim().toLowerCase(),
  );
}

async function queueClosedMonthMeasurement(db, shopDbId, now = new Date()) {
  const id = Number(shopDbId);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error("shopee_orders_shop_invalid");
  const window = previousClosedMonthWindow(now);
  await db.query(
    `INSERT INTO shopee_closed_month_order_measurements
       (shop_db_id, period_start, period_end_exclusive, status)
     VALUES ($1, $2, $3, 'queued')
     ON CONFLICT (shop_db_id, period_start) DO NOTHING`,
    [id, date(window.periodStart), date(window.periodEndExclusive)],
  );
  return window;
}

async function queueMissingMeasurements(db, now = new Date(), { includePostpaid = false } = {}) {
  const window = previousClosedMonthWindow(now);
  await db.query(
    `INSERT INTO shopee_closed_month_order_measurements
       (shop_db_id, period_start, period_end_exclusive, status)
     SELECT DISTINCT candidates.shop_db_id, $1::date, $2::date, 'queued'
       FROM (
         SELECT s.id AS shop_db_id
           FROM public_trial_oauth_sessions t
           JOIN "Shop" s ON s.id = t.shop_db_id
          WHERE t.status = 'activated' AND s.status = 'AUTHORIZED'
         UNION
         SELECT s.id AS shop_db_id
           FROM "Shop" s
          WHERE $3::boolean AND s.status = 'AUTHORIZED'
       ) AS candidates
     ON CONFLICT (shop_db_id, period_start) DO NOTHING`,
    [date(window.periodStart), date(window.periodEndExclusive), Boolean(includePostpaid)],
  );
  return window;
}

async function processMeasurement(db, shopDbId, periodStart, options = {}) {
  const claimed = await db.query(
    `UPDATE shopee_closed_month_order_measurements AS m
        SET status = 'running', attempts = attempts + 1,
            started_at = NOW(), error_message = NULL, updated_at = NOW()
       FROM "Shop" s JOIN "Account" a ON a.id = s."accountId"
      WHERE m.shop_db_id = $1 AND m.period_start = $2::date
        AND m.shop_db_id = s.id AND m.status = 'queued'
      RETURNING m.shop_db_id, m.period_start, m.period_end_exclusive,
                s."shopId" AS shop_id, a."tenantGlobalId" AS tenant_id`,
    [shopDbId, periodStart],
  );
  const row = claimed.rows[0];
  if (!row) return { status: "skipped" };
  try {
    const countOrders = options.countOrders || countPaidOrders;
    const total = await countOrders({ shopId: String(row.shop_id), window: {
      periodStart: new Date(row.period_start).toISOString(),
      periodEndExclusive: new Date(row.period_end_exclusive).toISOString(),
    } });
    const rangeCode = rangeForPaidOrders(total);
    await db.query(
      `UPDATE shopee_closed_month_order_measurements
          SET status = 'succeeded', order_count = $3, range_code = $4,
              source = 'shopee_paid_orders_sync', measured_at = NOW(),
              error_message = NULL, updated_at = NOW()
        WHERE shop_db_id = $1 AND period_start = $2::date AND status = 'running'`,
      [shopDbId, periodStart, total, rangeCode],
    );
    return { status: "succeeded", total, rangeCode };
  } catch (error) {
    const message = String(error?.message || "shopee_orders_measurement_failed").slice(0, 300);
    await db.query(
      `UPDATE shopee_closed_month_order_measurements
          SET status = 'failed', error_message = $3, updated_at = NOW()
        WHERE shop_db_id = $1 AND period_start = $2::date AND status = 'running'`,
      [shopDbId, periodStart, message],
    );
    return { status: "failed", error: message };
  }
}

async function postHubOrderMeasurement(payload, options = {}) {
  const baseUrl = String(options.baseUrl ?? process.env.HUB_BASE_URL ?? "").trim().replace(/\/+$/, "");
  const token = String(options.token ?? process.env.HUB_INTERNAL_TOKEN ?? "").trim();
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (!baseUrl || !token || typeof fetchImpl !== "function") throw new Error("hub_measurement_unavailable");
  const response = await fetchImpl(`${baseUrl}/v1/internal/resources/orders/measurement`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(payload), signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`hub_measurement_http_${response.status}`);
  const body = await response.json().catch(() => null);
  if (body?.ok !== true || body?.measurement?.resourceKey !== payload.resource_key) {
    throw new Error("hub_measurement_confirmation_invalid");
  }
}

async function syncMeasurementToHub(db, now = new Date(), options = {}) {
  const window = previousClosedMonthWindow(now);
  const rows = await db.query(
    `SELECT m.shop_db_id, m.period_start, m.period_end_exclusive, m.order_count,
            m.source, s."shopId" AS shop_id, a."tenantGlobalId" AS tenant_id
       FROM shopee_closed_month_order_measurements m
       JOIN "Shop" s ON s.id = m.shop_db_id
       JOIN "Account" a ON a.id = s."accountId"
      WHERE m.status = 'succeeded' AND m.hub_synced_at IS NULL
        AND m.period_start = $1::date
        AND (m.hub_sync_attempts = 0 OR m.updated_at < NOW() - INTERVAL '5 minutes')
      ORDER BY m.measured_at LIMIT 20`,
    [date(window.periodStart)],
  );
  const postMeasurement = options.postMeasurement || postHubOrderMeasurement;
  for (const row of rows.rows) {
    const start = date(row.period_start);
    try {
      const tenantId = String(row.tenant_id || "").trim();
      const shopId = String(row.shop_id || "").trim();
      const total = Number(row.order_count);
      if (!tenantId || !/^\d+$/.test(shopId) || !Number.isSafeInteger(total) || total < 0) {
        throw new Error("hub_measurement_identity_invalid");
      }
      await postMeasurement({ tenant_id: tenantId, resource_key: `shopee:${shopId}`,
        status: "succeeded", period_start: start,
        period_end_exclusive: date(row.period_end_exclusive), order_count: total,
        source: String(row.source || ""), });
      await db.query(
        `UPDATE shopee_closed_month_order_measurements
            SET hub_synced_at = NOW(), hub_sync_error = NULL, updated_at = NOW()
          WHERE shop_db_id = $1 AND period_start = $2::date AND status = 'succeeded'`,
        [row.shop_db_id, start],
      );
    } catch (error) {
      await db.query(
        `UPDATE shopee_closed_month_order_measurements
            SET hub_sync_attempts = hub_sync_attempts + 1,
                hub_sync_error = $3, updated_at = NOW()
          WHERE shop_db_id = $1 AND period_start = $2::date
            AND status = 'succeeded' AND hub_synced_at IS NULL`,
        [row.shop_db_id, start, String(error?.message || "hub_measurement_failed").slice(0, 300)],
      );
    }
  }
  return rows.rows.length;
}

async function runPendingMeasurements(db, now = new Date(), options = {}) {
  const window = await queueMissingMeasurements(db, now, { includePostpaid: options.includePostpaid === true });
  await db.query(
    `UPDATE shopee_closed_month_order_measurements
        SET status = 'queued', updated_at = NOW()
      WHERE status = 'running' AND started_at < NOW() - INTERVAL '30 minutes'`,
  );
  await db.query(
    `UPDATE shopee_closed_month_order_measurements
        SET status = 'queued', updated_at = NOW()
      WHERE status = 'failed' AND attempts < 10
        AND updated_at < NOW() - INTERVAL '1 hour'
        AND period_start = $1::date`,
    [date(window.periodStart)],
  );
  const rows = await db.query(
    `SELECT shop_db_id, period_start FROM shopee_closed_month_order_measurements
      WHERE status = 'queued' AND period_start = $1::date
      ORDER BY created_at LIMIT 5`,
    [date(window.periodStart)],
  );
  for (const row of rows.rows) {
    await (options.processMeasurement || processMeasurement)(db, row.shop_db_id, date(row.period_start), options);
  }
  await syncMeasurementToHub(db, now, options);
  return rows.rows.length;
}

let timer;
let running = false;
function startClosedMonthMeasurementWorker(db) {
  if (timer) return () => stopClosedMonthMeasurementWorker();
  const source = db || require("../config/postgres");
  const run = async () => {
    if (running) return;
    running = true;
    try { await runPendingMeasurements(source, new Date(), { includePostpaid: postpaidMeasurementEnabled() }); }
    catch (error) { console.error("[Shopee Trial Orders] worker failed:", error?.message || error); }
    finally { running = false; }
  };
  void run();
  timer = setInterval(run, 60_000);
  timer.unref?.();
  return () => stopClosedMonthMeasurementWorker();
}

function stopClosedMonthMeasurementWorker() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { queueClosedMonthMeasurement, queueMissingMeasurements, processMeasurement, syncMeasurementToHub,
  postHubOrderMeasurement, runPendingMeasurements,
  startClosedMonthMeasurementWorker, stopClosedMonthMeasurementWorker };
