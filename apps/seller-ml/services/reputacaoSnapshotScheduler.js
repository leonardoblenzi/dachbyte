"use strict";

const db = require("../db/db");
const ReputacaoService = require("./reputacaoService");
const { decryptToken } = require("./tokenCrypto");

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
let started = false;
let running = false;
let timer = null;

function currentDateSaoPaulo(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

async function getActiveAccountsForReputationSnapshots(accountIds = null) {
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

async function getSnapshotAccountIdsForDate(snapshotDate) {
  const { rows } = await db.query(
    `select distinct meli_conta_id
       from ml.reputation_snapshots
      where snapshot_date = $1::date
        and meli_conta_id is not null`,
    [snapshotDate],
  );

  return new Set((rows || []).map((row) => Number(row.meli_conta_id)).filter(Boolean));
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

async function generateReputationSnapshotForAccount(account) {
  const overview = await ReputacaoService.obterVisaoGeral({
    mlCreds: buildCredsFromAccount(account),
    forceRefresh: true,
    page: 1,
    pageSize: 25,
    logger: console,
  });

  return {
    seller_id: overview?.seller?.id || account.meli_user_id || null,
    status: overview?.intelligence?.status || null,
    metrics: overview?.seller?.metric_cards || null,
    history: overview?.intelligence?.history || null,
  };
}

async function generateDailyReputationSnapshots({ accountIds = null, onlyMissing = true, now = new Date() } = {}) {
  const snapshotDate = currentDateSaoPaulo(now);
  const accounts = await getActiveAccountsForReputationSnapshots(accountIds);
  const existingIds = onlyMissing ? await getSnapshotAccountIdsForDate(snapshotDate) : new Set();
  const targetAccounts = accounts.filter((account) => !existingIds.has(Number(account.id)));
  const output = [];

  for (const account of targetAccounts) {
    try {
      const snapshot = await generateReputationSnapshotForAccount(account);
      output.push({
        meli_conta_id: account.id,
        label: account.apelido || account.meli_user_id || String(account.id),
        ok: true,
        snapshot,
      });
      console.log(`[Reputacao] Snapshot diario conta=${account.id} ok`);
    } catch (error) {
      output.push({
        meli_conta_id: account.id,
        label: account.apelido || account.meli_user_id || String(account.id),
        ok: false,
        error: error?.message || String(error),
      });
      console.error(`[Reputacao] Snapshot conta=${account.id} falhou:`, error?.message || error);
    }
  }

  return {
    snapshot_date: snapshotDate,
    total_accounts: accounts.length,
    already_done: existingIds.size,
    processed: output.length,
    skipped: accounts.length - targetAccounts.length,
    accounts: output,
  };
}

async function withReputationSnapshotAdvisoryLock(fn) {
  const lockKey = "ml_reputation_daily_snapshots";
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

async function runDueDailyReputationSnapshots({ now = new Date(), accountIds = null } = {}) {
  return withReputationSnapshotAdvisoryLock(async () => {
    const result = await generateDailyReputationSnapshots({
      accountIds,
      onlyMissing: true,
      now,
    });

    if (!result.processed) {
      return { skipped: true, reason: "already_complete", ...result };
    }

    return result;
  });
}

async function checkDailyReputationSnapshots() {
  if (running) return;
  running = true;
  try {
    const result = await runDueDailyReputationSnapshots();
    if (!result?.skipped || result?.processed) {
      console.log("[Reputacao] Scheduler de snapshots diario:", {
        processed: result?.processed || 0,
        skipped: result?.skipped || 0,
        total_accounts: result?.total_accounts || 0,
      });
    }
  } catch (error) {
    console.error("[Reputacao] Falha no scheduler de snapshots:", error?.message || error);
  } finally {
    running = false;
  }
}

function startReputationSnapshotScheduler() {
  if (started) return;
  if (String(process.env.ML_REPUTATION_SNAPSHOT_SCHEDULER || "1") === "0") {
    console.log("[Reputacao] Scheduler de snapshots desativado por env.");
    return;
  }

  started = true;
  timer = setInterval(checkDailyReputationSnapshots, CHECK_INTERVAL_MS);
  if (timer.unref) timer.unref();
  setTimeout(checkDailyReputationSnapshots, 90 * 1000).unref?.();
  console.log("[Reputacao] Scheduler de snapshots diarios ativo.");
}

module.exports = {
  checkDailyReputationSnapshots,
  generateDailyReputationSnapshots,
  getActiveAccountsForReputationSnapshots,
  runDueDailyReputationSnapshots,
  startReputationSnapshotScheduler,
};
