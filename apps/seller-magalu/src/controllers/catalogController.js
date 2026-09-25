"use strict";

const accountRepository = require("../repositories/accountRepository");
const catalogRepository = require("../repositories/catalogRepository");
const syncRunRepository = require("../repositories/syncRunRepository");
const webhookRepository = require("../repositories/webhookRepository");
const { enqueueCatalogSync, enqueueCatalogReconcile } = require("../queues/magaluQueue");
const { checkAccountAccess } = require("../services/hubResourceAccessService");
const { runPortfolioDiagnostics } = require("../services/catalogDiagnosticsService");

function int(value, fallback = 0) {
  const parsed = Number.parseInt(String(value == null ? "" : value), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function resolveAccount(req) {
  const accountId = int(req.query?.account_id || req.body?.account_id || req.params?.accountId, 0);
  if (accountId <= 0) {
    const error = new Error("Selecione uma conta Magalu.");
    error.code = "MAGALU_ACCOUNT_REQUIRED";
    error.status = 400;
    throw error;
  }
  const account = await accountRepository.findAccountByIdForTenant(accountId, req.magaluIdentity.dachTenantId);
  if (!account) {
    const error = new Error("Conta Magalu não encontrada para este tenant DACH.");
    error.code = "MAGALU_ACCOUNT_NOT_FOUND";
    error.status = 404;
    throw error;
  }
  return account;
}

function accountNotFoundError() {
  const error = new Error("Conta Magalu não encontrada para este tenant DACH.");
  error.code = "MAGALU_ACCOUNT_NOT_FOUND";
  error.status = 404;
  return error;
}

async function requireReadAccess(req, account, { force = false } = {}) {
  const options = { action: "READ magalu" };
  if (force) options.force = true;
  const hub = await checkAccountAccess(req.magaluIdentity, account, options);
  if (!hub.allow) throw accountNotFoundError();
  return hub;
}

async function status(req, res, next) {
  try {
    const account = await resolveAccount(req);
    await requireReadAccess(req, account);
    const [stats, latestRun, subscriptions] = await Promise.all([
      catalogRepository.stats(account.id),
      syncRunRepository.latestRun(account.id),
      webhookRepository.listSubscriptionsForAccount(account.id),
    ]);
    return res.json({
      ok: true,
      account: {
        id: account.id,
        magalu_tenant_id: account.magalu_tenant_id,
        magalu_tenant_name: account.magalu_tenant_name,
        status: account.status,
        scopes: Array.isArray(account.scopes) ? account.scopes : [],
        access_expires_at: account.access_expires_at || null,
        refresh_expires_at: account.refresh_expires_at || null,
        last_refresh_at: account.last_refresh_at || null,
        last_refresh_error: account.last_refresh_error || null,
        catalog_sync_status: account.catalog_sync_status,
        catalog_last_synced_at: account.catalog_last_synced_at,
        catalog_last_error: account.catalog_last_error,
      },
      stats,
      latest_run: latestRun,
      webhooks: {
        endpoint: "/magalu/webhooks/v1",
        expected_topics: ["portfolios_sku", "portfolios_price", "portfolios_stock"],
        subscriptions,
        active_count: subscriptions.filter((row) => row.status === "active").length,
      },
    });
  } catch (error) {
    return next(error);
  }
}

async function list(req, res, next) {
  try {
    const account = await resolveAccount(req);
    await requireReadAccess(req, account);
    const result = await catalogRepository.listCatalog(account.id, {
      query: req.query?.q || "",
      status: req.query?.status || "",
      offset: int(req.query?.offset, 0),
      limit: int(req.query?.limit, 50),
      onlyPresent: String(req.query?.include_missing || "0") !== "1",
    });
    return res.json({ ok: true, ...result });
  } catch (error) {
    return next(error);
  }
}

async function detail(req, res, next) {
  try {
    const account = await resolveAccount(req);
    await requireReadAccess(req, account);
    const sku = String(req.params.sku || "").trim();
    if (!sku) return res.status(400).json({ ok: false, error: "sku_required" });
    const item = await catalogRepository.getCatalogItem(account.id, sku);
    if (!item) return res.status(404).json({ ok: false, error: "sku_not_found" });
    return res.json({ ok: true, item });
  } catch (error) {
    return next(error);
  }
}

async function sync(req, res, next) {
  try {
    const account = await resolveAccount(req);
    await requireReadAccess(req, account, { force: true });
    if (account.status !== "active") return res.status(409).json({ ok: false, error: "account_not_active" });
    const job = await enqueueCatalogSync(account.id, {
      dachTenantId: req.magaluIdentity.dachTenantId,
      reason: "manual_ui",
    });
    await accountRepository.setCatalogSyncState(account.id, { status: "queued", error: null });
    return res.status(202).json({ ok: true, job_id: job.id, account_id: account.id });
  } catch (error) {
    return next(error);
  }
}

async function diagnostics(req, res, next) {
  try {
    const account = await resolveAccount(req);
    await requireReadAccess(req, account, { force: true });
    if (account.status !== "active") return res.status(409).json({ ok: false, error: "account_not_active" });
    const report = await runPortfolioDiagnostics(account);
    return res.json({ ok: true, report });
  } catch (error) {
    return next(error);
  }
}

async function reconcile(req, res, next) {
  try {
    const account = await resolveAccount(req);
    await requireReadAccess(req, account);
    const sku = String(req.params.sku || "").trim();
    if (!sku) return res.status(400).json({ ok: false, error: "sku_required" });
    const job = await enqueueCatalogReconcile(account.id, sku, { topic: "manual" });
    return res.status(202).json({ ok: true, job_id: job.id, account_id: account.id, sku });
  } catch (error) {
    return next(error);
  }
}

async function runs(req, res, next) {
  try {
    const account = await resolveAccount(req);
    await requireReadAccess(req, account);
    const rows = await syncRunRepository.listRuns(account.id, int(req.query?.limit, 10));
    return res.json({ ok: true, runs: rows });
  } catch (error) {
    return next(error);
  }
}

module.exports = { status, list, detail, sync, diagnostics, reconcile, runs, _test: { int } };
