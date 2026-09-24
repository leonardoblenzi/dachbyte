// server.js (RAIZ)
"use strict";

const express = require("express");
const cookieParser = require("cookie-parser");
const path = require("path");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const { loadRuntimeEnv } = require("../../lib/runtimeEnv");
const { createSupportWidgetInjector } = require("../../lib/supportWidgetInjector");
const { DACHBYTE_BRAND } = require("../../lib/dachbyteBrand");

loadRuntimeEnv({
  defaultCandidates: [
    path.join(__dirname, ".env"),
    path.join(__dirname, "..", "seller-shopee", "src", ".env"),
    path.join(__dirname, "..", "seller-shopee", ".env"),
  ],
});

const mlDb = require("../seller-ml/db/db");

const {
  createSessionForUser: createShopeeSessionForUser,
  countShopsByAccountId: countShopeeShopsByAccountId,
  findUserByEmail: findShopeeUserByEmail,
  reserveNextNumericId: reserveNextShopeeNumericId,
} = require("../seller-shopee/src/repositories/authSqlRepository");
const { withClient: withShopeeClient } = require("../seller-shopee/src/config/postgres");

const SUITE_JWT_SECRET =
  String(process.env.SUITE_JWT_SECRET || "").trim() ||
  String(process.env.ML_JWT_SECRET || "").trim() ||
  String(process.env.JWT_SECRET || "").trim();

function getQueryStringValue(value) {
  if (Array.isArray(value)) return value.length ? String(value[0] || "") : "";
  if (value === undefined || value === null) return "";
  return String(value);
}

function hasShopeeOauthQuery(query) {
  const code = getQueryStringValue(query?.code).trim();
  const shopId = getQueryStringValue(query?.shop_id).trim();
  return Boolean(code && shopId);
}

function buildShopeeOauthCallbackQuery(query) {
  const params = new URLSearchParams();
  const allowList = [
    "code",
    "shop_id",
    "main_account_id",
    "state",
    "error",
    "error_description",
  ];

  allowList.forEach((key) => {
    const value = query?.[key];
    if (Array.isArray(value)) {
      value
        .map((item) => String(item || "").trim())
        .filter(Boolean)
        .forEach((item) => params.append(key, item));
      return;
    }

    const normalized = getQueryStringValue(value).trim();
    if (normalized) {
      params.set(key, normalized);
    }
  });

  return params.toString();
}

function readSuitePayload(req) {
  const token = String(req.cookies?.suite_auth_token || "").trim();
  if (!token || !SUITE_JWT_SECRET) return null;

  try {
    return jwt.verify(token, SUITE_JWT_SECRET);
  } catch (_error) {
    return null;
  }
}

function hasModuleAccess(payload, moduleId) {
  const aliases = {
    "davantti-log": "davanttilog",
    davantti_log: "davanttilog",
    davanttilog: "davanttilog",
    davanlog: "davanttilog",
    volt_stock: "voltstock",
    voltstock: "voltstock",
    ads: "dach_ads",
    dachads: "dach_ads",
    dach_ads: "dach_ads",
    "dach-ads": "dach_ads",
  };
  const allowed = Array.isArray(payload?.allowed_modules)
    ? payload.allowed_modules
        .map((item) => {
          const normalized = String(item || "").trim().toLowerCase();
          return aliases[normalized] || normalized;
        })
        .filter(Boolean)
    : [];

  const normalizedModuleId = String(moduleId || "").trim().toLowerCase();
  return allowed.includes(aliases[normalizedModuleId] || normalizedModuleId);
}

function hasSessionModuleReference(payload, moduleId) {
  if (hasModuleAccess(payload, moduleId)) return true;
  return hasModuleAccess(
    { allowed_modules: Array.isArray(payload?.visible_modules) ? payload.visible_modules : [] },
    moduleId,
  );
}

function hasActiveSuiteSubscription(payload) {
  const subscription = payload?.subscription || {};
  const status = String(subscription.status || "").trim().toLowerCase();
  return subscription.active === true || status === "active" || status === "trial";
}

function isLegacySuitePayload(payload = {}) {
  const source = String(payload.auth_source || "").trim().toLowerCase();
  const tenantId = String(payload.tenant_id || "").trim().toLowerCase();
  return source.includes("legacy") || tenantId.startsWith("legacy-tenant-");
}

function renewalUrlFromSuitePayload(payload) {
  const renewalUrl = String(payload?.subscription?.renewal_url || "").trim();
  return renewalUrl || "/landing";
}

function hubModuleFromSuiteModule(moduleId) {
  const aliases = {
    madeiramadeira: "madeira",
    tracking: "tracking",
    logisync: "davanttilog",
    logsync: "davanttilog",
    "davantti-log": "davanttilog",
    davantti_log: "davanttilog",
    ads: "dach_ads",
    dachads: "dach_ads",
    dach_ads: "dach_ads",
    "dach-ads": "dach_ads",
  };
  const normalized = String(moduleId || "").trim().toLowerCase();
  return aliases[normalized] || normalized;
}

function hubConfig() {
  return {
    baseUrl: String(process.env.HUB_BASE_URL || "").trim().replace(/\/+$/, ""),
    token: String(process.env.HUB_INTERNAL_TOKEN || "").trim(),
  };
}

async function checkSuiteModuleAccess(payload, moduleId) {
  if (isLegacySuitePayload(payload)) {
    return {
      allow: hasActiveSuiteSubscription(payload) && hasSessionModuleReference(payload, moduleId),
      reason: "legacy_session_fallback",
    };
  }

  const { baseUrl, token } = hubConfig();
  const tenantId = String(payload?.tenant_id || "").trim();
  const userId = String(payload?.user_id || "").trim();
  if (!baseUrl || !token || !tenantId || !userId) {
    return {
      allow: hasActiveSuiteSubscription(payload) && hasModuleAccess(payload, moduleId),
      reason: "local_session_fallback",
    };
  }

  const response = await fetch(`${baseUrl}/v1/access/check`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      tenant_id: tenantId,
      user_id: userId,
      module: hubModuleFromSuiteModule(moduleId),
      action: `GO ${moduleId}`,
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    return { allow: false, reason: data?.reason || data?.error || "hub_access_check_failed" };
  }
  return {
    allow: data?.allow === true,
    reason: data?.reason || (data?.allow ? "ok" : "hub_denied"),
    status: data?.status || null,
  };
}

function clearModuleCookies(res) {
  const cookiePaths = ["/", "/ml", "/shopee", "/magalu"];
  ["auth_token", "sid", "skuleader_auth_token", "davanttilog_token"].forEach((name) => {
    cookiePaths.forEach((path) => res.clearCookie(name, { path }));
  });
}

function createSuiteGoHandler(moduleId, targetPath, options = {}) {
  const loginPath = options.loginPath || "/login";
  const deniedPath = options.deniedPath || "/selecao-plataforma";
  return async (req, res) => {
    const payload = readSuitePayload(req);
    if (!payload) {
      return res.redirect(loginPath);
    }

    if (isLegacySuitePayload(payload) && !hasSessionModuleReference(payload, moduleId)) {
      return res.redirect(`${deniedPath}?module=denied`);
    }

    const access = await checkSuiteModuleAccess(payload, moduleId).catch((error) => ({
      allow: false,
      reason: error?.message || "hub_access_check_failed",
    }));

    if (!access.allow) {
      clearModuleCookies(res);
      if (options.deniedPath) return res.redirect(deniedPath);
      return res.redirect(
        `/selecao-plataforma?subscription=${encodeURIComponent(access.status || access.reason || "blocked")}&renew=${encodeURIComponent(
          renewalUrlFromSuitePayload(payload),
        )}`,
      );
    }

    let resolvedTargetPath;
    try {
      resolvedTargetPath = await bootstrapModuleSession(moduleId, payload, res);
    } catch (error) {
      console.error("[suite] Falha ao iniciar sessao do modulo", {
        moduleId,
        code: error?.code || null,
        message: error?.message || String(error),
      });
      if (moduleId === "shopee") {
        return res.redirect("/selecao-plataforma?session=shopee_bootstrap_failed");
      }
      if (moduleId === "magalu") {
        return res.redirect("/selecao-plataforma?session=magalu_bootstrap_failed");
      }
    }

    if (moduleId === "shopee" && !resolvedTargetPath) {
      console.error("[suite] Sessao Shopee nao foi iniciada", { moduleId });
      return res.redirect("/selecao-plataforma?session=shopee_bootstrap_unavailable");
    }
    if (moduleId === "magalu" && !resolvedTargetPath) {
      console.error("[suite] Identidade Magalu nao foi iniciada", { moduleId });
      return res.redirect("/selecao-plataforma?session=magalu_bootstrap_unavailable");
    }
    return res.redirect(resolvedTargetPath || targetPath);
  };
}

function isProdEnv() {
  return String(process.env.NODE_ENV || "").toLowerCase() === "production";
}

function cookieOptions(maxAgeMs) {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: isProdEnv(),
    maxAge: maxAgeMs,
    path: "/",
  };
}

function getMlAuthSchema() {
  return (
    String(process.env.AUTH_DB_SCHEMA || mlDb.ML_DB_SCHEMA || "ml")
      .trim()
      .replace(/[^a-zA-Z0-9_]/g, "") || "ml"
  );
}

function normalizeMlCompanyRole(role) {
  const normalized = String(role || "member").trim().toLowerCase();
  if (["owner", "proprietario", "proprietário"].includes(normalized)) {
    return "owner";
  }
  if (["admin", "administrador"].includes(normalized)) {
    return "admin";
  }
  return "operador";
}

async function provisionMlUserFromSuitePayload(payload) {
  const email = String(payload?.email || "").trim().toLowerCase();
  const tenantGlobalId = String(payload?.tenant_id || "").trim();
  const userGlobalId = String(payload?.user_id || "").trim();

  if (!email || !tenantGlobalId || !userGlobalId) return null;

  const schema = getMlAuthSchema();
  const companyName =
    String(payload?.company_name || "").trim() || "Empresa DACHBYTE";
  const userName =
    String(
      payload?.name || payload?.full_name || email || "Usuario DACHBYTE",
    ).trim();
  const passwordHash = await bcrypt.hash(
    crypto.randomBytes(24).toString("base64url"),
    10,
  );

  await mlDb.query("begin");
  try {
    let company = (
      await mlDb.query(
        `select id, nome, tenant_global_id
           from ${schema}.empresas
          where tenant_global_id = $1
          limit 1`,
        [tenantGlobalId],
      )
    ).rows[0] || null;

    if (!company) {
      company = (
        await mlDb.query(
          `insert into ${schema}.empresas (nome, tenant_global_id)
           values ($1, $2)
           returning id, nome, tenant_global_id`,
          [companyName, tenantGlobalId],
        )
      ).rows[0] || null;
    }

    let user = (
      await mlDb.query(
        `select id, nome, email, nivel, status, user_global_id
           from ${schema}.usuarios
          where email = $1
          limit 1`,
        [email],
      )
    ).rows[0] || null;

    if (!user) {
      user = (
        await mlDb.query(
          `insert into ${schema}.usuarios
            (nome, email, senha_hash, nivel, status, user_global_id)
           values ($1, $2, $3, 'usuario', 'ativo', $4)
           returning id, nome, email, nivel, status, user_global_id`,
          [userName, email, passwordHash, userGlobalId],
        )
      ).rows[0] || null;
    } else {
      user = (
        await mlDb.query(
          `update ${schema}.usuarios
              set user_global_id = $2
            where id = $1
        returning id, nome, email, nivel, status, user_global_id`,
          [user.id, userGlobalId],
        )
      ).rows[0] || user;
    }

    let role = normalizeMlCompanyRole(payload?.role);
    const userLevel = String(user?.nivel || "").trim().toLowerCase();
    if (
      role !== "owner" &&
      (userLevel === "administrador" || userLevel === "admin_master")
    ) {
      role = "admin";
    }

    if (company?.id && user?.id) {
      await mlDb.query(
        `insert into ${schema}.empresa_usuarios (empresa_id, usuario_id, papel)
         values ($1, $2, $3)
         on conflict (empresa_id, usuario_id)
         do update set papel = excluded.papel`,
        [company.id, user.id, role],
      );
    }

    await mlDb.query("commit");
    return user;
  } catch (error) {
    await mlDb.query("rollback").catch(() => {});
    throw error;
  }
}

async function bootstrapMlSession(payload, res) {
  const email = String(payload?.email || "").trim().toLowerCase();
  if (!email) return;

  const jwtSecret =
    String(process.env.ML_JWT_SECRET || "").trim() ||
    String(process.env.JWT_SECRET || "").trim();
  if (!jwtSecret) return;

  const schema = getMlAuthSchema();

  let { rows } = await mlDb.query(
    `select id, nome, email, nivel, status
       from ${schema}.usuarios
      where lower(email) = $1
        and lower(coalesce(status, 'ativo')) <> 'inativo'
      limit 1`,
    [email],
  );

  let user = rows[0] || null;
  if (!user) {
    const provisionedUser = await provisionMlUserFromSuitePayload(payload);
    if (provisionedUser?.id) {
      ({ rows } = await mlDb.query(
        `select id, nome, email, nivel, status
           from ${schema}.usuarios
          where id = $1
          limit 1`,
        [provisionedUser.id],
      ));
      user = rows[0] || provisionedUser;
    }
  }

  if (!user?.id) return;
  if (String(user.status || "ativo").trim().toLowerCase() === "inativo") {
    return;
  }

  const token = jwt.sign(
    {
      uid: user.id,
      email: String(user.email || email).trim().toLowerCase(),
      nivel: String(user.nivel || "usuario").trim().toLowerCase(),
      nome: String(user.nome || "").trim() || null,
    },
    jwtSecret,
    { expiresIn: "24h" },
  );

  res.cookie("auth_token", token, cookieOptions(24 * 60 * 60 * 1000));
}

async function bootstrapSkuLeaderSession(payload, res) {
  const jwtSecret =
    String(process.env.SKULEADER_JWT_SECRET || "").trim() ||
    String(process.env.JWT_SECRET || "").trim() ||
    String(process.env.ML_JWT_SECRET || "").trim();
  if (!jwtSecret) return;

  const tenantGlobalId = String(payload?.tenant_id || "").trim();
  const userGlobalId = String(payload?.user_id || "").trim();
  const email = String(payload?.email || "").trim().toLowerCase();
  if (!tenantGlobalId || !userGlobalId || !email) return;

  const token = jwt.sign(
    {
      user_global_id: userGlobalId,
      tenant_global_id: tenantGlobalId,
      empresa_id: null,
      empresa_nome:
        String(payload?.company_name || "").trim() || "Empresa DACHBYTE",
      email,
      nivel: "global",
      nome: String(payload?.name || "").trim() || null,
    },
    jwtSecret,
    { expiresIn: "12h" },
  );

  res.cookie(
    "skuleader_auth_token",
    token,
    cookieOptions(12 * 60 * 60 * 1000),
  );
}

async function resolveProvisionedShopeeRole(client) {
  const rows = (
    await client.query(`
      SELECT e.enumlabel
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid
      JOIN pg_type t ON t.oid = a.atttypid
      JOIN pg_enum e ON e.enumtypid = t.oid
      WHERE n.nspname = 'public'
        AND c.relname = 'User'
        AND a.attname = 'role'
      ORDER BY e.enumsortorder
    `)
  ).rows || [];
  const labels = rows.map((row) => String(row.enumlabel || "")).filter(Boolean);
  if (labels.length === 0) {
    const fallbackRow = (
      await client.query(`
        SELECT role
        FROM "User"
        WHERE role IS NOT NULL
        LIMIT 1
      `)
    ).rows?.[0];
    if (fallbackRow?.role) return String(fallbackRow.role);
    throw new Error("Nao foi possivel resolver enum de role para provisionamento Shopee.");
  }

  const preferred = [
    "VIEWER",
    "viewer",
    "OPERATOR",
    "operator",
    "USER",
    "user",
    "MEMBER",
    "member",
    "MANAGER",
    "manager",
    "ADMIN",
    "admin",
  ];
  const preferredRole = preferred.find((role) => labels.includes(role));
  return preferredRole || labels[0];
}

async function provisionShopeeUserFromSuitePayload(payload) {
  const email = String(payload?.email || "")
    .trim()
    .toLowerCase();
  const tenantGlobalId = String(payload?.tenant_id || "").trim();
  const userGlobalId = String(payload?.user_id || "").trim();

  if (!email || !tenantGlobalId || !userGlobalId) return null;

  const accountName =
    String(payload?.company_name || "").trim() || "Empresa DACHBYTE";
  const userName =
    String(payload?.name || payload?.full_name || email || "Usuario DACHBYTE").trim();
  const passwordHash = await bcrypt.hash(
    crypto.randomBytes(24).toString("base64url"),
    10,
  );

  return withShopeeClient(async (client) => {
    await client.query("BEGIN");
    try {
      let account = (
        await client.query(
          'SELECT id, name, "tenantGlobalId" AS tenant_global_id FROM "Account" WHERE "tenantGlobalId" = $1 LIMIT 1',
          [tenantGlobalId],
        )
      ).rows[0] || null;

      if (!account) {
        const accountId = await reserveNextShopeeNumericId(client, "Account");
        account = (
          await client.query(
            'INSERT INTO "Account" (id, name, "tenantGlobalId", "createdAt", "updatedAt") VALUES ($1, $2, $3, NOW(), NOW()) RETURNING id',
            [accountId, accountName, tenantGlobalId],
          )
        ).rows[0] || null;
      }

      let user = (
        await client.query(
          'SELECT id, "accountId" AS account_id, status, "userGlobalId" AS user_global_id FROM "User" WHERE email = $1 LIMIT 1',
          [email],
        )
      ).rows[0] || null;

      if (!user) {
        const role = await resolveProvisionedShopeeRole(client);
        const userId = await reserveNextShopeeNumericId(client, "User");
        const accountId = Number(account?.id) || null;
        user = (
          await client.query(
            'INSERT INTO "User" (id, name, email, "passwordHash", role, status, "accountId", "userGlobalId", "createdAt", "updatedAt", "activatedAt") VALUES ($1, $2, $3, $4, $5, \'ACTIVE\', $6, $7, NOW(), NOW(), NOW()) RETURNING id, status, "accountId" AS account_id',
            [userId, userName, email, passwordHash, role, accountId, userGlobalId],
          )
        ).rows[0] || null;
      } else {
        user = (
          await client.query(
            'UPDATE "User" SET "userGlobalId" = $2, "accountId" = $3, status = \'ACTIVE\', "activatedAt" = COALESCE("activatedAt", NOW()), "activationTokenHash" = NULL, "activationExpiresAt" = NULL, "activationSentAt" = NULL, "updatedAt" = NOW() WHERE id = $1 RETURNING id, status, "accountId" AS account_id',
            [user.id, userGlobalId, Number(account?.id) || null],
          )
        ).rows[0] || user;
      }

      await client.query("COMMIT");
      return user ? { id: Number(user.id), status: String(user.status || "ACTIVE"), accountId: user.account_id == null ? null : Number(user.account_id) } : null;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    }
  });
}

async function bootstrapShopeeSession(payload, res) {
  const email = String(payload?.email || "")
    .trim()
    .toLowerCase();
  if (!email) return;

  let user = await findShopeeUserByEmail(email);
  if (!user) {
    user = await provisionShopeeUserFromSuitePayload(payload);
  }
  if (!user?.id) return;

  const status = String(user.status || "ACTIVE").toUpperCase();
  if (status === "INACTIVE") return;

  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const session = await createShopeeSessionForUser(user.id, expiresAt);
  if (!session?.id) return;

  // Remove the legacy, more-specific cookie so it cannot override this session.
  res.clearCookie("sid", { path: "/shopee" });
  res.cookie("sid", session.id, {
    httpOnly: true,
    secure: isProdEnv(),
    sameSite: "lax",
    path: "/",
  });

  const accountId = Number(user.accountId ?? user.account_id ?? 0) || null;
  if (!accountId) return "/shopee/?tab=auth&startOauth=1";

  const shopsCount = await countShopeeShopsByAccountId(accountId).catch(() => 0);
  return Number(shopsCount || 0) > 0 ? "/shopee/" : "/shopee/?tab=auth&startOauth=1";
}

async function bootstrapMagaluSession(payload) {
  const tenantId = String(payload?.tenant_id || "").trim();
  const userId = String(payload?.user_id || "").trim();
  const email = String(payload?.email || "").trim().toLowerCase();
  if (!tenantId || !userId || !email) return null;

  // O módulo Magalu usa a identidade global da suíte diretamente. Não cria
  // usuário local e não importa autenticação de ML/Shopee.
  return "/magalu/";
}

async function bootstrapModuleSession(moduleId, payload, res) {
  if (moduleId === "ml") {
    return bootstrapMlSession(payload, res);
  }
  if (moduleId === "shopee") {
    return bootstrapShopeeSession(payload, res);
  }
  if (moduleId === "magalu") {
    return bootstrapMagaluSession(payload, res);
  }
  if (moduleId === "skuleader") {
    return bootstrapSkuLeaderSession(payload, res);
  }
}

function getVoltCorpPublicUrl() {
  return String(
    process.env.VOLT_CORP_PUBLIC_URL ||
      process.env.VOLT_CORP_URL ||
      "https://volt-corp.onrender.com",
  )
    .trim()
    .replace(/\/+$/, "");
}

function createExternalVoltStockHandler() {
  return async (req, res) => {
    const payload = readSuitePayload(req);
    if (!payload) {
      return res.redirect("/login");
    }

    if (!hasModuleAccess(payload, "voltstock")) {
      return res.redirect("/selecao-plataforma?module=denied");
    }

    return res.redirect(`${getVoltCorpPublicUrl()}/voltstock`);
  };
}

async function main() {
  const app = express();

  app.set("trust proxy", 1);
  app.set("etag", false);
  app.use(cookieParser());

  app.use(express.json({ limit: "2mb" }));
  app.use(express.urlencoded({ extended: true }));

  // Canonical Seller routes are registered below the public landing pages.
  // This lets the commercial roots remain pages while nested product paths
  // continue to redirect to their existing application mounts.
  const { registerCanonicalRoutes } = require("../../platform/gateway");

  // The gateway owns the public Seller pages, not the Seller application.
  // Keep the landing-page mark available without mounting the product's app or
  // its complete static surface in this process.
  app.get("/ml/img/dachbyte-seller-mark.svg", (_req, res) => {
    return res.sendFile(
      path.join(__dirname, "..", "seller-ml", "public", "img", "dachbyte-seller-mark.svg"),
    );
  });
  app.use("/images", express.static(path.join(__dirname, "..", "..", "images")));
  app.use(
    "/seller-assets",
    express.static(path.join(__dirname, "..", "seller-ml", "public"), {
      immutable: true,
      maxAge: "7d",
    }),
  );
  app.use("/brand", express.static(path.join(__dirname, "..", "..", "public", "brand"), {
    immutable: true,
    maxAge: "7d",
  }));

  const publicCommercialContactRoutes = require("../seller-ml/routes/publicCommercialContactRoutes");
  const suiteAuthRoutes = require("../../routes/suiteAuthRoutes");
  const sacSupportRoutes = require("../../routes/sacSupportRoutes");
  app.use("/api/contact", publicCommercialContactRoutes);
  app.use("/api/auth", suiteAuthRoutes);
  app.use("/api/sac", sacSupportRoutes);
  app.use(
    "/support",
    express.static(path.join(__dirname, "..", "..", "public", "support"), {
      immutable: false,
      maxAge: "5m",
      setHeaders(res, filePath) {
        if (/sac-admin\.(?:css|js|html)$/i.test(filePath)) {
          res.setHeader("cache-control", "no-store, max-age=0");
        }
      },
    }),
  );
  app.get("/support-widget.js", (_req, res) => {
    res.set("cache-control", "no-store, max-age=0");
    return res.sendFile(
      path.join(__dirname, "..", "..", "public", "support", "davantti-support-widget.js"),
    );
  });
  app.get("/support-widget.css", (_req, res) => {
    res.set("cache-control", "no-store, max-age=0");
    return res.sendFile(
      path.join(__dirname, "..", "..", "public", "support", "davantti-support-widget.css"),
    );
  });
  app.get(["/sacdavantti", "/sacdavantti/"], (_req, res) => {
    res.set("cache-control", "no-store, max-age=0");
    return res.sendFile(path.join(__dirname, "..", "..", "public", "support", "sac-admin.html"));
  });
  app.use(createSupportWidgetInjector());

  app.get("/healthz", (_req, res) =>
    res.json({ ok: true, app: "davanttiSuite", brand: DACHBYTE_BRAND.name }),
  );

  // Compatibilidade OAuth:
  // se o callback for configurado sem prefixo /ml no app do Mercado Livre,
  // redireciona para a rota real montada dentro do módulo ML.
  app.get("/api/meli/oauth/callback", (req, res) => {
    const query = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
    return res.redirect(302, `/ml/api/meli/oauth/callback${query}`);
  });

  const sellerViewRoot = path.join(__dirname, "views", "seller");
  function sendSellerLanding(fileName) {
    return (_req, res) => res.sendFile(path.join(sellerViewRoot, fileName));
  }

  app.get(["/seller", "/seller/", "/dach/seller", "/dach/seller/"], sendSellerLanding("landing-general.html"));
  app.get(["/seller/mercado-livre", "/seller/mercado-livre/", "/dach/seller/mercado-livre", "/dach/seller/mercado-livre/"], sendSellerLanding("landing-mercado-livre.html"));
  app.get(["/seller/shopee", "/seller/shopee/", "/dach/seller/shopee", "/dach/seller/shopee/"], sendSellerLanding("landing-shopee.html"));
  app.get(["/seller/rastreio", "/seller/rastreio/", "/seller/tracking", "/seller/tracking/", "/dach/seller/rastreio", "/dach/seller/rastreio/", "/dach/seller/tracking", "/dach/seller/tracking/"], sendSellerLanding("landing-tracking.html"));
  app.get(["/seller/magalu", "/seller/magalu/"], sendSellerLanding("landing-magalu.html"));
  app.get(["/seller/magalu/termos", "/seller/magalu/termos/"], sendSellerLanding("legal-magalu-terms.html"));
  app.get(["/seller/magalu/privacidade", "/seller/magalu/privacidade/"], sendSellerLanding("legal-magalu-privacy.html"));

  // Preserve old links and authenticated product routes after the public
  // landing roots have had a chance to match.
  registerCanonicalRoutes(app, "seller");

  app.get("/", (req, res) => {
    if (hasShopeeOauthQuery(req.query)) {
      const queryString = buildShopeeOauthCallbackQuery(req.query);
      const nextUrl = queryString
        ? `/shopee/auth/callback?${queryString}`
        : "/shopee/auth/callback";
      return res.redirect(nextUrl);
    }

    return res.sendFile(path.join(sellerViewRoot, "landing-general.html"));
  });

  app.get("/landing", (req, res) => {
    if (hasShopeeOauthQuery(req.query)) {
      const queryString = buildShopeeOauthCallbackQuery(req.query);
      const nextUrl = queryString
        ? `/shopee/auth/callback?${queryString}`
        : "/shopee/auth/callback";
      return res.redirect(nextUrl);
    }

    return res.sendFile(path.join(sellerViewRoot, "landing-general.html"));
  });

  app.get("/login", (_req, res) => {
    return res.sendFile(
      path.join(__dirname, "..", "seller-ml", "views", "login.html"),
    );
  });

  app.get("/esqueci-senha", (_req, res) => {
    return res.redirect(302, "/ml/esqueci-senha");
  });

  app.get("/redefinir-senha", (req, res) => {
    const query = req.url.includes("?")
      ? req.url.slice(req.url.indexOf("?"))
      : "";
    return res.redirect(302, `/ml/redefinir-senha${query}`);
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
    (_req, res) => {
      return res.sendFile(
        path.join(__dirname, "..", "seller-ml", "views", "privacy-davantti-cloner.html"),
      );
    },
  );

  app.get("/selecao-plataforma", (_req, res) => {
    return res.sendFile(
      path.join(__dirname, "..", "seller-ml", "views", "selecao-plataforma.html"),
    );
  });

  app.get("/em-desenvolvimento", (_req, res) => {
    return res.redirect("/go/madeiramadeira");
  });

  app.get("/go/ml", createSuiteGoHandler("ml", "/ml"));
  app.get("/go/shopee", createSuiteGoHandler("shopee", "/shopee"));
  app.get("/go/magalu", createSuiteGoHandler("magalu", "/magalu/"));
  app.get(
    "/go/madeiramadeira",
    createSuiteGoHandler("madeiramadeira", "/madeiramadeira"),
  );
  app.get("/go/tracking", createSuiteGoHandler("tracking", "/avantracking"));
  app.get("/go/davanttilog", createSuiteGoHandler("davanttilog", "/davanttilog"));
  app.get("/go/skuleader", createSuiteGoHandler("skuleader", "/skuleader"));
  app.get("/go/ads", createSuiteGoHandler("dach_ads", "/ads/app", {
    loginPath: "/ads/login",
    deniedPath: "/ads/access-denied",
  }));
  app.get("/go/voltstock", createExternalVoltStockHandler());

  app.use((req, res) => {
    res.status(404).json({
      success: false,
      error: "Rota nao encontrada (suite)",
      path: req.originalUrl,
      method: req.method,
    });
  });

  const port = process.env.PORT || 3000;
  const server = app.listen(port, "0.0.0.0", () => {
    console.log(`Suite rodando na porta ${port}`);
  });

  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[SUITE] Recebido ${signal}, encerrando...`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10000);
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((error) => {
  console.error("[SUITE] Falha ao iniciar:", error);
  process.exit(1);
});
