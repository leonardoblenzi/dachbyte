"use strict";

const crypto = require("crypto");
const express = require("express");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const db = require("../db/db");
const { sendPasswordResetEmail } = require("../services/inviteEmailService");
const {
  cleanupAuthAudit,
  getRequestIp,
  getRequestUserAgent,
  recordAuthEvent,
} = require("../services/authAuditService");
const {
  authRateLimiter,
  validateStrongPassword,
} = require("../middleware/security");
const { evaluateHubLoginAccess } = require("../services/hubAccessService");
const {
  applySelectedAccountCookie,
  getDefaultAccountForUser,
  isMasterUser,
} = require("../services/defaultMeliAccount");

const router = express.Router();

const JWT_SECRET = process.env.ML_JWT_SECRET || process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error(
    "JWT_SECRET nao definido. Configure ML_JWT_SECRET ou JWT_SECRET no ambiente.",
  );
}

const isProd =
  String(process.env.NODE_ENV || "").toLowerCase() === "production";

const ALLOW_USER_LOGIN =
  String(process.env.ALLOW_USER_LOGIN ?? "true").toLowerCase() === "true";

const AUTH_SCHEMA =
  String(process.env.AUTH_DB_SCHEMA || db.ML_DB_SCHEMA || "ml")
    .trim()
    .replace(/[^a-zA-Z0-9_]/g, "") || "ml";

function T(name) {
  return `${AUTH_SCHEMA}.${name}`;
}

function normalizeHubConfigValue(raw) {
  const value = String(raw ?? "").trim();
  if (!value || ["0", "false", "null", "undefined", "off", "none", "disabled", "(not set)"].includes(value.toLowerCase())) {
    return "";
  }
  return value;
}

function isHubLoginFallbackEnabled() {
  const mode = String(process.env.HUB_LOGIN_MODE || "fallback").trim().toLowerCase();
  return mode === "fallback" || mode === "mirror";
}

async function verifyHubGlobalLogin({ email, password, module }) {
  if (!isHubLoginFallbackEnabled()) return { allow: false, reason: "hub_login_disabled" };
  const hubBaseUrl = normalizeHubConfigValue(process.env.HUB_BASE_URL).replace(/\/+$/, "");
  const hubToken = normalizeHubConfigValue(process.env.HUB_INTERNAL_TOKEN);
  if (!hubBaseUrl || !hubToken) return { allow: false, reason: "hub_not_configured" };

  try {
    const response = await fetch(`${hubBaseUrl}/v1/internal/auth/verify`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${hubToken}`,
      },
      body: JSON.stringify({ email, password, module }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) return { allow: false, reason: payload?.reason || payload?.error || `hub_auth_${response.status}` };
    return payload?.allow ? { allow: true, payload } : { allow: false, reason: payload?.reason || "hub_denied" };
  } catch (error) {
    return { allow: false, reason: error?.message || "hub_unreachable" };
  }
}
function hubPayload(hubLogin) {
  return hubLogin?.payload || {};
}

function hubFallbackName(payload, email, fallback) {
  return String(payload?.name || payload?.full_name || fallback || email || "Usuario Davantti").trim();
}

function normalizeHubCompanyRole(role) {
  const normalized = String(role || "member").trim().toLowerCase();
  if (["owner", "proprietario", "proprietário"].includes(normalized)) return "owner";
  if (["admin", "administrador"].includes(normalized)) return "admin";
  return "operador";
}

async function provisionMlUserFromHubLogin({ email, hubLogin }) {
  const payload = hubPayload(hubLogin);
  const tenantGlobalId = String(payload?.tenant_id || "").trim();
  const userGlobalId = String(payload?.user_id || "").trim();
  if (!tenantGlobalId || !userGlobalId) return null;
  const companyName = String(payload?.company_name || "Empresa Davantti").trim() || "Empresa Davantti";
  const userName = hubFallbackName(payload, email, null);
  let role = normalizeHubCompanyRole(payload?.role);
  const passwordHash = await bcrypt.hash(createTemporaryPassword(), 10);
  await db.query("begin");
  try {
    let company = (await db.query("select id, nome, tenant_global_id from " + T("empresas") + " where tenant_global_id = $1 limit 1", [tenantGlobalId])).rows[0] || null;
    if (!company) {
      company = (await db.query("insert into " + T("empresas") + " (nome, tenant_global_id) values ($1, $2) returning id, nome, tenant_global_id", [companyName, tenantGlobalId])).rows[0] || null;
    }
    let user = (await db.query("select id, nome, email, senha_hash, nivel, status, user_global_id from " + T("usuarios") + " where email = $1 limit 1", [email])).rows[0] || null;
    if (!user) {
      user = (await db.query("insert into " + T("usuarios") + " (nome, email, senha_hash, nivel, status, user_global_id) values ($1, $2, $3, 'usuario', 'ativo', $4) returning id, nome, email, senha_hash, nivel, status, user_global_id", [userName, email, passwordHash, userGlobalId])).rows[0] || null;
    } else {
      await db.query("update " + T("usuarios") + " set user_global_id = $2 where id = $1", [user.id, userGlobalId]);
      user = { ...user, user_global_id: userGlobalId };
    }
    if (role !== "owner" && ["administrador", "admin_master"].includes(normalizeNivel(user?.nivel))) {
      role = "admin";
    }
    if (company && user) {
      await db.query("insert into " + T("empresa_usuarios") + " (empresa_id, usuario_id, papel) values ($1, $2, $3) on conflict (empresa_id, usuario_id) do update set papel = excluded.papel", [company.id, user.id, role]);
    }
    await db.query("commit");
    return user;
  } catch (error) {
    await db.query("rollback").catch(() => {});
    throw error;
  }
}

function normalizeNivel(n) {
  return String(n || "")
    .trim()
    .toLowerCase();
}

function isAdmin(nivel) {
  return normalizeNivel(nivel) === "administrador";
}

function isMaster(nivel) {
  return normalizeNivel(nivel) === "admin_master";
}

const HUB_ACCESS_TTL_MS = 24 * 60 * 60 * 1000;
const HUB_ACCESS_TTL_SECONDS = HUB_ACCESS_TTL_MS / 1000;

function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: "24h" });
}

function wantsExtensionToken(req) {
  const client = String(req.body?.client || req.body?.app || "").trim().toLowerCase();
  return client === "davantti-extension" || client === "ml-cloner-extension";
}

function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: isProd,
    maxAge: HUB_ACCESS_TTL_MS,
    path: "/",
  };
}

function baseFromReq(req) {
  const full = String(req.originalUrl || req.baseUrl || "");
  const apiIndex = full.indexOf("/api/");
  if (apiIndex >= 0) return full.slice(0, apiIndex) || "";
  const authIndex = full.indexOf("/auth");
  if (authIndex >= 0) return full.slice(0, authIndex) || "";
  return String(req.baseUrl || "");
}

function withBase(req, path) {
  const base = baseFromReq(req);
  const p = path.startsWith("/") ? path : `/${path}`;
  return base + p;
}

function appOrigin(req) {
  const configuredOriginRaw = String(
    process.env.ML_PUBLIC_ORIGIN ||
      process.env.PUBLIC_APP_ORIGIN ||
      process.env.APP_PUBLIC_URL ||
      "",
  ).trim();

  if (configuredOriginRaw) {
    try {
      return new URL(configuredOriginRaw).origin;
    } catch {
      // fallback para origem da request
    }
  }

  const proto = String(req.headers["x-forwarded-proto"] || req.protocol || "http")
    .split(",")[0]
    .trim();
  return `${proto}://${req.get("host")}`;
}

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token || "")).digest("hex");
}

function createActivationToken() {
  return crypto.randomBytes(32).toString("hex");
}

function createResetToken() {
  return crypto.randomBytes(32).toString("hex");
}

function createTemporaryPassword() {
  return crypto.randomBytes(24).toString("base64url");
}

function expiryDate(hours, fallback) {
  const n = Number(hours || fallback);
  const safeHours = Number.isFinite(n) && n > 0 ? n : fallback;
  return new Date(Date.now() + safeHours * 60 * 60 * 1000);
}

function activationExpiryDate() {
  return expiryDate(process.env.ML_ACTIVATION_HOURS, 48);
}

function resetExpiryDate() {
  return expiryDate(process.env.ML_RESET_HOURS, 1);
}

function buildActivationLink(req, token) {
  return `${appOrigin(req)}${withBase(req, `/ativar?token=${encodeURIComponent(token)}`)}`;
}

function buildResetLink(req, token) {
  return `${appOrigin(req)}${withBase(req, `/redefinir-senha?token=${encodeURIComponent(token)}`)}`;
}

async function findActivationUserByToken(token) {
  const { rows } = await db.query(
    `select id, nome, email, status, activation_expires_at
       from ${T("usuarios")}
      where activation_token_hash = $1
      limit 1`,
    [hashToken(token)],
  );
  return rows[0] || null;
}

async function findResetUserByToken(token) {
  const { rows } = await db.query(
    `select id, nome, email, status, reset_expires_at
       from ${T("usuarios")}
      where reset_token_hash = $1
      limit 1`,
    [hashToken(token)],
  );
  return rows[0] || null;
}

async function findPrimaryCompanyForUser(userId, preferredTenantGlobalId = null) {
  const preferredTenant = String(preferredTenantGlobalId || "").trim();
  const { rows } = await db.query(
    `select e.id as empresa_id,
            e.nome as company_name,
            e.document_type,
            e.document_number,
            e.tenant_global_id,
            eu.papel
       from ${T("empresa_usuarios")} eu
       join ${T("empresas")} e on e.id = eu.empresa_id
      where eu.usuario_id = $1
      order by case when $2 <> '' and e.tenant_global_id = $2 then 0 else 1 end,
               case eu.papel when 'owner' then 1 when 'admin' then 2 else 3 end,
               e.id asc
      limit 1`,
    [userId, preferredTenant],
  );
  return rows[0] || null;
}

async function ensureHubAccessCacheTable() {
  await db.query(`
    create table if not exists ${T("hub_access_cache")} (
      id bigserial primary key,
      local_user_id integer not null,
      local_empresa_id integer not null,
      module text not null,
      allow boolean not null default false,
      reason text,
      hub_status text,
      checked_at timestamptz not null default now(),
      expires_at timestamptz not null,
      metadata_json jsonb not null default '{}'::jsonb,
      updated_at timestamptz not null default now(),
      unique (local_user_id, local_empresa_id, module)
    )
  `);
}

function toIso(value) {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date.toISOString() : null;
}

function isHubTechnicalFailure(hubAccess) {
  const reason = String(hubAccess?.reason || "").trim().toLowerCase();
  if (
    reason === "hub_unreachable" ||
    reason === "hub_access_check_failed" ||
    reason === "hub_identity_sync_failed"
  ) {
    return true;
  }
  const status = Number(hubAccess?.status || 0);
  return Number.isFinite(status) && status >= 500;
}

async function readValidHubAccessCache(userId, company, moduleName = "ml") {
  const localEmpresaId = Number(company?.empresa_id);
  if (!Number.isFinite(Number(userId)) || !Number.isFinite(localEmpresaId)) {
    return null;
  }

  try {
    await ensureHubAccessCacheTable();
    const { rows } = await db.query(
      `select allow, reason, hub_status, checked_at, expires_at, metadata_json
         from ${T("hub_access_cache")}
        where local_user_id = $1
          and local_empresa_id = $2
          and module = $3
          and allow = true
          and expires_at > now()
        limit 1`,
      [Number(userId), localEmpresaId, moduleName],
    );
    const cached = rows[0] || null;
    if (!cached) return null;
    return {
      allow: true,
      reason: "hub_access_cached",
      cached: true,
      checked_at: toIso(cached.checked_at),
      expires_at: toIso(cached.expires_at),
      hub_reason: cached.reason || null,
      hub_status: cached.hub_status || null,
      metadata: cached.metadata_json || {},
    };
  } catch (error) {
    console.warn("⚠️ [ML] Falha ao ler cache de acesso Hub:", error?.message || error);
    return null;
  }
}

async function rememberHubAccess(userId, company, hubAccess, moduleName = "ml") {
  const localEmpresaId = Number(company?.empresa_id);
  if (!Number.isFinite(Number(userId)) || !Number.isFinite(localEmpresaId)) {
    return null;
  }

  const checkedAt = new Date();
  const expiresAt = new Date(checkedAt.getTime() + HUB_ACCESS_TTL_MS);
  const metadata = {
    tenant_status: hubAccess?.tenant_status || null,
    status: hubAccess?.status || null,
    reason: hubAccess?.reason || null,
  };

  try {
    await ensureHubAccessCacheTable();
    const { rows } = await db.query(
      `insert into ${T("hub_access_cache")} (
         local_user_id,
         local_empresa_id,
         module,
         allow,
         reason,
         hub_status,
         checked_at,
         expires_at,
         metadata_json,
         updated_at
       )
       values ($1, $2, $3, true, $4, $5, $6, $7, $8::jsonb, now())
       on conflict (local_user_id, local_empresa_id, module) do update
       set allow = excluded.allow,
           reason = excluded.reason,
           hub_status = excluded.hub_status,
           checked_at = excluded.checked_at,
           expires_at = excluded.expires_at,
           metadata_json = excluded.metadata_json,
           updated_at = now()
       returning checked_at, expires_at`,
      [
        Number(userId),
        localEmpresaId,
        moduleName,
        hubAccess?.reason || "ok",
        hubAccess?.status || null,
        checkedAt,
        expiresAt,
        JSON.stringify(metadata),
      ],
    );
    return {
      checked_at: toIso(rows[0]?.checked_at) || checkedAt.toISOString(),
      expires_at: toIso(rows[0]?.expires_at) || expiresAt.toISOString(),
    };
  } catch (error) {
    console.warn("⚠️ [ML] Falha ao salvar cache de acesso Hub:", error?.message || error);
    return {
      checked_at: checkedAt.toISOString(),
      expires_at: expiresAt.toISOString(),
    };
  }
}

async function clearHubAccessCache(userId, company, moduleName = "ml") {
  const localEmpresaId = Number(company?.empresa_id);
  if (!Number.isFinite(Number(userId)) || !Number.isFinite(localEmpresaId)) {
    return;
  }

  try {
    await ensureHubAccessCacheTable();
    await db.query(
      `delete from ${T("hub_access_cache")}
        where local_user_id = $1
          and local_empresa_id = $2
          and module = $3`,
      [Number(userId), localEmpresaId, moduleName],
    );
  } catch (error) {
    console.warn("⚠️ [ML] Falha ao limpar cache de acesso Hub:", error?.message || error);
  }
}

function isExpired(dateValue) {
  const d = dateValue ? new Date(dateValue) : null;
  return !d || Number.isNaN(d.getTime()) || d < new Date();
}

async function audit(req, payload) {
  await cleanupAuthAudit().catch(() => {});
  await recordAuthEvent({
    ...payload,
    ip: getRequestIp(req),
    userAgent: getRequestUserAgent(req),
  }).catch(() => {});
}

async function sendResetEmailSafe({ email, nome, resetLink, expiresAt }) {
  try {
    return await sendPasswordResetEmail({
      toEmail: email,
      toName: nome,
      resetLink,
      expiresAt,
    });
  } catch (err) {
    return {
      sent: false,
      skipped: false,
      error: err?.message || "Falha ao enviar email de reset.",
    };
  }
}

router.post("/register", express.json({ limit: "1mb" }), async (_req, res) => {
  return res.status(403).json({
    ok: false,
    error:
      "Cadastro publico desativado. O acesso e liberado somente por convite.",
  });
});

router.post(
  "/login",
  authRateLimiter,
  express.json({ limit: "200kb" }),
  async (req, res) => {
  try {
    const email = String(req.body?.email || "")
      .trim()
      .toLowerCase();
    const senha = String(req.body?.senha || "");

    if (!email || !senha) {
      return res
        .status(400)
        .json({ ok: false, error: "Informe email e senha." });
    }

    const { rows } = await db.query(
      `select id, nome, email, senha_hash, nivel, status, user_global_id
         from ${T("usuarios")}
        where email = $1
        limit 1`,
      [email],
    );

    let user = rows[0];
    let hubLogin = null;
    if (!user) {
      hubLogin = await verifyHubGlobalLogin({ email, password: senha, module: "ml" });
      if (hubLogin.allow) {
        user = await provisionMlUserFromHubLogin({ email, hubLogin });
      }
    }

    if (!user) {
      await audit(req, {
        email,
        evento: "login_failed",
        status: "error",
        metadata: { reason: hubLogin?.reason || "user_not_found" },
      });
      return res
        .status(401)
        .json({ ok: false, error: "Credenciais invalidas." });
    }

    const status = String(user.status || "ativo").trim().toLowerCase();
    if (status === "pendente_ativacao") {
      await audit(req, {
        userId: user.id,
        email,
        evento: "login_blocked",
        status: "warn",
        metadata: { reason: "pending_activation" },
      });
      return res.status(403).json({
        ok: false,
        error:
          "Sua conta ainda nao foi ativada. Use o link de convite enviado para definir sua senha.",
      });
    }

    if (status === "inativo") {
      await audit(req, {
        userId: user.id,
        email,
        evento: "login_blocked",
        status: "warn",
        metadata: { reason: "inactive" },
      });
      return res.status(403).json({
        ok: false,
        error: "Sua conta esta inativa. Fale com o administrador do workspace.",
      });
    }

    const nivel = normalizeNivel(user.nivel);

    if (!ALLOW_USER_LOGIN && nivel === "usuario") {
      await audit(req, {
        userId: user.id,
        email,
        evento: "login_blocked",
        status: "warn",
        metadata: { reason: "user_login_disabled" },
      });
      return res.status(403).json({
        ok: false,
        error:
          "Acesso desativado para usuarios comuns. Use uma conta administrativa.",
      });
    }

    let ok = Boolean(hubLogin?.allow) || await bcrypt.compare(senha, user.senha_hash);
    if (!ok) {
      hubLogin = await verifyHubGlobalLogin({ email, password: senha, module: "ml" });
      ok = Boolean(hubLogin.allow);
    }
    if (!ok) {
      await audit(req, {
        userId: user.id,
        email,
        evento: "login_failed",
        status: "error",
        metadata: { reason: hubLogin?.reason || "bad_password" },
      });
      return res
        .status(401)
        .json({ ok: false, error: "Credenciais invalidas." });
    }

    const preferredTenantGlobalId = hubLogin?.allow
      ? String(hubPayload(hubLogin)?.tenant_id || "").trim()
      : "";
    if (hubLogin?.allow) {
      const provisionedUser = await provisionMlUserFromHubLogin({ email, hubLogin });
      if (provisionedUser) {
        user = { ...user, ...provisionedUser };
      }
    }

    const company = await findPrimaryCompanyForUser(user.id, preferredTenantGlobalId);
    let hubAccess = await evaluateHubLoginAccess({
      user: {
        id: user.id,
        name: user.nome || null,
        email: user.email,
        user_global_id: user.user_global_id || null,
        nivel,
      },
      company,
      role: isAdmin(nivel) || isMaster(nivel) ? "admin" : "member",
      isMaster: isMaster(nivel),
    });
    let hubSession = null;

    if (!hubAccess.allow) {
      const cachedHubAccess = isHubTechnicalFailure(hubAccess)
        ? await readValidHubAccessCache(user.id, company, "ml")
        : null;

      if (cachedHubAccess?.allow) {
        hubAccess = {
          ...hubAccess,
          allow: true,
          reason: "hub_access_cache_grace",
          cached: true,
          checked_at: cachedHubAccess.checked_at,
          expires_at: cachedHubAccess.expires_at,
        };
        hubSession = {
          checked_at: cachedHubAccess.checked_at,
          expires_at: cachedHubAccess.expires_at,
          source: "cache",
          reason: cachedHubAccess.hub_reason || cachedHubAccess.reason,
        };
      }
    }

    if (!hubAccess.allow) {
      await clearHubAccessCache(user.id, company, "ml");
      await audit(req, {
        userId: user.id,
        email,
        evento: "login_blocked",
        status: "warn",
        metadata: {
          reason: "hub_denied",
          hub_reason: hubAccess.reason || null,
          hub_status: hubAccess.status || null,
          hub_tenant_status: hubAccess.tenant_status || null,
        },
      });
      return res.status(403).json({
        ok: false,
        error: hubAccess.message || "Acesso bloqueado pela politica de assinatura.",
        reason: hubAccess.reason || "hub_denied",
      });
    }

    if (!hubSession) {
      const remembered = await rememberHubAccess(user.id, company, hubAccess, "ml");
      hubSession = {
        checked_at: remembered?.checked_at || new Date().toISOString(),
        expires_at:
          remembered?.expires_at ||
          new Date(Date.now() + HUB_ACCESS_TTL_MS).toISOString(),
        source: "hub",
        reason: hubAccess.reason || "ok",
      };
    }

    await db.query(
      `update ${T("usuarios")} set ultimo_login_em = now() where id = $1`,
      [user.id],
    );

    const token = signToken({
      uid: user.id,
      email: user.email,
      nivel,
      nome: user.nome || null,
      hub_access: {
        module: "ml",
        checked_at: hubSession.checked_at,
        expires_at: hubSession.expires_at,
        source: hubSession.source,
        reason: hubSession.reason,
      },
    });

    res.cookie("auth_token", token, cookieOptions());
    await audit(req, {
      userId: user.id,
      email,
      evento: "login_success",
      status: "success",
    });

    let redirect = withBase(req, "/admin/dashboard");
    if (!isMasterUser({ ...user, nivel })) {
      const defaultAccount = await getDefaultAccountForUser(user.id);
      if (defaultAccount?.id) {
        applySelectedAccountCookie(res, defaultAccount.id);
        redirect = withBase(req, "/painel");
      } else {
        redirect = withBase(req, "/vincular-conta");
      }
    }

    const responsePayload = {
      ok: true,
      user: { id: user.id, nome: user.nome, email: user.email, nivel },
      redirect,
    };

    if (wantsExtensionToken(req)) {
      responsePayload.extension_token = token;
      responsePayload.token_type = "Bearer";
      responsePayload.expires_in = HUB_ACCESS_TTL_SECONDS;
    }

    return res.json(responsePayload);
  } catch (err) {
    console.error("POST /api/auth/login erro:", err);
    return res
      .status(500)
      .json({ ok: false, error: "Erro interno ao fazer login." });
  }
  },
);

router.post(
  "/forgot-password",
  authRateLimiter,
  express.json({ limit: "200kb" }),
  async (req, res) => {
    try {
      const email = String(req.body?.email || "")
        .trim()
        .toLowerCase();

      if (!email) {
        return res.status(400).json({
          ok: false,
          error: "Informe o email para recuperar a senha.",
        });
      }

      const { rows } = await db.query(
        `select id, nome, email, status
           from ${T("usuarios")}
          where email = $1
          limit 1`,
        [email],
      );
      const user = rows[0] || null;

      await audit(req, {
        userId: user?.id || null,
        email,
        evento: "password_reset_requested",
        status: "info",
      });

      if (user && String(user.status || "ativo").toLowerCase() === "ativo") {
        const resetToken = createResetToken();
        const resetExpiresAt = resetExpiryDate();
        const resetLink = buildResetLink(req, resetToken);

        await db.query(
          `update ${T("usuarios")}
              set reset_token_hash = $1,
                  reset_expires_at = $2,
                  reset_requested_at = now()
            where id = $3`,
          [hashToken(resetToken), resetExpiresAt, user.id],
        );

        const emailDelivery = await sendResetEmailSafe({
          email: user.email,
          nome: user.nome,
          resetLink,
          expiresAt: resetExpiresAt.toISOString(),
        });

        await audit(req, {
          userId: user.id,
          email,
          evento: "password_reset_email",
          status: emailDelivery.sent ? "success" : "warn",
          metadata: emailDelivery,
        });
      } else {
        await audit(req, {
          email,
          evento: "password_reset_email",
          status: "warn",
          metadata: { skipped: true, reason: "user_not_active_or_not_found" },
        });
      }

      return res.json({
        ok: true,
        message:
          "Se o email existir na base, enviaremos as instrucoes para redefinir a senha.",
      });
    } catch (err) {
      console.error("POST /api/auth/forgot-password erro:", err);
      return res.status(500).json({
        ok: false,
        error: "Erro interno ao solicitar a redefinicao de senha.",
      });
    }
  },
);

router.get("/reset-info", async (req, res) => {
  try {
    const token = String(req.query?.token || "").trim();
    if (!token) {
      return res.status(400).json({ ok: false, error: "Token ausente." });
    }

    const user = await findResetUserByToken(token);
    if (!user) {
      return res.status(404).json({ ok: false, error: "Link invalido." });
    }

    if (String(user.status || "ativo").toLowerCase() !== "ativo") {
      return res
        .status(403)
        .json({ ok: false, error: "A conta nao esta ativa para redefinicao." });
    }

    if (isExpired(user.reset_expires_at)) {
      return res.status(410).json({ ok: false, error: "Link expirado." });
    }

    return res.json({
      ok: true,
      reset: {
        nome: user.nome,
        email: user.email,
        expires_at: new Date(user.reset_expires_at).toISOString(),
      },
    });
  } catch (err) {
    console.error("GET /api/auth/reset-info erro:", err);
    return res
      .status(500)
      .json({ ok: false, error: "Erro interno ao validar o link." });
  }
});

router.post(
  "/reset-password",
  authRateLimiter,
  express.json({ limit: "200kb" }),
  async (req, res) => {
  try {
    const token = String(req.body?.token || "").trim();
    const senha = String(req.body?.senha || "");

    if (!token || !senha) {
      return res
        .status(400)
        .json({ ok: false, error: "Informe token e nova senha." });
    }

    const passwordCheck = validateStrongPassword(senha);
    if (!passwordCheck.ok) {
      return res.status(400).json({ ok: false, error: passwordCheck.error });
    }

    const user = await findResetUserByToken(token);
    if (!user) {
      await audit(req, {
        evento: "password_reset_completed",
        status: "error",
        metadata: { reason: "token_not_found" },
      });
      return res.status(404).json({ ok: false, error: "Link invalido." });
    }

    if (String(user.status || "ativo").toLowerCase() !== "ativo") {
      await audit(req, {
        userId: user.id,
        email: user.email,
        evento: "password_reset_completed",
        status: "warn",
        metadata: { reason: "user_not_active" },
      });
      return res
        .status(403)
        .json({ ok: false, error: "A conta nao esta ativa para redefinicao." });
    }

    if (isExpired(user.reset_expires_at)) {
      await audit(req, {
        userId: user.id,
        email: user.email,
        evento: "password_reset_completed",
        status: "warn",
        metadata: { reason: "token_expired" },
      });
      return res.status(410).json({ ok: false, error: "Link expirado." });
    }

    const senha_hash = await bcrypt.hash(senha, 10);
    await db.query(
      `update ${T("usuarios")}
          set senha_hash = $1,
              senha_alterada_em = now(),
              reset_token_hash = null,
              reset_expires_at = null
        where id = $2`,
      [senha_hash, user.id],
    );

    await audit(req, {
      userId: user.id,
      email: user.email,
      evento: "password_reset_completed",
      status: "success",
    });

    return res.json({
      ok: true,
      message: "Senha redefinida com sucesso.",
      redirect: withBase(req, "/login"),
    });
  } catch (err) {
    console.error("POST /api/auth/reset-password erro:", err);
    return res
      .status(500)
      .json({ ok: false, error: "Erro interno ao redefinir a senha." });
  }
  },
);

router.get("/activation-info", async (req, res) => {
  try {
    const token = String(req.query?.token || "").trim();
    if (!token) {
      return res.status(400).json({ ok: false, error: "Token ausente." });
    }

    const user = await findActivationUserByToken(token);
    if (!user) {
      return res.status(404).json({ ok: false, error: "Convite invalido." });
    }

    if (String(user.status || "").toLowerCase() !== "pendente_ativacao") {
      return res.status(409).json({
        ok: false,
        error: "Este convite ja foi utilizado ou a conta ja esta ativa.",
      });
    }

    if (isExpired(user.activation_expires_at)) {
      return res.status(410).json({ ok: false, error: "Convite expirado." });
    }

    return res.json({
      ok: true,
      convite: {
        nome: user.nome,
        email: user.email,
        expires_at: new Date(user.activation_expires_at).toISOString(),
      },
    });
  } catch (err) {
    console.error("GET /api/auth/activation-info erro:", err);
    return res
      .status(500)
      .json({ ok: false, error: "Erro interno ao validar convite." });
  }
});

router.post(
  "/activate",
  authRateLimiter,
  express.json({ limit: "200kb" }),
  async (req, res) => {
  try {
    const token = String(req.body?.token || "").trim();
    const senha = String(req.body?.senha || "");

    if (!token || !senha) {
      return res
        .status(400)
        .json({ ok: false, error: "Informe token e nova senha." });
    }

    const passwordCheck = validateStrongPassword(senha);
    if (!passwordCheck.ok) {
      return res.status(400).json({ ok: false, error: passwordCheck.error });
    }

    const user = await findActivationUserByToken(token);
    if (!user) {
      return res.status(404).json({ ok: false, error: "Convite invalido." });
    }

    if (String(user.status || "").toLowerCase() !== "pendente_ativacao") {
      return res.status(409).json({
        ok: false,
        error: "Este convite ja foi utilizado ou a conta ja esta ativa.",
      });
    }

    if (isExpired(user.activation_expires_at)) {
      return res.status(410).json({ ok: false, error: "Convite expirado." });
    }

    const senha_hash = await bcrypt.hash(senha, 10);

    const { rows } = await db.query(
      `update ${T("usuarios")}
          set senha_hash = $1,
              senha_alterada_em = now(),
              status = 'ativo',
              activated_at = now(),
              activation_token_hash = null,
              activation_expires_at = null,
              activation_sent_at = null
        where id = $2
      returning id, nome, email, nivel`,
      [senha_hash, user.id],
    );

    const activatedUser = rows[0];

    const authToken = signToken({
      uid: activatedUser.id,
      email: activatedUser.email,
      nivel: normalizeNivel(activatedUser.nivel),
      nome: activatedUser.nome || null,
    });

    res.cookie("auth_token", authToken, cookieOptions());
    await audit(req, {
      userId: activatedUser.id,
      email: activatedUser.email,
      evento: "invite_activated",
      status: "success",
    });

    return res.json({
      ok: true,
      user: {
        id: activatedUser.id,
        nome: activatedUser.nome,
        email: activatedUser.email,
        nivel: normalizeNivel(activatedUser.nivel),
      },
      redirect: withBase(req, "/vincular-conta"),
    });
  } catch (err) {
    console.error("POST /api/auth/activate erro:", err);
    return res
      .status(500)
      .json({ ok: false, error: "Erro interno ao ativar conta." });
  }
  },
);

router.post("/logout", (_req, res) => {
  res.clearCookie("auth_token", { path: "/", sameSite: "lax", secure: isProd });
  res.clearCookie("ml_account", { path: "/", sameSite: "lax", secure: isProd });
  res.clearCookie("meli_conta_id", { path: "/", sameSite: "lax", secure: isProd });
  res.clearCookie("meli_conta_id", { path: "/ml", sameSite: "lax", secure: isProd });
  return res.json({ ok: true });
});

router.get("/me", (req, res) => {
  try {
    const token = req.cookies?.auth_token;
    if (!token) return res.json({ ok: true, logged: false });

    const payload = jwt.verify(token, JWT_SECRET);
    const nivel = normalizeNivel(payload?.nivel);

    const _is_admin = isAdmin(nivel);
    const _is_master = isMaster(nivel);
    const _is_admin_any = _is_admin || _is_master;

    return res.json({
      ok: true,
      logged: true,
      user: { ...payload, nivel },
      is_admin: _is_admin,
      is_master: _is_master,
      is_admin_any: _is_admin_any,
      flags: {
        is_admin: _is_admin,
        is_master: _is_master,
        is_admin_any: _is_admin_any,
      },
    });
  } catch {
    return res.json({ ok: true, logged: false });
  }
});

module.exports = router;
module.exports.createActivationToken = createActivationToken;
module.exports.hashToken = hashToken;
module.exports.activationExpiryDate = activationExpiryDate;
module.exports.buildActivationLink = buildActivationLink;
module.exports.createTemporaryPassword = createTemporaryPassword;
