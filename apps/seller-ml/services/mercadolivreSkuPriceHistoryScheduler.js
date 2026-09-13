"use strict";

const db = require("../db/db");
const FinanceiroMlSkuCatalogSyncService = require("./financeiroMlSkuCatalogSyncService");
const { decryptToken } = require("./tokenCrypto");

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
let started = false;
let running = false;
let timer = null;

function weekStartSaoPaulo(now = new Date()) {
  const ymd = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  const date = new Date(`${ymd}T12:00:00Z`);
  const day = date.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  date.setUTCDate(date.getUTCDate() + diff);
  return date.toISOString().slice(0, 10);
}

async function getActiveAccounts(accountIds = null) {
  const params = [];
  let where = "where coalesce(mc.status, 'ativa') = 'ativa'";
  if (Array.isArray(accountIds) && accountIds.length) {
    params.push(accountIds.map(Number).filter((id) => Number.isFinite(id) && id > 0));
    where += ` and mc.id = any($${params.length}::bigint[])`;
  }

  const { rows } = await db.query(
    `select mc.id,
            mc.apelido,
            mc.meli_user_id,
            mc.site_id,
            mt.access_token,
            mt.access_expires_at,
            mt.refresh_token,
            mt.scope
       from meli_contas mc
       join meli_tokens mt on mt.meli_conta_id = mc.id
      ${where}
      order by mc.id asc`,
    params,
  );
  return rows || [];
}

async function getAccountsWithPriceHistorySince(weekStart) {
  const { rows } = await db.query(
    `select distinct account_key
       from ml.mercadolivre_sku_price_history
      where snapshot_date >= $1::date`,
    [weekStart],
  );
  return new Set((rows || []).map((row) => String(row.account_key || "")));
}

function buildCredsFromAccount(account) {
  return {
    app_id:
      process.env.ML_APP_ID ||
      process.env.APP_ID ||
      process.env.CLIENT_ID ||
      process.env.MERCADOLIBRE_APP_ID ||
      null,
    client_secret:
      process.env.ML_CLIENT_SECRET ||
      process.env.CLIENT_SECRET ||
      process.env.MERCADOLIBRE_CLIENT_SECRET ||
      null,
    redirect_uri:
      process.env.ML_REDIRECT_URI ||
      process.env.REDIRECT_URI ||
      process.env.MERCADOLIBRE_REDIRECT_URI ||
      null,
    meli_conta_id: account.id,
    account_key: String(account.id),
    accountKey: String(account.id),
    meli_user_id: account.meli_user_id,
    site_id: account.site_id || "MLB",
    access_token: account.access_token ? decryptToken(account.access_token) : null,
    refresh_token: account.refresh_token ? decryptToken(account.refresh_token) : null,
    access_expires_at: account.access_expires_at || null,
    scope: account.scope || null,
  };
}

async function enqueueWeeklySkuPriceHistory({ accountIds = null, force = false, now = new Date() } = {}) {
  const weekStart = weekStartSaoPaulo(now);
  const accounts = await getActiveAccounts(accountIds);
  const alreadyDone = force ? new Set() : await getAccountsWithPriceHistorySince(weekStart);
  const output = [];

  for (const account of accounts) {
    const accountKey = String(account.id);
    if (alreadyDone.has(accountKey)) {
      output.push({
        meli_conta_id: account.id,
        label: account.apelido || account.meli_user_id || accountKey,
        skipped: true,
        reason: "week_already_captured",
      });
      continue;
    }

    try {
      const job = await FinanceiroMlSkuCatalogSyncService.enqueue({
        accountKey,
        mlCreds: buildCredsFromAccount(account),
        userId: null,
      });
      output.push({
        meli_conta_id: account.id,
        label: account.apelido || account.meli_user_id || accountKey,
        ok: true,
        job_id: job?.job_id || null,
        already_running: !!job?.already_running,
      });
      console.log(`[Preco SKU ML] Sync semanal enfileirado conta=${account.id} job=${job?.job_id || "-"}`);
    } catch (error) {
      output.push({
        meli_conta_id: account.id,
        label: account.apelido || account.meli_user_id || accountKey,
        ok: false,
        error: error?.message || String(error),
      });
      console.error(`[Preco SKU ML] Falha ao enfileirar conta=${account.id}:`, error?.message || error);
    }
  }

  return {
    week_start: weekStart,
    total_accounts: accounts.length,
    enqueued: output.filter((item) => item.ok).length,
    skipped: output.filter((item) => item.skipped).length,
    accounts: output,
  };
}

async function withWeeklyPriceHistoryLock(fn) {
  const lockKey = "ml_weekly_sku_price_history";
  const lockedResult = await db.query(`select pg_try_advisory_lock(hashtext($1)) as locked`, [lockKey]);
  if (!lockedResult.rows?.[0]?.locked) {
    return { skipped: true, reason: "lock_not_acquired" };
  }
  try {
    return await fn();
  } finally {
    await db.query(`select pg_advisory_unlock(hashtext($1))`, [lockKey]).catch(() => null);
  }
}

async function runDueWeeklySkuPriceHistory(options = {}) {
  return withWeeklyPriceHistoryLock(async () => enqueueWeeklySkuPriceHistory(options));
}

async function checkWeeklySkuPriceHistory() {
  if (running) return;
  running = true;
  try {
    const result = await runDueWeeklySkuPriceHistory();
    if (!result?.skipped || result?.enqueued) {
      console.log("[Preco SKU ML] Scheduler semanal:", {
        enqueued: result?.enqueued || 0,
        skipped: result?.skipped || 0,
        total_accounts: result?.total_accounts || 0,
      });
    }
  } catch (error) {
    console.error("[Preco SKU ML] Falha no scheduler semanal:", error?.message || error);
  } finally {
    running = false;
  }
}

function startSkuPriceHistoryScheduler() {
  if (started) return;
  if (String(process.env.ML_SKU_PRICE_HISTORY_SCHEDULER || "1") === "0") {
    console.log("[Preco SKU ML] Scheduler semanal desativado por env.");
    return;
  }

  started = true;
  timer = setInterval(checkWeeklySkuPriceHistory, CHECK_INTERVAL_MS);
  if (timer.unref) timer.unref();
  setTimeout(checkWeeklySkuPriceHistory, 120 * 1000).unref?.();
  console.log("[Preco SKU ML] Scheduler semanal ativo.");
}

module.exports = {
  enqueueWeeklySkuPriceHistory,
  runDueWeeklySkuPriceHistory,
  startSkuPriceHistoryScheduler,
  weekStartSaoPaulo,
};
