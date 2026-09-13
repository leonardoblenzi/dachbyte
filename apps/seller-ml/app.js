// ml/app.js
"use strict";

const express = require("express");
const path = require("path");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const db = require("./db/db");
const { syncHubIdentity } = require("../../lib/hubIdentitySync");
const {
  corsOptionsDelegate,
  createOriginGuard,
} = require("./middleware/security");
const { patchHtmlSendFile } = require("./utils/htmlFirstPaintGuard");

// Middlewares próprios
const ensureAccount = require("./middleware/ensureAccount");
const { authMiddleware } = require("./middleware/authMiddleware");
const { ensureAuth } = require("./middleware/ensureAuth");

// Bootstrap MASTER (idempotente)
const { ensureMasterUser } = require("./services/bootstrapMaster");
const {
  startRankingSnapshotScheduler,
} = require("./services/rankingAnunciosSnapshotScheduler");
const {
  startReputationSnapshotScheduler,
} = require("./services/reputacaoSnapshotScheduler");
const {
  startSkuPriceHistoryScheduler,
} = require("./services/mercadolivreSkuPriceHistoryScheduler");
const {
  startEstrategicosReviewScheduler,
} = require("./services/estrategicosReviewScheduler");
const {
  startAutomationReportScheduler,
} = require("./services/automationReportSchedulerService");
const { startHubUsageReporter } = require("./services/hubUsageReporter");
const {
  startReportRetentionCleanup,
} = require("./services/adminMeliAccountPerformanceReportService");
const { startAnuncioDraftCleanupScheduler } = require("./services/anuncioCadastro/anuncioDraftCleanupScheduler");

module.exports = function createMlApp() {
  const app = express();

  app.set("trust proxy", 1);
  app.set("etag", false);

  const CANONICAL_ORIGIN_RAW = String(
    process.env.ML_PUBLIC_ORIGIN ||
      process.env.PUBLIC_APP_ORIGIN ||
      process.env.APP_PUBLIC_URL ||
      "",
  ).trim();
  let CANONICAL_ORIGIN = "";
  let CANONICAL_HOST = "";
  try {
    if (CANONICAL_ORIGIN_RAW) {
      const parsed = new URL(CANONICAL_ORIGIN_RAW);
      CANONICAL_ORIGIN = parsed.origin;
      CANONICAL_HOST = String(parsed.host || "").toLowerCase();
    }
  } catch {
    CANONICAL_ORIGIN = "";
    CANONICAL_HOST = "";
  }

  function hostFromReq(req) {
    return String(req.headers?.["x-forwarded-host"] || req.headers?.host || "")
      .split(",")[0]
      .trim()
      .toLowerCase();
  }

  function isRenderHost(host) {
    return /\.onrender\.com$/i.test(String(host || ""));
  }

  // ========================
  // Middlewares básicos
  // ========================
  app.use(express.json({ limit: "10mb" }));
  app.use(express.urlencoded({ extended: true }));

  // Mantém o fluxo de login/ativação/vinculação no host canônico quando
  // o usuário cai em link antigo de subdomínio onrender.
  app.use((req, res, next) => {
    if (!CANONICAL_ORIGIN || !CANONICAL_HOST) return next();
    if (req.method !== "GET" && req.method !== "HEAD") return next();

    const reqHost = hostFromReq(req);
    if (!reqHost || reqHost === CANONICAL_HOST) return next();
    if (!isRenderHost(reqHost) || isRenderHost(CANONICAL_HOST)) return next();

    const targetPath = String(req.originalUrl || req.url || "/");
    return res.redirect(302, `${CANONICAL_ORIGIN}${targetPath}`);
  });

  app.use(cors(corsOptionsDelegate));
  app.use(cookieParser());
  app.use(
    createOriginGuard({
      allowPrefixes: [
        "/api/system/health",
        "/api/system/stats",
        "/api/health",
        "/api/extension",
        "/api/integrations",
        "/healthz",
      ],
      label: "operações autenticadas",
    }),
  );

  // ✅ Static (quando montado na suite em /ml vira /ml/css, /ml/js...)
  app.use(express.static(path.join(__dirname, "public")));

  app.use((req, res, next) => {
    patchHtmlSendFile(res);
    next();
  });

  // ✅ FIX favicon
  app.get("/favicon.ico", (_req, res) => res.status(204).end());

  console.log("🔍 [ML] Carregando módulos...");

  // ==================================================
  // ✅ Bootstrap do MASTER (idempotente)
  // ==================================================
  ensureMasterUser()
    .then(() => console.log("✅ [ML] Bootstrap MASTER ok"))
    .catch((e) =>
      console.error("❌ [ML] Bootstrap MASTER falhou:", e?.message || e),
    );

  startRankingSnapshotScheduler();
  startReputationSnapshotScheduler();
  startSkuPriceHistoryScheduler();
  startEstrategicosReviewScheduler();
  startAutomationReportScheduler();
  startAnuncioDraftCleanupScheduler();
  startHubUsageReporter();
  startReportRetentionCleanup();

  // ==================================================
  // Token provider (Curva ABC)
  // ==================================================
  try {
    const { getAccessTokenForAccount } = require("./services/ml-auth");
    app.set("getAccessTokenForAccount", getAccessTokenForAccount);
    console.log("✅ [ML] Token Adapter injetado");
  } catch (_err) {
    console.warn("⚠️ [ML] Não foi possível injetar ml-auth.");
  }

  // ==================================================
  // noCache
  // ==================================================
  function noCache(_req, res, next) {
    res.set({
      "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
      Pragma: "no-cache",
      Expires: "0",
      "Surrogate-Control": "no-store",
    });
    next();
  }

  // ==================================================
  // Helpers baseUrl (suite /ml vs standalone)
  // ==================================================
  function getBase(req) {
    return String(req.baseUrl || "");
  }

  function withBase(req, routePath) {
    if (/^https?:\/\//i.test(String(routePath || ""))) return routePath;
    const base = getBase(req);
    const normalizedPath = String(routePath || "").startsWith("/")
      ? String(routePath)
      : `/${String(routePath || "")}`;
    if (base && (normalizedPath === base || normalizedPath.startsWith(base + "/"))) {
      return normalizedPath;
    }
    return base + normalizedPath;
  }

  // ==================================================
  // ✅ Auth Routes públicas
  // ==================================================
  try {
    if (!(process.env.ML_JWT_SECRET || process.env.JWT_SECRET)) {
      console.warn("⚠️ [ML] JWT_SECRET não definido.");
    }
    const authRoutes = require("./routes/authRoutes");
    app.use("/api/auth", authRoutes);
    console.log("✅ [ML] AuthRoutes carregado");
  } catch (e) {
    console.error("❌ [ML] Erro ao carregar AuthRoutes:", e.message);
  }

  try {
    const extensionRoutes = require("./routes/extensionRoutes");
    app.use("/api/extension", extensionRoutes);
    console.log("✅ [ML] ExtensionRoutes carregado");
  } catch (e) {
    console.error("❌ [ML] Erro ao carregar ExtensionRoutes:", e.message);
  }

  // ==================================================
  // ✅ Auth Gate (tudo protegido)
  // ==================================================
  function isPublicPath(req) {
    const p = req.path || "";

    // páginas públicas
    if (p === "/login") return true;
    if (p === "/cadastro") return true;
    if (p === "/ativar") return true;
    if (p === "/esqueci-senha") return true;
    if (p === "/redefinir-senha") return true;
    if (p === "/selecao-plataforma") return true;
    if (p === "/privacidade") return true;
    if (p === "/privacidade/davantti-cloner") return true;
    if (p === "/privacy/davantti-cloner") return true;
    if (p === "/privacy") return true;
    if (p === "/politica-de-privacidade/davantti-cloner") return true;
    if (p === "/politica-de-privacidade") return true;

    // ✅ acessíveis pós-login sem conta selecionada
    if (p === "/select-conta") return true;
    if (p === "/vincular-conta") return true;

    // auth
    if (p.startsWith("/api/auth")) return true;

    // ✅ callback OAuth do ML precisa ficar público para o redirect oficial
    // conseguir finalizar a vinculação mesmo se o cookie auth_token não voltar.
    if (p === "/api/meli/oauth/callback") return true;
    if (p === "/api/meli/webhooks/notifications") return true;
    if (p.startsWith("/api/integrations/")) return true;

    // healthchecks
    if (p === "/healthz") return true;
    if (p.startsWith("/api/system/health")) return true;
    if (p.startsWith("/api/system/stats")) return true;
    if (p.startsWith("/api/health")) return true;

    // assets
    if (
      p.startsWith("/css/") ||
      p.startsWith("/js/") ||
      p.startsWith("/img/") ||
      p.startsWith("/fonts/") ||
      p.startsWith("/vendor/")
    ) {
      return true;
    }

    if (p === "/favicon.ico") return true;
    return false;
  }

  function authGate(req, res, next) {
    if (isPublicPath(req)) return next();
    return ensureAuth(req, res, next);
  }

  function normalizeHubBaseUrl(raw) {
    return normalizeHubConfigValue(raw)
      .replace(/\/+$/, "");
  }

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

  function isHubConfigured() {
    return Boolean(
      normalizeHubBaseUrl(process.env.HUB_BASE_URL) &&
        normalizeHubConfigValue(process.env.HUB_INTERNAL_TOKEN),
    );
  }

  function shouldFailClosedHubGate() {
    const raw = String(
      process.env.ML_HUB_GATE_MODE ||
        process.env.HUB_AUTH_MODE ||
        process.env.HUB_ENFORCEMENT ||
        "hybrid",
    )
      .trim()
      .toLowerCase();

    return ["strict", "enforce", "enabled"].includes(raw);
  }

  function allowHubGateBypass(req, res, next, reason, extra = {}) {
    res.locals.hubAccess = {
      allow: true,
      bypass: true,
      module: "ml",
      reason,
      ...extra,
    };
    console.warn(
      `[ML] Hub gate em bypass seguro: ${reason} ${req.method} ${req.path || ""}`.trim(),
    );
    return next();
  }

  function shouldBypassMasterBilling(user) {
    const bypassMaster =
      String(process.env.ML_HUB_BYPASS_ADMIN_MASTER ?? "true").toLowerCase() ===
      "true";
    if (!bypassMaster) return false;

    const nivel = String(user?.nivel || "")
      .trim()
      .toLowerCase();
    const role = String(user?.role || "")
      .trim()
      .toLowerCase();

    return nivel === "admin_master" || role === "admin_master";
  }

  function isHubBillingRecoveryPath(req) {
    const p = req.path || "";
    if (p === "/conta/regularizar") return true;
    if (p === "/conta/creditos") return true;
    if (p === "/conta/contas") return true;
    if (p.startsWith("/api/account/")) return true;
    if (p.startsWith("/api/meli/")) return true;
    if (p.startsWith("/api/billing/")) return true;
    return false;
  }

  function hubRoleFromUser(user, accountIdentity = null) {
    const nivel = String(user?.nivel || "")
      .trim()
      .toLowerCase();
    const role = String(user?.role || "")
      .trim()
      .toLowerCase();
    const papel = String(accountIdentity?.papel || "")
      .trim()
      .toLowerCase();

    return nivel === "admin_master" ||
      nivel === "administrador" ||
      role === "admin_master" ||
      role === "administrador" ||
      papel === "owner" ||
      papel === "admin"
      ? "owner"
      : "operator";
  }

  function wantsHtml(req) {
    const accept = String(req.headers?.accept || "").toLowerCase();
    return (
      accept.includes("text/html") || accept.includes("application/xhtml+xml")
    );
  }

  async function resolveHubIdentity(userId, preferredEmpresaId) {
    const userResult = await db.query(
      `select user_global_id
         from usuarios
        where id = $1
        limit 1`,
      [userId],
    );

    const userGlobalId = String(userResult.rows?.[0]?.user_global_id || "").trim();
    if (!userGlobalId) {
      return null;
    }

    if (Number.isFinite(preferredEmpresaId)) {
      const tenantResult = await db.query(
        `select tenant_global_id
           from empresas
          where id = $1
          limit 1`,
        [preferredEmpresaId],
      );
      const tenantGlobalId = String(
        tenantResult.rows?.[0]?.tenant_global_id || "",
      ).trim();
      if (tenantGlobalId) {
        const papelResult = await db.query(
          `select papel
             from empresa_usuarios
            where usuario_id = $1 and empresa_id = $2
            limit 1`,
          [userId, preferredEmpresaId],
        );
        return {
          userGlobalId,
          tenantGlobalId,
          papel: String(papelResult.rows?.[0]?.papel || "")
            .trim()
            .toLowerCase(),
        };
      }
    }

    const fallbackTenantResult = await db.query(
      `select e.tenant_global_id, eu.papel
         from empresa_usuarios eu
         join empresas e on e.id = eu.empresa_id
        where eu.usuario_id = $1
        order by
          case eu.papel when 'owner' then 1 when 'admin' then 2 else 3 end,
          eu.criado_em asc
        limit 1`,
      [userId],
    );

    const fallbackTenantGlobalId = String(
      fallbackTenantResult.rows?.[0]?.tenant_global_id || "",
    ).trim();
    if (!fallbackTenantGlobalId) {
      return null;
    }

    return {
      userGlobalId,
      tenantGlobalId: fallbackTenantGlobalId,
      papel: String(fallbackTenantResult.rows?.[0]?.papel || "")
        .trim()
        .toLowerCase(),
    };
  }

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

  function getHubBillingCacheKey(identity) {
    return [
      String(identity?.tenantGlobalId || "").trim(),
      String(identity?.userGlobalId || "").trim(),
      "ml",
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

  function denyBillingAccess(req, res, extra = {}) {
    const message =
      extra.message ||
      extra.error ||
      "Assinatura inativa para este modulo.";

    if (req.method === "GET" && wantsHtml(req)) {
      return res.redirect(withBase(req, "/selecao-plataforma?payment=required"));
    }

    return res.status(402).json({
      ok: false,
      code: "PAYMENT_REQUIRED",
      error: message,
      ...extra,
    });
  }

  async function hubBillingGate(req, res, next) {
    if (isPublicPath(req) || !isHubConfigured()) {
      return next();
    }

    if (isHubBillingRecoveryPath(req)) {
      return next();
    }

    if (shouldBypassMasterBilling(req.user)) {
      return next();
    }

    const userId = Number(req.user?.uid || req.user?.id);
    if (!Number.isFinite(userId)) {
      return next();
    }

    let cacheKey = null;

    try {
      const preferredEmpresaId = Number(res.locals?.empresaId);
      const identity = await resolveHubIdentity(
        userId,
        Number.isFinite(preferredEmpresaId) ? preferredEmpresaId : null,
      );

      if (!identity?.tenantGlobalId || !identity?.userGlobalId) {
        if (!shouldFailClosedHubGate()) {
          return allowHubGateBypass(req, res, next, "billing_identity_missing");
        }
        return denyBillingAccess(req, res, {
          reason: "billing_identity_missing",
        });
      }

      cacheKey = getHubBillingCacheKey(identity);
      const cachedAccess = readFreshHubBillingCache(cacheKey);
      if (cachedAccess) {
        if (!cachedAccess.allow) {
          return denyBillingAccess(req, res, {
            status: cachedAccess.status || null,
            reason: cachedAccess.reason || "subscription_inactive_or_module_not_allowed",
          });
        }
        res.locals.hubAccess = cachedAccess.payload || null;
        return next();
      }

      const syncResult = await syncHubIdentity({
        tenant_id: identity.tenantGlobalId,
        company_name: String(res.locals?.empresaNome || "DACHBYTE Mercado Livre").trim(),
        user_id: identity.userGlobalId,
        full_name: String(req.user?.nome || req.user?.email || "Usuario ML").trim(),
        email: String(req.user?.email || "").trim().toLowerCase(),
        role: hubRoleFromUser(req.user, identity),
      }).catch((error) => {
        console.warn("⚠️ [ML] Falha ao sincronizar identidade no hub:", error?.message || error);
        return null;
      });

      const hubBaseUrl = normalizeHubBaseUrl(process.env.HUB_BASE_URL);
      const hubToken = normalizeHubConfigValue(process.env.HUB_INTERNAL_TOKEN);
      const effectiveTenantId = String(
        syncResult?.payload?.tenant_id || identity.tenantGlobalId,
      ).trim();
      const effectiveUserId = String(
        syncResult?.payload?.user_id || identity.userGlobalId,
      ).trim();

      const response = await fetch(`${hubBaseUrl}/v1/access/check`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${hubToken}`,
        },
        body: JSON.stringify({
          tenant_id: effectiveTenantId,
          user_id: effectiveUserId,
          module: "ml",
          action: `${req.method} ${req.path || ""}`.trim(),
        }),
      });

      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const staleAccess = readStaleAllowedHubBillingCache(cacheKey);
        if (staleAccess) {
          res.locals.hubAccess = staleAccess.payload || null;
          return next();
        }

        if (!shouldFailClosedHubGate()) {
          return allowHubGateBypass(req, res, next, "hub_access_check_failed", {
            status: response.status,
          });
        }

        return res.status(503).json({
          ok: false,
          code: "BILLING_CHECK_UNAVAILABLE",
          error: "Nao foi possivel validar a assinatura no momento.",
          reason:
            response.status === 401 || response.status === 403
              ? "hub_access_unauthorized"
              : "hub_access_check_failed",
        });
      }

      if (!payload?.allow) {
        const reason =
          payload?.reason || "subscription_inactive_or_module_not_allowed";
        writeHubBillingCache(cacheKey, {
          allow: false,
          payload,
          status: payload?.status || null,
          reason,
        });
        return denyBillingAccess(req, res, {
          status: payload?.status || null,
          reason,
          message: payload?.message || null,
        });
      }

      writeHubBillingCache(cacheKey, { allow: true, payload });
      res.locals.hubAccess = payload;
      return next();
    } catch (error) {
      console.error("❌ [ML] Hub billing gate falhou:", error?.message || error);
      const staleAccess = cacheKey ? readStaleAllowedHubBillingCache(cacheKey) : null;
      if (staleAccess) {
        res.locals.hubAccess = staleAccess.payload || null;
        return next();
      }
      if (!shouldFailClosedHubGate()) {
        return allowHubGateBypass(req, res, next, "hub_gate_exception", {
          detail: error?.message || String(error || "unknown_error"),
        });
      }
      return res.status(503).json({
        ok: false,
        code: "BILLING_CHECK_UNAVAILABLE",
        error: "Nao foi possivel validar a assinatura no momento.",
      });
    }
  }

  app.use(authGate);
  console.log("✅ [ML] AuthGate aplicado");

  // ==================================================
  // ✅ Rotas de páginas PÚBLICAS (HTML)
  // (essas NÃO devem exigir conta selecionada)
  // ==================================================
  app.get("/", noCache, (req, res) => {
    const base = getBase(req);
    if (req.cookies?.auth_token) {
      return ensureAuth(req, res, () => {
        const nivel = normalizeNivel(req.user?.nivel);
        if (nivel === "admin_master") {
          return res.redirect(base + "/admin/dashboard");
        }
        return res.redirect(base + "/painel");
      });
    }
    return res.redirect(base + "/selecao-plataforma");
  });

  app.get("/healthz", (_req, res) => {
    res.set("Cache-Control", "no-store");
    return res.status(200).json({ ok: true });
  });

  app.get("/selecao-plataforma", noCache, (_req, res) => {
    return res.sendFile(
      path.join(__dirname, "views", "selecao-plataforma.html"),
    );
  });

  app.get(
    [
      "/privacidade",
      "/privacidade/davantti-cloner",
      "/privacy/davantti-cloner",
      "/privacy",
      "/politica-de-privacidade/davantti-cloner",
      "/politica-de-privacidade",
    ],
    noCache,
    (_req, res) => {
      return res.sendFile(
        path.join(__dirname, "views", "privacy-davantti-cloner.html"),
      );
    },
  );

  app.get("/login", noCache, (_req, res) => {
    return res.sendFile(path.join(__dirname, "views", "login.html"));
  });

  app.get("/cadastro", noCache, (_req, res) => {
    return res.redirect(getBase(_req) + "/login");
  });

  app.get("/ativar", noCache, (_req, res) => {
    return res.sendFile(path.join(__dirname, "views", "ativar.html"));
  });

  app.get("/esqueci-senha", noCache, (_req, res) => {
    return res.sendFile(path.join(__dirname, "views", "esqueci-senha.html"));
  });

  app.get("/redefinir-senha", noCache, (_req, res) => {
    return res.sendFile(path.join(__dirname, "views", "redefinir-senha.html"));
  });

  app.get("/select-conta", noCache, (_req, res) => {
    return res.sendFile(path.join(__dirname, "views", "select-conta.html"));
  });

  app.get("/vincular-conta", noCache, (_req, res) => {
    return res.sendFile(path.join(__dirname, "views", "vincular-conta.html"));
  });

  app.get("/nao-autorizado", noCache, (_req, res) => {
    return res
      .status(403)
      .sendFile(path.join(__dirname, "views", "nao-autorizado.html"));
  });

  // ==========================================
  // ✅ Middlewares “do ML” (depois do authGate)
  // ==========================================
  try {
    app.use(ensureAccount);
  } catch (e) {
    console.warn("⚠️ [ML] ensureAccount não aplicado:", e?.message || e);
  }

  try {
    app.use(hubBillingGate);
  } catch (e) {
    console.warn("⚠️ [ML] hubBillingGate não aplicado:", e?.message || e);
  }

  // ✅ IMPORTANTÍSSIMO: authMiddleware depende das credenciais injetadas por ensureAccount
  // (res.locals.mlCreds). Então ele PRECISA vir DEPOIS do ensureAccount.
  try {
    app.use(authMiddleware);
  } catch (e) {
    console.warn("⚠️ [ML] authMiddleware não aplicado:", e?.message || e);
  }

  // ==========================================
  // ✅ Gate de ADMIN (HTML)
  // (isso resolve: master loga, mas não consegue abrir /admin/*)
  // ==========================================
  const JWT_SECRET = process.env.ML_JWT_SECRET || process.env.JWT_SECRET || "";
  function getUserFromReq(req) {
    if (req.user && req.user.nivel) return req.user;

    const token = req.cookies?.auth_token;
    if (!token || !JWT_SECRET) return null;

    try {
      return jwt.verify(token, JWT_SECRET);
    } catch {
      return null;
    }
  }

  function normalizeNivel(n) {
    return String(n || "")
      .trim()
      .toLowerCase();
  }

  function ensureAdminAnyHtml(req, res, next) {
    const u = getUserFromReq(req);
    if (!u) return res.redirect(getBase(req) + "/login");

    const nivel = normalizeNivel(u.nivel);
    const ok = nivel === "admin_master";
    if (!ok) return res.redirect(getBase(req) + "/nao-autorizado");

    req.user = { ...u, nivel };
    return next();
  }

  // ==================================================
  // ✅ Rotas HTML PROTEGIDAS (agora passam pelo ensureAccount)
  // ==================================================
  app.get("/painel", noCache, (_req, res) => {
    return res.sendFile(path.join(__dirname, "views", "painel.html"));
  });

  app.get("/projecao-mensal", noCache, (_req, res) => {
    return res.sendFile(path.join(__dirname, "views", "projecao-mensal.html"));
  });

  app.get("/dashboard", noCache, (_req, res) => {
    return res.redirect(getBase(_req) + "/projecao-mensal");
  });

  // ✅ ADMIN HTML (serve teus arquivos admin-*.html)
  app.get("/admin", noCache, ensureAdminAnyHtml, (req, res) => {
    return res.redirect(getBase(req) + "/admin/dashboard");
  });

  app.get("/admin/dashboard", noCache, ensureAdminAnyHtml, (_req, res) => {
    return res.sendFile(path.join(__dirname, "views", "admin-dashboard.html"));
  });

  app.get("/admin/usuarios", noCache, ensureAdminAnyHtml, (_req, res) => {
    return res.sendFile(path.join(__dirname, "views", "admin-usuarios.html"));
  });

  app.get("/admin/empresas", noCache, ensureAdminAnyHtml, (_req, res) => {
    return res.sendFile(path.join(__dirname, "views", "admin-empresas.html"));
  });

  app.get("/admin/vinculos", noCache, ensureAdminAnyHtml, (_req, res) => {
    return res.sendFile(path.join(__dirname, "views", "admin-vinculos.html"));
  });

  app.get("/admin/meli-contas", noCache, ensureAdminAnyHtml, (_req, res) => {
    return res.sendFile(
      path.join(__dirname, "views", "admin-meli-contas.html"),
    );
  });

  app.get("/admin/relatorios-ml", noCache, ensureAdminAnyHtml, (_req, res) => {
    return res.sendFile(
      path.join(__dirname, "views", "admin-meli-account-reports.html"),
    );
  });

  app.get("/admin/meli-tokens", noCache, ensureAdminAnyHtml, (_req, res) => {
    return res.sendFile(
      path.join(__dirname, "views", "admin-meli-tokens.html"),
    );
  });

  app.get("/admin/oauth-states", noCache, ensureAdminAnyHtml, (_req, res) => {
    return res.sendFile(
      path.join(__dirname, "views", "admin-oauth-states.html"),
    );
  });

  app.get("/admin/migracoes", noCache, ensureAdminAnyHtml, (_req, res) => {
    return res.sendFile(path.join(__dirname, "views", "admin-migracoes.html"));
  });

  app.get("/admin/backup", noCache, ensureAdminAnyHtml, (_req, res) => {
    return res.sendFile(path.join(__dirname, "views", "admin-backup.html"));
  });

  app.get("/admin/auditoria", noCache, ensureAdminAnyHtml, (_req, res) => {
    return res.sendFile(path.join(__dirname, "views", "admin-auditoria.html"));
  });

  app.get("/admin/patch-notes", noCache, ensureAdminAnyHtml, (_req, res) => {
    return res.sendFile(path.join(__dirname, "views", "admin-patch-notes.html"));
  });

  app.get("/admin/jobs", noCache, ensureAdminAnyHtml, (_req, res) => {
    return res.sendFile(path.join(__dirname, "views", "admin-jobs.html"));
  });

  // ==========================================
  // ✅ Logout (mantém)
  // ==========================================
  app.post("/api/ml/logout", noCache, (_req, res) => {
    res.clearCookie("auth_token", { path: "/" });
    res.clearCookie("ml_account", { path: "/" });
    res.clearCookie("meli_conta_id", { path: "/" });
    res.clearCookie("meli_conta_id", { path: "/ml" });
    return res.json({ ok: true });
  });

  // ==========================================
  // ✅ ROTAS (plugar módulos)
  // ==========================================
  function safeUse(label, modPath, mountPath = null) {
    try {
      const r = require(modPath);
      if (mountPath) app.use(mountPath, r);
      else app.use(r);
      console.log(`✅ [ML] ${label} carregado`);
    } catch (e) {
      console.warn(`⚠️ [ML] Falhou ao carregar ${label}:`, e.message);
    }
  }

  // páginas/HTML do dashboard etc (se existir)
  safeUse("HtmlRoutes", "./routes/htmlRoutes");

  // routers com mount fixo
  safeUse("accountRoutes", "./routes/accountRoutes", "/api/account");
  safeUse("billingRoutes", "./routes/billingRoutes", "/api/billing");
  safeUse("accountUsersRoutes", "./routes/accountUsersRoutes", "/api/account/users");
  safeUse("accountIntegrationsRoutes", "./routes/accountIntegrationsRoutes", "/api/account/integrations");
  safeUse("automationReportRoutes", "./routes/automationReportRoutes", "/api/account/automations/reports");
  safeUse("integrationWebhookRoutes", "./routes/integrationWebhookRoutes", "/api/integrations");
  safeUse("systemRoutes", "./routes/systemRoutes", "/api/system");
  safeUse("meliOAuthRoutes", "./routes/meliOAuthRoutes", "/api/meli");
  safeUse("meliWebhookRoutes", "./routes/meliWebhookRoutes", "/api/meli");
  safeUse("tokenRoutes", "./routes/tokenRoutes", "/api/tokens");
  safeUse("dashboardRoutes", "./routes/dashboardRoutes", "/api/dashboard");
  safeUse("painelRoutes", "./routes/painelRoutes", "/api/painel");
  safeUse("contactRoutes", "./routes/contactRoutes", "/api/contact");
  safeUse("notificationsRoutes", "./routes/notificationsRoutes", "/api/notifications");

  // demais (mantém)
  safeUse("itemsRoutes", "./routes/itemsRoutes");
  safeUse("anuncioCadastroRoutes", "./routes/anuncioCadastroRoutes", "/api/anuncio-cadastro");
  safeUse("clonarAnuncioRoutes", "./routes/clonarAnuncioRoutes", "/api/clonar-anuncio");
  safeUse("excluirAnuncioRoutes", "./routes/excluirAnuncioRoutes", "/api/excluir-anuncio");
  safeUse("promocoesRoutes", "./routes/promocoesRoutes");
  safeUse("atacadoRoutes", "./routes/atacadoRoutes", "/api/atacado");
  safeUse("modeloMassaRoutes", "./routes/modeloMassaRoutes", "/api/modelo-massa");
  safeUse("caracteristicasRoutes", "./routes/caracteristicasRoutes", "/api/caracteristicas");
  safeUse("removerPromocaoRoutes", "./routes/removerPromocaoRoutes");
  safeUse("publicidadeRoutes", "./routes/publicidadeRoutes", "/api/publicidade");
  safeUse("estoqueAlertaRoutes", "./routes/estoqueAlertaRoutes", "/api/estoque");
  safeUse("fullRoutes", "./routes/fullRoutes", "/api/full");
  safeUse("estrategicosRoutes", "./routes/estrategicosRoutes", "/api/estrategicos");
  safeUse("marketAnalysisRoutes", "./routes/marketAnalysisRoutes", "/api/market-analysis");
  safeUse("PrazoProducaoRoutes", "./routes/prazoProducaoRoutes");
  safeUse("ValidarDimensoesRoutes", "./routes/validarDimensoesRoutes", "/api/validar-dimensoes");
  safeUse("financeiroMlRoutes", "./routes/financeiroMlRoutes", "/api/financeiro-ml");
  safeUse("reputacaoRoutes", "./routes/reputacaoRoutes", "/api/reputacao");
  safeUse("fiscalRoutes", "./routes/fiscalRoutes", "/api/fiscal");
  safeUse("mercadolivreRankingRoutes", "./routes/mercadolivreRankingRoutes", "/api/mercadolivre");
  safeUse(
    "analytics-filtro-anuncios-routes",
    "./routes/analytics-filtro-anuncios-routes",
    "/api/analytics",
  );
  safeUse("analytics-abc-Routes", "./routes/analytics-abc-Routes", "/api/analytics");

  // Admin APIs  ✅ (montado em /api/admin)
  safeUse("adminUsuariosRoutes", "./routes/adminUsuariosRoutes", "/api/admin");
  safeUse("adminEmpresasRoutes", "./routes/adminEmpresasRoutes", "/api/admin");
  safeUse("adminVinculosRoutes", "./routes/adminVinculosRoutes", "/api/admin");
  safeUse(
    "adminMeliContasRoutes",
    "./routes/adminMeliContasRoutes",
    "/api/admin",
  );
  safeUse(
    "adminMeliTokensRoutes",
    "./routes/adminMeliTokensRoutes",
    "/api/admin",
  );
  safeUse(
    "adminMeliAccountReportsRoutes",
    "./routes/adminMeliAccountReportsRoutes",
    "/api/admin",
  );
  safeUse(
    "adminOAuthStatesRoutes",
    "./routes/adminOAuthStatesRoutes",
    "/api/admin",
  );
  safeUse(
    "adminMigracoesRoutes",
    "./routes/adminMigracoesRoutes",
    "/api/admin",
  );
  safeUse("adminBackupRoutes", "./routes/adminBackupRoutes", "/api/admin");
  safeUse("adminAuditoriaRoutes", "./routes/adminAuditoriaRoutes", "/api/admin");
  safeUse("adminPatchNotesRoutes", "./routes/adminPatchNotesRoutes", "/api/admin");
  safeUse("adminJobsRoutes", "./routes/adminJobsRoutes", "/api/admin");

  // ==========================================
  // ERRORS (mantém)
  // ==========================================
  // eslint-disable-next-line no-unused-vars
  app.use((error, req, res, next) => {
    console.error("❌ [ML] Erro não tratado:", error);
    res.status(500).json({
      success: false,
      error: "Erro interno do servidor",
      message: error.message,
      timestamp: new Date().toISOString(),
      path: req.originalUrl,
    });
  });

  app.use((req, res) => {
    res.status(404).json({
      success: false,
      error: "Rota não encontrada",
      path: req.originalUrl,
      method: req.method,
    });
  });

  return app;
};
