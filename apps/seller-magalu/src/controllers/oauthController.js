"use strict";

const env = require("../config/env");
const oauthStateRepository = require("../repositories/oauthStateRepository");
const accountRepository = require("../repositories/accountRepository");
const { enqueueTokenRefresh, enqueueCatalogSync, enqueueHubResourceSync } = require("../queues/magaluQueue");
const { refreshAccount } = require("../services/magaluTokenService");
const { checkHubAccess } = require("../services/hubAccessService");
const { checkAccountAccess } = require("../services/hubResourceAccessService");
const { readSuiteIdentity } = require("../middlewares/suiteAuth");
const {
  beginAuthorization,
  finishAuthorization,
  publicOAuthConfig,
} = require("../services/magaluOAuthService");
const {
  hashOAuthState,
  safeRedirectAfter,
  secureEqual,
} = require("../services/oauthSecurity");

const STATE_COOKIE = "magalu_oauth_state";

function isProduction() {
  return String(env.NODE_ENV || "").toLowerCase() === "production";
}

function stateCookieOptions(maxAgeMs) {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: isProduction(),
    path: "/magalu/auth/callback",
    maxAge: maxAgeMs,
  };
}

function parseCookies(header) {
  const result = {};
  for (const part of String(header || "").split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!key) continue;
    try { result[key] = decodeURIComponent(value); } catch (_error) { result[key] = value; }
  }
  return result;
}

function withOAuthResult(path, status, reason = null, accountId = null) {
  const target = new URL(safeRedirectAfter(path), "https://dachbyte.invalid");
  target.searchParams.set("oauth", status);
  if (reason) target.searchParams.set("reason", String(reason).slice(0, 80));
  if (accountId) target.searchParams.set("account", String(accountId));
  return `${target.pathname}${target.search}${target.hash}`;
}

function safeReason(error) {
  const code = String(error?.code || "").trim();
  const allowed = new Set([
    "MAGALU_OAUTH_NOT_CONFIGURED",
    "MAGALU_OAUTH_STATE_INVALID",
    "MAGALU_OAUTH_STATE_COOKIE_INVALID",
    "MAGALU_OAUTH_CODE_MISSING",
    "MAGALU_OAUTH_TIMEOUT",
    "MAGALU_TOKEN_SET_INCOMPLETE",
    "MAGALU_TOKEN_SUBJECT_MISSING",
    "MAGALU_TENANT_ALREADY_LINKED",
    "MAGALU_OAUTH_SESSION_REQUIRED",
    "MAGALU_OAUTH_IDENTITY_MISMATCH",
    "MAGALU_OAUTH_HUB_ACCESS_REVOKED",
    "access_denied",
  ]);
  return allowed.has(code) ? code.toLowerCase() : "oauth_failed";
}


function oauthError(code, message, status) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

async function revalidateCallbackAccess(req, stateRecord) {
  const session = readSuiteIdentity(req);
  if (!session.ok) throw oauthError("MAGALU_OAUTH_SESSION_REQUIRED", "A sessão DACH não está mais válida para concluir o OAuth Magalu.", 401);
  if (String(session.identity.dachTenantId) !== String(stateRecord.dach_tenant_id) || String(session.identity.dachUserId) !== String(stateRecord.dach_user_id)) {
    throw oauthError("MAGALU_OAUTH_IDENTITY_MISMATCH", "A sessão DACH atual não corresponde à sessão que iniciou o OAuth Magalu.", 403);
  }
  const hub = await checkHubAccess(session.identity, { force: true, action: "ACCESS magalu" });
  if (!hub.allow) throw oauthError("MAGALU_OAUTH_HUB_ACCESS_REVOKED", "O Hub não confirmou mais acesso ao módulo Magalu.", 403);
  return session.identity;
}

async function start(req, res, next) {
  try {
    const flow = await beginAuthorization({
      identity: req.magaluIdentity,
      redirectAfter: req.query?.return || "/magalu/contas",
    });
    const maxAge = Math.max(120, env.MAGALU_OAUTH_STATE_TTL_SECONDS) * 1000;
    res.cookie(STATE_COOKIE, flow.stateHash, stateCookieOptions(maxAge));
    return res.redirect(302, flow.authorizationUrl);
  } catch (error) {
    return next(error);
  }
}

async function callback(req, res) {
  const rawState = String(req.query?.state || "").trim();
  const code = String(req.query?.code || "").trim();
  const providerError = String(req.query?.error || "").trim();
  const stateHash = rawState ? hashOAuthState(rawState) : "";
  const cookieHash = String(parseCookies(req.headers.cookie)[STATE_COOKIE] || "").trim();
  res.clearCookie(STATE_COOKIE, { path: "/magalu/auth/callback" });

  if (!rawState || !stateHash || !cookieHash || !secureEqual(stateHash, cookieHash)) {
    return res.redirect(302, withOAuthResult("/magalu/contas", "error", "state_invalid"));
  }

  let stateRecord;
  try {
    stateRecord = await oauthStateRepository.consumeState(stateHash);
  } catch (_error) {
    return res.redirect(302, withOAuthResult("/magalu/contas", "error", "state_unavailable"));
  }
  if (!stateRecord) {
    return res.redirect(302, withOAuthResult("/magalu/contas", "error", "state_expired"));
  }

  const redirectAfter = safeRedirectAfter(stateRecord.redirect_after || "/magalu/contas");
  if (providerError) {
    return res.redirect(302, withOAuthResult(redirectAfter, "error", providerError === "access_denied" ? "access_denied" : "provider_error"));
  }
  if (!code) {
    return res.redirect(302, withOAuthResult(redirectAfter, "error", "code_missing"));
  }

  try {
    await revalidateCallbackAccess(req, stateRecord);
    const connected = await finishAuthorization({ stateRecord, code });
    // Refresh é feito pelo worker. O enqueue imediato serve apenas para garantir
    // que uma conexão com expiração atípica entre rapidamente no fluxo normal.
    if (connected?.accessExpiresAt && new Date(connected.accessExpiresAt).getTime() <= Date.now() + env.MAGALU_TOKEN_REFRESH_SKEW_SECONDS * 1000) {
      await enqueueTokenRefresh(connected.account.id).catch(() => {});
    }
    try {
      const syncJob = await enqueueCatalogSync(connected.account.id, { dachTenantId: stateRecord.dach_tenant_id, reason: "oauth_connected" });
      if (syncJob?.id) await accountRepository.setCatalogSyncState(connected.account.id, { status: "queued", error: null });
    } catch (syncError) {
      console.warn("[seller-magalu:oauth] initial catalog sync was not queued", { accountId: connected.account.id, message: syncError?.message || String(syncError) });
    }
    const hubAccount = await accountRepository.findAccountById(connected.account.id).catch(() => null);
    if (hubAccount?.hub_sync_status !== "synced") {
      let shouldSchedule = true;
      if (hubAccount?.hub_sync_status === "failed") {
        shouldSchedule = await accountRepository.markHubResourceSyncPendingIfFailed(connected.account.id).catch(() => false);
      }
      if (shouldSchedule) {
        try {
          const syncJob = await enqueueHubResourceSync(connected.account.id);
          if (syncJob?.scheduled) await accountRepository.markHubResourceSyncQueuedIfPending(connected.account.id);
        } catch (syncError) {
          console.warn("[seller-magalu:oauth] Hub resource sync was not queued", { accountId: connected.account.id, message: syncError?.message || String(syncError) });
        }
      }
    }
    return res.redirect(302, withOAuthResult(redirectAfter, "connected", null, connected.account.id));
  } catch (error) {
    console.error("[seller-magalu:oauth] callback failed", {
      code: error?.code || null,
      status: error?.status || null,
      message: error?.message || String(error),
    });
    return res.redirect(302, withOAuthResult(redirectAfter, "error", safeReason(error)));
  }
}

async function status(req, res) {
  const accounts = await authorizedAccounts(req.magaluIdentity);
  return res.json({
    ok: true,
    oauth: publicOAuthConfig(),
    accounts,
  });
}

async function authorizedAccounts(identity) {
  const accounts = await accountRepository.listAccountsForTenant(identity.dachTenantId);
  const checks = await Promise.all(accounts.map(async (account) => ({
    account,
    hub: await checkAccountAccess(identity, account, { action: "READ magalu" }),
  })));
  return checks.filter(({ hub }) => hub.allow).map(({ account }) => account);
}

async function accounts(req, res, next) {
  try {
    return res.json({ ok: true, accounts: await authorizedAccounts(req.magaluIdentity) });
  } catch (error) {
    return next(error);
  }
}

async function refresh(req, res, next) {
  try {
    const accountId = Number(req.params.accountId);
    if (!Number.isFinite(accountId) || accountId <= 0) {
      return res.status(400).json({ ok: false, error: "invalid_account_id" });
    }
    const account = await accountRepository.findAccountByIdForTenant(accountId, req.magaluIdentity.dachTenantId);
    if (!account) return res.status(404).json({ ok: false, error: "account_not_found" });
    const hub = await checkAccountAccess(req.magaluIdentity, account, { force: true, action: "WRITE magalu" });
    if (!hub.allow) return res.status(404).json({ ok: false, error: "account_not_found" });
    const result = await refreshAccount(accountId, { dachTenantId: req.magaluIdentity.dachTenantId });
    return res.json({
      ok: true,
      account_id: accountId,
      access_expires_at: result.accessExpiresAt || null,
      scopes: result.scopes || [],
    });
  } catch (error) {
    return next(error);
  }
}

module.exports = { start, callback, status, accounts, refresh, _test: { parseCookies, withOAuthResult, safeReason, revalidateCallbackAccess, authorizedAccounts } };
