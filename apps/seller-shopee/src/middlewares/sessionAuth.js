const {
  deleteSessionById,
  findShopForAccountById,
  findSessionWithUserAccountById,
} = require("../repositories/runtimeSqlRepository");
const { syncHubIdentity } = require("../../../../lib/hubIdentitySync");
const { getEffectiveShopeeRole } = require("../config/masterAdmin");
const { ensureShopResourceSynced } = require("../services/hubResourceBillingService");
const HUB_DISABLED_VALUES = new Set([
  "",
  "0",
  "false",
  "null",
  "undefined",
  "off",
  "none",
  "disabled",
  "(not set)",
]);

function normalizeHubConfigValue(raw) {
  const value = String(raw ?? "").trim();
  if (!value) return "";
  if (HUB_DISABLED_VALUES.has(value.toLowerCase())) {
    return "";
  }
  return value;
}

const HUB_BASE_URL = normalizeHubConfigValue(process.env.HUB_BASE_URL)
  .replace(/\/+$/, "");
const HUB_INTERNAL_TOKEN = normalizeHubConfigValue(process.env.HUB_INTERNAL_TOKEN);
const HUB_BYPASS_SUPER_ADMIN =
  String(process.env.SHOPEE_HUB_BYPASS_SUPER_ADMIN ?? "true").toLowerCase() ===
  "true";
const HUB_BILLING_ALLOW_TTL_MS = Number(
  process.env.HUB_BILLING_ALLOW_TTL_MS || 5 * 60 * 1000,
);
const HUB_BILLING_NEAR_EXPIRATION_TTL_MS = Number(
  process.env.HUB_BILLING_NEAR_EXPIRATION_TTL_MS || 60 * 1000,
);
const HUB_BILLING_DENY_TTL_MS = Number(
  process.env.HUB_BILLING_DENY_TTL_MS || 30 * 1000,
);
const HUB_BILLING_NEAR_EXPIRATION_MS = 7 * 24 * 60 * 60 * 1000;
const hubBillingCache = new Map();

const PUBLIC_PATHS = [
  "/login",
  "/activate",
  "/forgot-password",
  "/reset-password",
  "/auth/register",
  "/auth/activation-info",
  "/auth/activate",
  "/auth/forgot-password",
  "/auth/reset-info",
  "/auth/reset-password",
  "/status",
  "/healthz",
];

function getSid(req) {
  return req.cookies?.sid || null;
}

function getEffectiveRole(user) {
  return getEffectiveShopeeRole(user);
}

function isHubConfigured() {
  return Boolean(HUB_BASE_URL && HUB_INTERNAL_TOKEN);
}

function shouldFailClosedHubGate() {
  const raw = String(
    process.env.SHOPEE_HUB_GATE_MODE ||
      process.env.HUB_AUTH_MODE ||
      process.env.HUB_ENFORCEMENT ||
      "hybrid",
  )
    .trim()
    .toLowerCase();

  return ["strict", "enforce", "enabled"].includes(raw);
}

function allowHubGateBypass(reason, extra = {}) {
  return {
    allow: true,
    bypass: true,
    module: "shopee",
    reason,
    ...extra,
  };
}

function wantsHtml(req) {
  const accept = String(req.headers?.accept || "").toLowerCase();
  return (
    accept.includes("text/html") || accept.includes("application/xhtml+xml")
  );
}

function denyBillingAccess(req, res, extra = {}) {
  const message =
    extra.message ||
    "Assinatura inativa para este modulo.";

  if (req.method === "GET" && wantsHtml(req)) {
    return res.redirect("/selecao-plataforma?payment=required");
  }

  return res.status(402).json({
    error: "payment_required",
    code: "PAYMENT_REQUIRED",
    ...extra,
    message,
  });
}

function getHubBillingCacheKey(authContext) {
  return [
    String(authContext?.tenantGlobalId || "").trim(),
    String(authContext?.userGlobalId || "").trim(),
    "shopee",
  ].join(":");
}

function parseHubAccessExpiration(payload) {
  const raw = payload?.expires_at || payload?.ends_at || payload?.expiresAt || null;
  if (!raw) return null;
  const time = new Date(raw).getTime();
  return Number.isFinite(time) ? time : null;
}

function getHubBillingCacheTtl(result) {
  if (!result?.allow) return HUB_BILLING_DENY_TTL_MS;
  const expiresAt = parseHubAccessExpiration(result.payload);
  const now = Date.now();
  if (expiresAt && expiresAt <= now) return 0;
  const baseTtl =
    expiresAt && expiresAt - now <= HUB_BILLING_NEAR_EXPIRATION_MS
      ? HUB_BILLING_NEAR_EXPIRATION_TTL_MS
      : HUB_BILLING_ALLOW_TTL_MS;
  return expiresAt ? Math.max(0, Math.min(baseTtl, expiresAt - now)) : baseTtl;
}

function readFreshHubBillingCache(cacheKey) {
  const entry = hubBillingCache.get(cacheKey);
  if (!entry || entry.expiresAt <= Date.now()) return null;
  return { ...entry.result, cached: true };
}

function readStaleAllowedHubBillingCache(cacheKey) {
  const entry = hubBillingCache.get(cacheKey);
  if (!entry?.result?.allow) return null;
  if (entry.subscriptionExpiresAt && entry.subscriptionExpiresAt <= Date.now()) return null;
  return { ...entry.result, cached: true, stale: true };
}

function writeHubBillingCache(cacheKey, result) {
  const ttl = getHubBillingCacheTtl(result);
  if (ttl <= 0) {
    hubBillingCache.delete(cacheKey);
    return;
  }
  hubBillingCache.set(cacheKey, {
    result,
    expiresAt: Date.now() + ttl,
    subscriptionExpiresAt: parseHubAccessExpiration(result.payload),
  });
}

async function checkHubModuleAccess(req, authContext) {
  if (!isHubConfigured()) {
    return { allow: true, reason: "hub_not_configured" };
  }

  if (HUB_BYPASS_SUPER_ADMIN && authContext.role === "SUPER_ADMIN") {
    return { allow: true, reason: "super_admin_bypass" };
  }

  if (!authContext.tenantGlobalId || !authContext.userGlobalId) {
    if (!shouldFailClosedHubGate()) {
      return allowHubGateBypass("billing_identity_missing");
    }
    return { allow: false, reason: "billing_identity_missing" };
  }

  const cacheKey = getHubBillingCacheKey(authContext);
  const cachedAccess = readFreshHubBillingCache(cacheKey);
  if (cachedAccess) {
    return cachedAccess;
  }

  try {
    const syncResult = await syncHubIdentity({
      tenant_id: authContext.tenantGlobalId,
      company_name: String(authContext.accountName || "Davantti Shopee").trim(),
      user_id: authContext.userGlobalId,
      full_name: String(authContext.email || "Usuario Shopee").trim(),
      email: String(authContext.email || "").trim().toLowerCase(),
      role: authContext.role === "SUPER_ADMIN" || authContext.role === "ADMIN" ? "owner" : "operator",
      module: "shopee",
      modules: ["shopee"],
    }).catch((error) => {
      console.warn("[sessionAuth] Falha ao sincronizar identidade no hub:", error);
      return null;
    });

    const effectiveTenantId = String(
      syncResult?.payload?.tenant_id || authContext.tenantGlobalId,
    ).trim();
    const effectiveUserId = String(
      syncResult?.payload?.user_id || authContext.userGlobalId,
    ).trim();

    const response = await fetch(`${HUB_BASE_URL}/v1/access/check`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${HUB_INTERNAL_TOKEN}`,
      },
      body: JSON.stringify({
        tenant_id: effectiveTenantId,
        user_id: effectiveUserId,
        module: "shopee",
        action: `${req.method} ${req.path || ""}`.trim(),
      }),
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const staleAccess = readStaleAllowedHubBillingCache(cacheKey);
      if (staleAccess) {
        return staleAccess;
      }
      if (response.status === 401 || response.status === 403) {
        return { allow: true, reason: "hub_auth_invalid_bypass" };
      }
      return { allow: true, reason: "hub_access_check_failed_soft_allow" };
    }

    if (!payload?.allow) {
      const reason =
        payload?.reason || "subscription_inactive_or_module_not_allowed";
      const deniedAccess = {
        allow: false,
        reason,
        status: payload?.status || null,
        message: payload?.message || null,
        payload,
      };
      writeHubBillingCache(cacheKey, deniedAccess);
      return deniedAccess;
    }

    const allowedAccess = { allow: true, payload };
    writeHubBillingCache(cacheKey, allowedAccess);
    return allowedAccess;
  } catch (error) {
    console.error("[sessionAuth] Falha no Hub billing gate:", error);
    const staleAccess = readStaleAllowedHubBillingCache(cacheKey);
    if (staleAccess) {
      return staleAccess;
    }
    return { allow: true, reason: "hub_access_check_failed_soft_allow" };
  }
}

function hasShopeeEntitlement(hubAccess) {
  const modules = [
    ...(Array.isArray(hubAccess?.modules) ? hubAccess.modules : []),
    ...(Array.isArray(hubAccess?.seller_modules) ? hubAccess.seller_modules : []),
  ].map((module) => String(module || "").trim().toLowerCase());
  return modules.includes("shopee");
}

async function reconcileActiveShopWithHub(authContext, hubAccess) {
  if (
    !authContext?.activeShopId ||
    !authContext?.accountId ||
    !authContext?.tenantGlobalId ||
    !hasShopeeEntitlement(hubAccess)
  ) {
    return null;
  }

  const shop = await findShopForAccountById(
    Number(authContext.activeShopId),
    Number(authContext.accountId),
  );
  if (!shop?.shopId) return null;

  const result = await ensureShopResourceSynced({
    auth: authContext,
    shop,
    status: "active",
    billingMode: "paid",
    usagePolicy: "metered",
    rangeEnforcement: true,
    planCode: "shopee_pro",
    orderRangeCode: "up_to_30",
    account: {
      name: authContext.accountName || null,
      tenantGlobalId: authContext.tenantGlobalId,
    },
  });

  if (result?.bypass && result.reason !== "billing_off") {
    console.warn(
      "[sessionAuth] Hub nao confirmou a sincronizacao da loja Shopee:",
      result.reason || "unknown",
      `tenant=${authContext.tenantGlobalId}`,
      `shop=${String(shop.shopId)}`,
    );
  }
  return result;
}

async function sessionAuth(req, res, next) {
  console.log(`[sessionAuth] ${req.method} ${req.path}`); // ✅ LOG

  // ✅ Pular autenticação para rotas públicas
  if (PUBLIC_PATHS.includes(req.path)) {
    console.log(`[sessionAuth] Rota pública: ${req.path}, pulando`);
    req.auth = null;
    return next();
  }

  try {
    const sid = getSid(req);
    if (!sid) {
      console.log(`[sessionAuth] Sem cookie sid`);
      req.auth = null;
      return next();
    }

    const session = await findSessionWithUserAccountById(sid);

    if (!session) {
      console.log(`[sessionAuth] Sessão não encontrada: ${sid}`);
      req.auth = null;
      return next();
    }

    if (session.expiresAt && session.expiresAt.getTime() < Date.now()) {
      console.log(`[sessionAuth] Sessão expirada: ${sid}`);
      await deleteSessionById(sid).catch(() => {});
      req.auth = null;
      return next();
    }

    console.log(`[sessionAuth] Autenticado: ${session.user.email}`);
    req.auth = {
      sid: session.id,
      userId: session.user.id,
      email: session.user.email,
      role: getEffectiveRole(session.user),
      accountId: session.user.accountId,
      accountName: session.user.account?.name || null,
      tenantGlobalId: session.user.account?.tenantGlobalId || null,
      userGlobalId: session.user.userGlobalId || null,
      activeShopId: session.activeShopId || null,
      accountContextId: session.accountContextId || null,
      impersonating: Boolean(session.impersonating),
      realUserId: session.realUserId || null,
    };

    const billing = await checkHubModuleAccess(req, req.auth);
    if (!billing.allow) {
      req.auth = null;
      return denyBillingAccess(req, res, {
        reason: billing.reason,
        status: billing.status || null,
        message: billing.message || null,
      });
    }

    req.hubAccess = billing.payload || null;
    await reconcileActiveShopWithHub(req.auth, req.hubAccess).catch((error) => {
      console.warn(
        "[sessionAuth] Falha ao reconciliar loja Shopee com o Hub:",
        error?.code || error?.message || error,
      );
    });

    return next();
  } catch (err) {
    console.error(`[sessionAuth] Erro:`, err);
    return next(err);
  }
}

function requireAuth(req, res, next) {
  console.log(`[requireAuth] ${req.method} ${req.path} - auth:`, !!req.auth); // ✅ LOG

  if (!req.auth) {
    return res
      .status(401)
      .json({ error: "unauthorized", message: "Não autenticado." });
  }
  return next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.auth) {
      return res
        .status(401)
        .json({ error: "unauthorized", message: "Não autenticado." });
    }
    if (!roles.includes(req.auth.role)) {
      return res
        .status(403)
        .json({ error: "forbidden", message: "Sem permissão." });
    }
    return next();
  };
}

module.exports = {
  sessionAuth,
  requireAuth,
  requireRole,
};
