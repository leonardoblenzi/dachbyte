"use strict";

const env = require("../config/env");
const integrationRepository = require("../repositories/integrationHealthRepository");
const accountRepository = require("../repositories/accountRepository");
const { runPortfolioDiagnostics } = require("./catalogDiagnosticsService");
const magaluApiClient = require("./magaluApiClient");
const { refreshAccount } = require("./magaluTokenService");
const { checkHubAccess } = require("./hubAccessService");
const { resourceKeyForAccount } = require("./hubResourceAccessService");
const { enqueueHubResourceSync } = require("../queues/magaluQueue");
const { ensureRedisConnected } = require("../config/redis");
const { appendAuditEvent } = require("../repositories/auditRepository");

function text(value, max = 500) {
  return String(value == null ? "" : value).trim().slice(0, max);
}
function uniq(values) {
  return Array.from(new Set((Array.isArray(values) ? values : []).map((v) => text(v, 300)).filter(Boolean)));
}
function includesAll(granted, required) {
  const set = new Set(uniq(granted));
  return uniq(required).every((scope) => set.has(scope));
}
function scopeStatus(account) {
  const granted = uniq(account?.scopes);
  const configured = uniq(env.MAGALU_OAUTH_SCOPES);
  const reads = uniq(env._CATALOG_READ_SCOPES || env._DEFAULT_READ_SCOPES);
  const orderReads = uniq(env._ORDER_READ_SCOPES || []);
  const invoiceReads = uniq(env._INVOICE_READ_SCOPES || []);
  const invoiceWrites = uniq(env._INVOICE_WRITE_SCOPES || []);
  const finishWrites = uniq(env._DELIVERY_FINISH_WRITE_SCOPES || []);
  const protectedWrites = uniq(env._DEFAULT_WRITE_SCOPES);
  const skuWrite = env._SKU_WRITE_SCOPE;
  const missingConfigured = configured.filter((scope) => !granted.includes(scope));
  return {
    granted,
    configured,
    missing_configured: missingConfigured,
    reconnect_required: missingConfigured.length > 0,
    groups: {
      catalog_read: { enabled: true, required: reads, ok: includesAll(granted, reads) },
      orders_read: { enabled: true, required: orderReads, ok: includesAll(granted, orderReads) },
      invoice_read: { enabled: true, required: invoiceReads, ok: includesAll(granted, invoiceReads) },
      invoice_write: { enabled: env.MAGALU_INVOICE_WRITE_ENABLED === true, required: invoiceWrites, ok: includesAll(granted, invoiceWrites) },
      delivery_finish_write: { enabled: env.MAGALU_DELIVERY_WRITE_ENABLED === true, required: finishWrites, ok: includesAll(granted, finishWrites) },
      price_stock_write: { enabled: env.MAGALU_WRITE_ENABLED === true, required: protectedWrites, ok: includesAll(granted, protectedWrites) },
      sku_write: { enabled: env.MAGALU_SKU_WRITE_ENABLED === true, required: [skuWrite], ok: granted.includes(skuWrite) },
    },
  };
}
function tokenStatus(account) {
  const now = Date.now();
  const accessMs = account?.access_expires_at ? new Date(account.access_expires_at).getTime() : 0;
  const refreshMs = account?.refresh_expires_at ? new Date(account.refresh_expires_at).getTime() : 0;
  let access = "missing";
  if (accessMs > 0) access = accessMs <= now ? "expired" : accessMs <= now + 30 * 60 * 1000 ? "expiring" : "valid";
  let refresh = account?.refresh_expires_at ? (refreshMs <= now ? "expired" : "valid") : "unknown";
  if (!account?.access_expires_at && !account?.last_refresh_at && !account?.last_refresh_attempt_at) refresh = "unknown";
  return {
    access,
    refresh,
    access_expires_at: account?.access_expires_at || null,
    refresh_expires_at: account?.refresh_expires_at || null,
    last_refresh_at: account?.last_refresh_at || null,
    last_refresh_attempt_at: account?.last_refresh_attempt_at || null,
    last_refresh_error: text(account?.last_refresh_error, 1000) || null,
  };
}
function publicOAuthConfig() {
  return {
    configured: Boolean(env.MAGALU_OAUTH_CLIENT_ID && env.MAGALU_OAUTH_CLIENT_SECRET && env.MAGALU_OAUTH_REDIRECT_URI),
    redirect_uri: env.MAGALU_OAUTH_REDIRECT_URI || null,
    requested_scopes: uniq(env.MAGALU_OAUTH_SCOPES),
    write_enabled: env.MAGALU_WRITE_ENABLED === true,
    sku_write_enabled: env.MAGALU_SKU_WRITE_ENABLED === true,
    invoice_write_enabled: env.MAGALU_INVOICE_WRITE_ENABLED === true,
    delivery_write_enabled: env.MAGALU_DELIVERY_WRITE_ENABLED === true,
  };
}
async function redisProbe() {
  const started = Date.now();
  const redis = await ensureRedisConnected();
  const pong = await redis.ping();
  return { ok: String(pong).toUpperCase() === "PONG", latency_ms: Date.now() - started };
}
function safeProbeError(error) {
  return { ok: false, error: text(error?.code || error?.message || error, 500) || "unavailable" };
}
function masterIdentityForAccount(account, actor) {
  return {
    dachTenantId: String(account.dach_tenant_id),
    dachUserId: String(actor?.userId || actor?.dachUserId || ""),
  };
}
async function hubChecks(account, actor) {
  const identity = masterIdentityForAccount(account, actor);
  if (!identity.dachUserId) return { read: { allow: false, reason: "master_user_missing" }, write: { allow: false, reason: "master_user_missing" } };
  const resourceKey = resourceKeyForAccount(account);
  const [read, write] = await Promise.all([
    checkHubAccess(identity, { action: "READ magalu", resourceKey, force: true }),
    checkHubAccess(identity, { action: "WRITE magalu", resourceKey, force: true }),
  ]);
  return {
    read: { allow: read.allow === true, reason: read.reason || null },
    write: { allow: write.allow === true, reason: write.reason || null },
    resource_key: resourceKey,
    note: "O Hub atual exige action, mas a política de platform_admin/module_master ainda não diferencia uma capability ADMIN_WRITE própria.",
  };
}
async function assertMasterAccountAccess(account, actor, action = "ACCESS magalu") {
  const identity = masterIdentityForAccount(account, actor);
  const result = await checkHubAccess(identity, { action, resourceKey: resourceKeyForAccount(account), force: true });
  if (result.allow === true) return result;
  const error = new Error("O Hub não confirmou acesso Master à conta Magalu para esta ação.");
  error.status = 403;
  error.code = "MAGALU_MASTER_ACCOUNT_HUB_DENIED";
  throw error;
}
function remoteWebhookRow(row) {
  return {
    id: text(row?.id, 500) || null,
    topic: text(row?.topic, 200) || null,
    url: text(row?.url, 1000) || null,
    driver: text(row?.driver, 100) || null,
    created_at: row?.created_at || null,
    updated_at: row?.updated_at || null,
  };
}
async function listRemoteWebhooks(account) {
  const rows = [];
  for (let offset = 0; offset < 500; offset += 100) {
    const response = await magaluApiClient.request(`/v0/onboarding/signup?_limit=100&_offset=${offset}`, {
      method: "GET",
      accountId: account.id,
      dachTenantId: account.dach_tenant_id,
      attempts: 2,
      timeoutMs: 12_000,
    });
    const page = Array.isArray(response?.data) ? response.data : Array.isArray(response?.data?.results) ? response.data.results : [];
    rows.push(...page.map(remoteWebhookRow));
    if (page.length < 100) break;
  }
  return rows;
}
function webhookKey(topic, url) {
  return `${text(topic, 200).toLowerCase()}|${text(url, 1000).replace(/\/+$/, "").toLowerCase()}`;
}
function compareWebhooks(localRows, remoteRows) {
  const local = (Array.isArray(localRows) ? localRows : []).map((row) => ({
    id: row.id,
    topic: text(row.topic, 200),
    url: text(row.webhook_url, 1000),
    status: text(row.status, 80),
    subscription_external_id: text(row.subscription_external_id, 500) || null,
    last_synced_at: row.last_synced_at || null,
  }));
  const remote = (Array.isArray(remoteRows) ? remoteRows : []).map(remoteWebhookRow);
  const localMap = new Map(local.map((row) => [webhookKey(row.topic, row.url), row]));
  const remoteMap = new Map(remote.map((row) => [webhookKey(row.topic, row.url), row]));
  const matched = [], localOnly = [], remoteOnly = [];
  for (const [key, row] of localMap) {
    if (remoteMap.has(key)) matched.push({ local: row, remote: remoteMap.get(key) });
    else localOnly.push(row);
  }
  for (const [key, row] of remoteMap) if (!localMap.has(key)) remoteOnly.push(row);
  return { matched, local_only: localOnly, remote_only: remoteOnly, drift: localOnly.length + remoteOnly.length > 0 };
}
function decorateAccount(row) {
  return {
    ...row,
    scopes_health: scopeStatus(row),
    token_health: tokenStatus(row),
  };
}

async function overview(actorIdentity) {
  const [summary, accounts, database, redis, hub] = await Promise.all([
    integrationRepository.summary(),
    integrationRepository.listAccounts(),
    integrationRepository.probeDatabase().catch(safeProbeError),
    redisProbe().catch(safeProbeError),
    actorIdentity?.dachTenantId && actorIdentity?.dachUserId
      ? checkHubAccess(actorIdentity, { action: "ACCESS magalu", force: true }).then((r) => ({ ok: r.allow === true, allow: r.allow === true, reason: r.reason || null })).catch(safeProbeError)
      : Promise.resolve({ ok: false, allow: false, reason: "identity_missing" }),
  ]);
  const decorated = accounts.map(decorateAccount);
  return {
    checked_at: new Date().toISOString(),
    infrastructure: { database, redis, hub },
    oauth: publicOAuthConfig(),
    summary: {
      ...summary,
      reconnect_required: decorated.filter((row) => row.scopes_health.reconnect_required).length,
      token_attention: decorated.filter((row) => ["missing","expired","expiring"].includes(row.token_health.access) || row.token_health.refresh === "expired").length,
    },
    accounts: decorated,
  };
}

async function accountDetails(accountId) {
  const snapshot = await integrationRepository.accountSnapshot(accountId);
  if (!snapshot) return null;
  return { ...snapshot, scopes_health: scopeStatus(snapshot.account), token_health: tokenStatus(snapshot.account), oauth: publicOAuthConfig() };
}

async function diagnoseAccount(accountId, actor) {
  const snapshot = await integrationRepository.accountSnapshot(accountId);
  if (!snapshot) {
    const error = new Error("Conta Magalu não encontrada."); error.status = 404; error.code = "MAGALU_MASTER_ACCOUNT_NOT_FOUND"; throw error;
  }
  const account = snapshot.account;
  await assertMasterAccountAccess(account, actor, "ACCESS magalu");
  const [portfolio, hub, remoteWebhooks, database, redis] = await Promise.all([
    runPortfolioDiagnostics(account).catch((error) => ({ checked_at: new Date().toISOString(), ok: false, error: text(error?.message || error, 500) })),
    hubChecks(account, actor).catch((error) => ({ read: safeProbeError(error), write: safeProbeError(error), resource_key: resourceKeyForAccount(account) })),
    listRemoteWebhooks(account).then((rows) => ({ ok: true, rows })).catch((error) => ({ ok: false, rows: [], error: text(error?.message || error, 500), status: Number(error?.status || 0) || null, request_id: error?.requestId || null })),
    integrationRepository.probeDatabase().catch(safeProbeError),
    redisProbe().catch(safeProbeError),
  ]);
  const comparison = remoteWebhooks.ok ? compareWebhooks(snapshot.subscriptions, remoteWebhooks.rows) : null;
  const result = {
    checked_at: new Date().toISOString(),
    account: { id: account.id, dach_tenant_id: account.dach_tenant_id, magalu_tenant_id: account.magalu_tenant_id, magalu_tenant_name: account.magalu_tenant_name, status: account.status },
    scopes: scopeStatus(account),
    tokens: tokenStatus(account),
    hub,
    portfolio,
    webhooks: { remote: remoteWebhooks, comparison, local_events: snapshot.webhook_events },
    infrastructure: { database, redis },
  };
  await appendAuditEvent({ action:"MASTER_INTEGRATION_DIAGNOSTIC", category:"admin", outcome:"success", accountId:account.id, dachTenantId:account.dach_tenant_id, dachUserId:actor?.userId || null, magaluTenantId:account.magalu_tenant_id, source:"magalu-master", details:{ webhook_drift:comparison?.drift ?? null, missing_scopes:result.scopes.missing_configured, catalog_access_ok:portfolio?.catalog_access_ok ?? null, hub_read:hub?.read?.allow ?? null, hub_write:hub?.write?.allow ?? null } }).catch(()=>{});
  return result;
}

async function refreshOAuth(accountId, actor) {
  const account = await accountRepository.findAccountById(accountId);
  if (!account) { const error=new Error("Conta Magalu não encontrada."); error.status=404; error.code="MAGALU_MASTER_ACCOUNT_NOT_FOUND"; throw error; }
  await assertMasterAccountAccess(account, actor, "ACCESS magalu");
  const refreshed = await refreshAccount(account.id, { dachTenantId: account.dach_tenant_id });
  await appendAuditEvent({ action:"MASTER_OAUTH_REFRESH", category:"admin", outcome:"success", accountId:account.id, dachTenantId:account.dach_tenant_id, dachUserId:actor?.userId || null, magaluTenantId:account.magalu_tenant_id, source:"magalu-master", details:{ access_expires_at:refreshed.accessExpiresAt || null, scopes:refreshed.scopes || [] } }).catch(()=>{});
  return { account_id:account.id, access_expires_at:refreshed.accessExpiresAt || null, scopes:refreshed.scopes || [] };
}

async function reconcileHub(accountId, actor) {
  const account = await accountRepository.findAccountById(accountId);
  if (!account) { const error=new Error("Conta Magalu não encontrada."); error.status=404; error.code="MAGALU_MASTER_ACCOUNT_NOT_FOUND"; throw error; }
  await assertMasterAccountAccess(account, actor, "ACCESS magalu");
  const job = await enqueueHubResourceSync(account.id);
  await appendAuditEvent({ action:"MASTER_HUB_RESOURCE_RECONCILE_QUEUED", category:"admin", outcome:"success", accountId:account.id, dachTenantId:account.dach_tenant_id, dachUserId:actor?.userId || null, magaluTenantId:account.magalu_tenant_id, source:"magalu-master", details:{ job_id:job?.id || null, scheduled:job?.scheduled ?? null } }).catch(()=>{});
  return { queued:true, account_id:account.id, job_id:job?.id || null, scheduled:job?.scheduled ?? null };
}

async function reconcileWebhooks(accountId, actor) {
  const snapshot = await integrationRepository.accountSnapshot(accountId);
  if (!snapshot) { const error=new Error("Conta Magalu não encontrada."); error.status=404; error.code="MAGALU_MASTER_ACCOUNT_NOT_FOUND"; throw error; }
  const account = snapshot.account;
  await assertMasterAccountAccess(account, actor, "ACCESS magalu");
  const remote = await listRemoteWebhooks(account);
  const comparison = compareWebhooks(snapshot.subscriptions, remote);
  const touched = await integrationRepository.recordWebhookReconcile(account.id, comparison);
  await appendAuditEvent({ action:"MASTER_WEBHOOK_RECONCILE", category:"admin", outcome:comparison.drift?"info":"success", accountId:account.id, dachTenantId:account.dach_tenant_id, dachUserId:actor?.userId || null, magaluTenantId:account.magalu_tenant_id, source:"magalu-master", details:{ mode:"read_only_remote", matched:comparison.matched.length, local_only:comparison.local_only.length, remote_only:comparison.remote_only.length, local_rows_touched:touched } }).catch(()=>{});
  return { checked_at:new Date().toISOString(), mode:"read_only_remote", touched_local_metadata:touched, comparison };
}

module.exports = {
  overview,
  accountDetails,
  diagnoseAccount,
  refreshOAuth,
  reconcileHub,
  reconcileWebhooks,
  _test: { uniq, includesAll, scopeStatus, tokenStatus, publicOAuthConfig, webhookKey, compareWebhooks, masterIdentityForAccount },
};
