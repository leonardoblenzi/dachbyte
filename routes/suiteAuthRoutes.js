"use strict";

const express = require("express");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");

const router = express.Router();

const TIMEZONE = "America/Sao_Paulo";
const SUITE_JWT_SECRET =
  String(process.env.SUITE_JWT_SECRET || "").trim() ||
  String(process.env.ML_JWT_SECRET || "").trim() ||
  String(process.env.JWT_SECRET || "").trim();

const HUB_BASE_URL = String(process.env.HUB_BASE_URL || "")
  .trim()
  .replace(/\/+$/, "");
const HUB_INTERNAL_TOKEN = String(process.env.HUB_INTERNAL_TOKEN || "").trim();
const MASTER_ADMIN_EMAIL = String(
  process.env.MASTER_ADMIN_EMAIL || "",
)
  .trim()
  .toLowerCase();

const MODULE_MATRIX = [
  { id: "ml", hubModule: "ml" },
  { id: "shopee", hubModule: "shopee" },
  { id: "magalu", hubModule: "magalu" },
  { id: "tracking", hubModule: "tracking" },
  { id: "davanttilog", hubModule: "davanttilog" },
  { id: "madeiramadeira", hubModule: "madeira" },
  { id: "skuleader", hubModule: "skuleader" },
  { id: "dach_ads", hubModule: "dach_ads" },
];
const HUB_AUTH_MODULE_CANDIDATES = [
  "suite",
  "ml",
  "shopee",
  "magalu",
  "tracking",
  "davanttilog",
  "madeira",
  "skuleader",
  "dach_ads",
];
const HUB_ACCESS_RETRY_ATTEMPTS = Number(
  process.env.HUB_ACCESS_RETRY_ATTEMPTS || 3,
);
const HUB_ACCESS_RETRY_DELAY_MS = Number(
  process.env.HUB_ACCESS_RETRY_DELAY_MS || 260,
);

if (!SUITE_JWT_SECRET) {
  throw new Error(
    "SUITE_JWT_SECRET nao definido. Configure SUITE_JWT_SECRET (ou fallback JWT_SECRET).",
  );
}

function isProduction() {
  return String(process.env.NODE_ENV || "").toLowerCase() === "production";
}

function authCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: isProduction(),
    maxAge: 24 * 60 * 60 * 1000,
    path: "/",
  };
}

function nowIso() {
  return new Date().toISOString();
}

function todayKey(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function isPlatformIdentityPayload(payload = {}) {
  const context = String(payload.context || "").trim().toLowerCase();
  const reason = String(payload.reason || "").trim().toLowerCase();
  return (
    context === "platform" ||
    reason === "platform_admin" ||
    reason === "platform_module_master"
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getHubLoginMode() {
  return String(process.env.HUB_LOGIN_MODE || "fallback")
    .trim()
    .toLowerCase();
}

function isLegacyFallbackEnabled() {
  const mode = getHubLoginMode();
  return mode === "fallback" || mode === "mirror";
}

function pickIdentity(payload = {}, fallbackEmail = "") {
  const userId = String(payload.user_id || "").trim();
  const email = normalizeEmail(payload.email || fallbackEmail);
  const name = String(payload.name || payload.full_name || email || "Usuario").trim();
  const tenantId =
    String(payload.tenant_id || "").trim() ||
    (isPlatformIdentityPayload(payload) && userId ? `platform-${userId}` : "");

  if (!tenantId || !userId || !email) return null;
  return { tenantId, userId, email, name };
}

function normalizeRenewableResources(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => item && typeof item === "object")
    .map((item) => ({
      resource_key: String(item.resource_key || "").trim(),
      module_slug: String(item.module_slug || "").trim().toLowerCase(),
      module_label: String(item.module_label || "").trim(),
      external_account_id: String(item.external_account_id || "").trim(),
      label: String(item.label || item.external_account_id || "").trim(),
      checkout_ready: item.checkout_ready === true || item.selectable === true,
      selectable: item.selectable === true || item.checkout_ready === true,
      is_unlimited: item.is_unlimited === true,
      renewal_status: String(item.renewal_status || "").trim(),
      renewal_url: String(item.renewal_url || "").trim() || null,
      order_range_code: String(item.order_range_code || "").trim() || null,
      recommended_range_code: String(item.recommended_range_code || "").trim() || null,
      range_label: String(item.range_label || "").trim() || null,
      measured_orders:
        item.measured_orders === null || item.measured_orders === undefined
          ? null
          : Number(item.measured_orders),
      subscription_ends_at: item.subscription_ends_at || null,
      days_until_expiration:
        item.days_until_expiration === null || item.days_until_expiration === undefined
          ? null
          : Number(item.days_until_expiration),
    }))
    .filter((item) => item.resource_key && item.module_slug);
}
function buildSubscriptionSession(payload = {}) {
  const status = String(payload.subscription_status || "").trim().toLowerCase();
  const active = payload.subscription_active === true;
  const daysUntilExpiration =
    payload.days_until_expiration === null || payload.days_until_expiration === undefined
      ? null
      : Number(payload.days_until_expiration);

  return {
    status: status || null,
    active,
    starts_at: payload.starts_at || null,
    expires_at: payload.expires_at || null,
    days_until_expiration: Number.isFinite(daysUntilExpiration)
      ? daysUntilExpiration
      : null,
    renewal_url: String(payload.renewal_url || "").trim() || null,
    renewable_resources: normalizeRenewableResources(payload.renewable_resources),
  };
}

function buildMasterSubscriptionSession(previous = null) {
  return {
    status: "active",
    active: true,
    starts_at: previous?.starts_at || null,
    expires_at: null,
    days_until_expiration: null,
    renewal_url: null,
    renewable_resources: [],
    is_master: true,
  };
}

function buildSessionSubscriptionCookiePayload(subscription = {}) {
  return {
    status: String(subscription.status || "").trim().toLowerCase() || null,
    active: subscription.active === true,
    starts_at: subscription.starts_at || null,
    expires_at: subscription.expires_at || null,
    days_until_expiration:
      subscription.days_until_expiration === null ||
      subscription.days_until_expiration === undefined
        ? null
        : Number(subscription.days_until_expiration),
    is_master: subscription.is_master === true,
  };
}

function refreshSuiteAuthCookie(res, previousPayload, refreshed) {
  const checkedAt = nowIso();
  const checkedDate = todayKey();
  const identity = refreshed.identity || {};
  const token = jwt.sign(
    {
      tenant_id: identity.tenantId,
      user_id: identity.userId,
      email: identity.email,
      name: identity.name,
      allowed_modules: refreshed.allowedModules,
      visible_modules: refreshed.visibleModules,
      subscription: buildSessionSubscriptionCookiePayload(refreshed.subscription),
      entitlements_checked_at: checkedAt,
      entitlements_date: checkedDate,
      entitlements_tz: TIMEZONE,
      auth_source: previousPayload.auth_source || "hub_refreshed",
    },
    SUITE_JWT_SECRET,
    { expiresIn: "24h" },
  );

  res.cookie("suite_auth_token", token, authCookieOptions());
  return { checkedAt, checkedDate };
}

function isLegacySuitePayload(payload = {}) {
  const source = String(payload.auth_source || "").trim().toLowerCase();
  const tenantId = String(payload.tenant_id || "").trim().toLowerCase();
  return source === "legacy" || source === "legacy_module_login" || tenantId.startsWith("legacy-tenant-");
}

function daysUntilDate(value) {
  if (!value) return null;
  const end = new Date(value);
  if (Number.isNaN(end.getTime())) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const endDay = new Date(end);
  endDay.setHours(0, 0, 0, 0);
  return Math.ceil((endDay.getTime() - today.getTime()) / 86400000);
}

function suiteModuleFromHubModule(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "madeira") return "madeiramadeira";
  if (normalized === "rastreio" || normalized === "avantracking") return "tracking";
  if (
    normalized === "logisync" ||
    normalized === "logsync" ||
    normalized === "davantti-log" ||
    normalized === "davantti_log" ||
    normalized === "davantti log"
  ) return "davanttilog";
  return normalized;
}

function buildSubscriptionFromAccessCheck(payload = {}, previous = null) {
  const status = String(payload.status || previous?.status || "").trim().toLowerCase();
  const subscriptionActive =
    payload?.checks?.subscription_active === true ||
    status === "active" ||
    status === "trial";
  const expiresAt = payload.expires_at || previous?.expires_at || null;

  return {
    status: status || null,
    active: subscriptionActive,
    starts_at: payload.starts_at || previous?.starts_at || null,
    expires_at: expiresAt,
    days_until_expiration: daysUntilDate(expiresAt),
    renewal_url:
      String(payload.renewal_url || "").trim() ||
      String(previous?.renewal_url || "").trim() ||
      null,
    renewable_resources: normalizeRenewableResources(payload.renewable_resources).length
      ? normalizeRenewableResources(payload.renewable_resources)
      : normalizeRenewableResources(previous?.renewable_resources),
  };
}

async function refreshSuiteSessionPayload(payload) {
  if (isLegacySuitePayload(payload)) {
    return { legacy: true };
  }

  const tenantId = String(payload?.tenant_id || "").trim();
  const userId = String(payload?.user_id || "").trim();
  const email = normalizeEmail(payload?.email);
  if (!tenantId || !userId || !email) return null;

  const result = await resolveGlobalIdentityByEmail(email);

  if (!result?.ok) {
    return isTransientHubResult(result) ? { unavailable: true } : null;
  }

  const data = result.payload || {};
  if (!data.allow) return null;

  const identity = pickIdentity(data, email);
  if (!identity || identity.email !== email) return null;

  const hubModules = Array.isArray(data.modules) ? data.modules : [];
  const visibleModules = hubModules.map(suiteModuleFromHubModule).filter(Boolean);
  const isMaster = isMasterIdentity(identity, data);
  const subscription = isMaster
    ? buildMasterSubscriptionSession(payload.subscription || null)
    : buildSubscriptionSession(data);
  const fallbackVisibleModules = Array.isArray(payload.visible_modules)
    ? payload.visible_modules
    : [];
  // A master can manage only its own product. Never revive a broad, stale
  // suite session for a master when the Hub did not return a module.
  const effectiveVisibleModules = isMaster
    ? visibleModules
    : visibleModules.length
      ? visibleModules
      : fallbackVisibleModules;
  const effectiveAllowedModules = subscription.active ? effectiveVisibleModules : [];

  return {
    identity,
    visibleModules: effectiveVisibleModules,
    allowedModules: effectiveAllowedModules,
    subscription,
  };
}

async function callHub(path, body) {
  if (!HUB_BASE_URL || !HUB_INTERNAL_TOKEN) {
    return { ok: false, status: 503, payload: { reason: "hub_not_configured" } };
  }

  const response = await fetch(`${HUB_BASE_URL}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${HUB_INTERNAL_TOKEN}`,
    },
    body: JSON.stringify(body || {}),
  });
  const payload = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, payload };
}

function isTransientHubResult(result) {
  const status = Number(result?.status || 0);
  const reason = String(result?.payload?.reason || result?.payload?.error || "")
    .trim()
    .toLowerCase();

  return (
    status === 0 ||
    status === 408 ||
    status === 429 ||
    status >= 500 ||
    reason === "hub_access_check_failed" ||
    reason === "hub_unavailable" ||
    reason === "hub_unreachable"
  );
}

async function callHubWithRetry(path, body, attempts = HUB_ACCESS_RETRY_ATTEMPTS) {
  const totalAttempts = Math.max(1, Number(attempts) || 1);
  let last = null;

  for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
    const result = await callHub(path, body).catch((error) => ({
      ok: false,
      status: 0,
      payload: { reason: "hub_unreachable", details: error?.message || String(error) },
    }));
    last = result;

    if (!isTransientHubResult(result) || attempt === totalAttempts) {
      return result;
    }

    await sleep(HUB_ACCESS_RETRY_DELAY_MS * attempt);
  }

  return last || { ok: false, status: 0, payload: { reason: "hub_unreachable" } };
}

async function verifyLogin(email, password) {
  return callHub("/v1/internal/auth/verify", {
    email,
    password,
    module: "suite",
  });
}

async function resolveGlobalIdentityByEmail(email) {
  let last = null;

  for (const moduleName of HUB_AUTH_MODULE_CANDIDATES) {
    const result = await callHubWithRetry("/v1/internal/auth/resolve", {
      email,
      module: moduleName,
    });
    last = result;
    if (result?.ok && result.payload?.allow) return result;
    if (isTransientHubResult(result)) return result;
  }

  return last || { ok: false, status: 401, payload: { reason: "user_not_found" } };
}

function isInvalidCredentialReason(reason) {
  const normalized = String(reason || "").trim().toLowerCase();
  return (
    normalized === "invalid_credentials" ||
    normalized === "bad_password" ||
    normalized === "user_not_found" ||
    normalized === "hub_denied"
  );
}

function normalizeLoginFailureReason(loginResult) {
  const payload = loginResult?.payload || {};
  const explicitReason = String(payload.reason || "").trim();
  if (explicitReason) return explicitReason;

  const fallbackError = String(payload.error || "").trim();
  if (fallbackError) {
    if (fallbackError === "unauthorized") return "hub_internal_unauthorized";
    return fallbackError;
  }

  const status = Number(loginResult?.status || 0);
  if (status === 401 || status === 403) return "hub_internal_unauthorized";
  if (status >= 500) return "hub_unavailable";
  return "auth_failed";
}

async function verifyLoginWithFallback(email, password) {
  let firstInvalid = null;
  let last = null;

  for (const moduleName of HUB_AUTH_MODULE_CANDIDATES) {
    const result = await callHub("/v1/internal/auth/verify", {
      email,
      password,
      module: moduleName,
    });
    last = result;
    if (result.ok && result.payload?.allow) return result;
    if (!firstInvalid && isInvalidCredentialReason(result.payload?.reason)) {
      firstInvalid = result;
    }
  }

  return (
    firstInvalid ||
    last || {
      ok: false,
      status: 401,
      payload: { reason: "invalid_credentials" },
    }
  );
}

function appOriginFromRequest(req) {
  const configuredOrigin = String(
    process.env.PUBLIC_APP_ORIGIN || process.env.APP_PUBLIC_URL || "",
  )
    .trim()
    .replace(/\/+$/, "");
  if (configuredOrigin) return configuredOrigin;
  const proto = String(req.headers["x-forwarded-proto"] || req.protocol || "http")
    .split(",")[0]
    .trim();
  return `${proto}://${req.get("host")}`;
}

function legacyIdentityFromEmail(email) {
  const normalized = normalizeEmail(email);
  const hash = crypto
    .createHash("sha1")
    .update(normalized)
    .digest("hex")
    .slice(0, 24);
  return {
    tenantId: `legacy-tenant-${hash}`,
    userId: `legacy-user-${hash}`,
    email: normalized,
    name: normalized || "Usuario",
  };
}

async function tryLegacySuiteLogin(req, email, password) {
  if (!isLegacyFallbackEnabled()) {
    return { ok: false, reason: "legacy_fallback_disabled", modules: [] };
  }

  const origin = appOriginFromRequest(req);
  const checks = [
    { id: "ml", path: "/ml/api/auth/login", module: "ml" },
    { id: "shopee", path: "/shopee/api/auth/login", module: "shopee" },
    { id: "tracking", path: "/avantracking/api/users/login", module: "avantracking" },
    { id: "davanttilog", path: "/davanttilog/api/auth/login", module: "davanttilog" },
    { id: "madeiramadeira", path: "/madeiramadeira/api/auth/login", module: "madeira" },
    { id: "skuleader", path: "/skuleader/api/auth/login", module: "skuleader" },
  ];

  const allowedModules = [];
  let firstUser = null;

  for (const item of checks) {
    try {
      const response = await fetch(`${origin}${item.path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email,
          senha: password,
          password,
          module: item.module,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      const ok = isLegacyLoginSuccess(response, payload);
      if (!ok) continue;

      allowedModules.push(item.id);
      if (!firstUser && payload?.user) {
        firstUser = payload.user;
      }
    } catch (_error) {
      // segue para os outros modulos
    }
  }

  if (!allowedModules.length) {
    return { ok: false, reason: "legacy_credentials_invalid", modules: [] };
  }

  const identity = legacyIdentityFromEmail(email);
  return {
    ok: true,
    identity: {
      ...identity,
      name: String(firstUser?.nome || firstUser?.name || identity.name || email).trim(),
    },
    modules: allowedModules,
    source: "legacy_module_login",
  };
}

function isLegacyLoginSuccess(response, payload) {
  if (!response?.ok) return false;

  if (payload && typeof payload === "object") {
    if (payload.ok === false || payload.success === false) return false;
    if (payload.ok === true || payload.success === true) return true;
    if (payload.token || payload.access_token) return true;
    if (payload.user || payload.id) return true;
    if (payload.redirect) return true;
    if (payload.error) return false;
  }

  return true;
}

function isMasterIdentity(identity, payload = {}) {
  const email = String(identity?.email || "").trim().toLowerCase();
  const role = String(
    payload?.role || payload?.nivel || payload?.account_role || "",
  )
    .trim()
    .toLowerCase();
  const accountType = String(payload?.account_type || "")
    .trim()
    .toLowerCase();

  if (isPlatformIdentityPayload(payload)) return true;
  if (email && email === MASTER_ADMIN_EMAIL) return true;
  if (accountType === "master") return true;
  if (role === "admin_master" || role === "super_admin" || role === "owner") return true;
  return false;
}

async function resolveAllowedModules(identity) {
  const checks = await Promise.all(
    MODULE_MATRIX.map(async (entry) => {
      const res = await callHubWithRetry("/v1/access/check", {
        tenant_id: identity.tenantId,
        user_id: identity.userId,
        module: entry.hubModule,
        action: "LOGIN",
      });

      return {
        id: entry.id,
        allowed: Boolean(res.ok && res.payload?.allow),
        transient: isTransientHubResult(res),
        status: Number(res.status || 0) || null,
        reason: String(res.payload?.reason || res.payload?.error || "").trim() || null,
      };
    }),
  );

  const unresolved = checks.filter((item) => item.transient);
  if (unresolved.length) {
    const details = unresolved
      .map((item) => `${item.id}:${item.status || item.reason || "unknown"}`)
      .join(", ");
    throw new Error(`Hub access check incompleto para modulos: ${details}`);
  }

  return checks.filter((item) => item.allowed).map((item) => item.id);
}

router.post("/login", express.json({ limit: "200kb" }), async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.senha || req.body?.password || "");

    if (!email || !password) {
      return res.status(400).json({
        ok: false,
        error: "Informe e-mail e senha.",
      });
    }

    const login = await verifyLoginWithFallback(email, password);
    if (!login.ok || !login.payload?.allow) {
      const legacy = await tryLegacySuiteLogin(req, email, password);
      if (legacy.ok && legacy.identity) {
        const resolvedGlobal = await resolveGlobalIdentityByEmail(email).catch(() => null);
        if (resolvedGlobal?.ok && resolvedGlobal.payload?.allow) {
          const globalIdentity = pickIdentity(resolvedGlobal.payload, email);
          if (globalIdentity) {
            const subscription = buildSubscriptionSession(resolvedGlobal.payload);
            const visibleModules = Array.isArray(resolvedGlobal.payload?.modules)
              ? resolvedGlobal.payload.modules
                  .map((item) => suiteModuleFromHubModule(item))
                  .filter(Boolean)
              : [];
            const allowedModules = subscription.active ? visibleModules : [];
            const checkedAt = nowIso();
            const checkedDate = todayKey();
            const token = jwt.sign(
              {
                tenant_id: globalIdentity.tenantId,
                user_id: globalIdentity.userId,
                email: globalIdentity.email,
                name: globalIdentity.name,
                allowed_modules: allowedModules,
                visible_modules: visibleModules,
                subscription: buildSessionSubscriptionCookiePayload(subscription),
                entitlements_checked_at: checkedAt,
                entitlements_date: checkedDate,
                entitlements_tz: TIMEZONE,
                auth_source: "hub_global_verified",
              },
              SUITE_JWT_SECRET,
              { expiresIn: "24h" },
            );

            res.cookie("suite_auth_token", token, authCookieOptions());
            return res.json({
              ok: true,
              user: {
                email: globalIdentity.email,
                name: globalIdentity.name,
              },
              entitlements: {
                date: checkedDate,
                timezone: TIMEZONE,
                modules: allowedModules,
                visibleModules,
                subscription,
              },
              redirect: "/selecao-plataforma",
              auth_source: "hub_global_verified",
            });
          }
        }

        const checkedAt = nowIso();
        const checkedDate = todayKey();
        const token = jwt.sign(
          {
            tenant_id: legacy.identity.tenantId,
            user_id: legacy.identity.userId,
            email: legacy.identity.email,
            name: legacy.identity.name,
            allowed_modules: legacy.modules,
            visible_modules: legacy.modules,
            subscription: {
              status: "active",
              active: true,
              starts_at: null,
              expires_at: null,
              days_until_expiration: null,
              renewal_url: null,
            },
            entitlements_checked_at: checkedAt,
            entitlements_date: checkedDate,
            entitlements_tz: TIMEZONE,
            auth_source: legacy.source || "legacy",
          },
          SUITE_JWT_SECRET,
          { expiresIn: "24h" },
        );

        res.cookie("suite_auth_token", token, authCookieOptions());
        return res.json({
          ok: true,
          user: {
            email: legacy.identity.email,
            name: legacy.identity.name,
          },
          entitlements: {
            date: checkedDate,
            timezone: TIMEZONE,
            modules: legacy.modules,
            visibleModules: legacy.modules,
            subscription: {
              status: "active",
              active: true,
              starts_at: null,
              expires_at: null,
              days_until_expiration: null,
              renewal_url: null,
            },
          },
          redirect: "/selecao-plataforma",
          auth_source: legacy.source || "legacy",
        });
      }

      const reason = normalizeLoginFailureReason(login);
      const isCredentialFailure = isInvalidCredentialReason(reason);
      const status = isCredentialFailure
        ? 401
        : reason === "subscription_inactive_or_module_not_allowed"
          ? 403
          : 503;
      const errorMessage = isCredentialFailure
        ? "Credenciais invalidas."
        : reason === "subscription_inactive_or_module_not_allowed"
          ? "Acesso sem modulo liberado ou assinatura inativa."
          : "Falha na integracao de autenticacao com o Hub.";

      return res.status(status).json({
        ok: false,
        error: errorMessage,
        reason,
        hub_status: Number(login.status || 0) || null,
      });
    }

    const identity = pickIdentity(login.payload, email);
    if (!identity) {
      return res.status(403).json({
        ok: false,
        error: "Identidade global incompleta para login da suite.",
      });
    }

    let subscription = buildSubscriptionSession(login.payload);
    const visibleModules = Array.isArray(login.payload?.modules)
      ? login.payload.modules.map((item) => suiteModuleFromHubModule(item)).filter(Boolean)
      : [];
    const isMaster = isMasterIdentity(identity, login.payload);
    if (isMaster) {
      subscription = buildMasterSubscriptionSession(subscription);
    }
    const allowedModules = subscription.active
      ? isMaster
        ? visibleModules
        : await resolveAllowedModules(identity)
      : [];
    const sessionVisibleModules = isMaster
      ? visibleModules
      : visibleModules.length
        ? visibleModules
        : allowedModules;
    const checkedAt = nowIso();
    const checkedDate = todayKey();

    const token = jwt.sign(
      {
        tenant_id: identity.tenantId,
        user_id: identity.userId,
        email: identity.email,
        name: identity.name,
        allowed_modules: allowedModules,
        visible_modules: sessionVisibleModules,
        subscription: buildSessionSubscriptionCookiePayload(subscription),
        entitlements_checked_at: checkedAt,
        entitlements_date: checkedDate,
        entitlements_tz: TIMEZONE,
      },
      SUITE_JWT_SECRET,
      { expiresIn: "24h" },
    );

    res.cookie("suite_auth_token", token, authCookieOptions());

    return res.json({
      ok: true,
      user: {
        email: identity.email,
        name: identity.name,
      },
      entitlements: {
        date: checkedDate,
        timezone: TIMEZONE,
        modules: allowedModules,
        visibleModules: sessionVisibleModules,
        subscription,
      },
      redirect: "/selecao-plataforma",
    });
  } catch (error) {
    const details = error?.message || String(error);
    if (details.includes("Hub access check incompleto")) {
      return res.status(503).json({
        ok: false,
        error:
          "Nao foi possivel confirmar todos os modulos no Hub. Tente novamente em instantes.",
        reason: "hub_access_check_incomplete",
        details,
      });
    }

    return res.status(500).json({
      ok: false,
      error: "Falha ao autenticar na suite.",
      details,
    });
  }
});

router.post("/logout", (_req, res) => {
  res.clearCookie("suite_auth_token", { path: "/" });
  return res.json({ ok: true, redirect: "/login" });
});

router.get("/me", async (req, res) => {
  const token = String(req.cookies?.suite_auth_token || "").trim();
  if (!token) {
    return res.status(401).json({ ok: false, error: "Nao autenticado." });
  }

  try {
    const payload = jwt.verify(token, SUITE_JWT_SECRET);
    const refreshed = await refreshSuiteSessionPayload(payload).catch(() => null);
    if (!refreshed && !isLegacySuitePayload(payload)) {
      res.clearCookie("suite_auth_token", { path: "/" });
      return res.status(401).json({
        ok: false,
        error: "Sessao expirada. Entre novamente para atualizar seus acessos.",
        redirect: "/login",
      });
    }

    const refreshUnavailable = refreshed?.unavailable === true;
    const effectiveRefresh = refreshUnavailable || refreshed?.legacy === true
      ? null
      : refreshed;

    const allowedModules = effectiveRefresh?.allowedModules ||
      (Array.isArray(payload.allowed_modules) ? payload.allowed_modules : []);
    const visibleModules = effectiveRefresh?.visibleModules ||
      (Array.isArray(payload.visible_modules)
        ? payload.visible_modules
        : Array.isArray(payload.allowed_modules)
          ? payload.allowed_modules
          : []);
    const refreshedSession = effectiveRefresh
      ? refreshSuiteAuthCookie(res, payload, effectiveRefresh)
      : null;

    return res.json({
      ok: true,
      user: {
        email: effectiveRefresh?.identity?.email || payload.email || null,
        name: effectiveRefresh?.identity?.name || payload.name || null,
      },
      entitlements: {
        date: refreshedSession?.checkedDate || payload.entitlements_date || null,
        timezone: payload.entitlements_tz || TIMEZONE,
        checkedAt: refreshedSession?.checkedAt || payload.entitlements_checked_at || null,
        modules: allowedModules,
        visibleModules,
        subscription: effectiveRefresh?.subscription || payload.subscription || null,
        refreshPending: refreshUnavailable,
      },
    });
  } catch (_error) {
    res.clearCookie("suite_auth_token", { path: "/" });
    return res.status(401).json({ ok: false, error: "Sessao invalida." });
  }
});

module.exports = router;
