const crypto = require("crypto");
const express = require("express");
const bcrypt = require("bcrypt");
const { sessionAuth, requireAuth } = require("../middlewares/sessionAuth");
const { deleteSessionById, findShopForAccountById } = require("../repositories/runtimeSqlRepository");
const {
  activateUserAccount,
  countShopsByAccountId,
  createSessionForUser,
  findAccountById,
  findUserByActivationTokenHash,
  findUserByEmail,
  findUserByResetTokenHash,
  listShopsByAccountId,
  reserveNextNumericId,
  resetUserPassword,
  updatePasswordResetRequest,
  updateSessionActiveShopId,
  updateUserRole,
} = require("../repositories/authSqlRepository");
const { sendPasswordResetEmail } = require("../services/inviteEmailService");
const {
  cleanupAuthAudit,
  getRequestIp,
  getRequestUserAgent,
  recordAuthEvent,
} = require("../services/authAuditService");
const { evaluateHubLoginAccess } = require("../services/hubAccessService");
const { getEffectiveShopeeRole, isMasterAdminEmail } = require("../config/masterAdmin");
const { withClient } = require("../config/postgres");

const router = express.Router();

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

function toNullableInteger(value) {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

async function resolveProvisionedUserRole(client) {
  const rows = (await client.query(`
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
  `)).rows || [];
  const labels = rows.map((row) => String(row.enumlabel || "")).filter(Boolean);
  if (labels.length === 0) {
    const fallbackRow = (await client.query(`
      SELECT role
      FROM "User"
      WHERE role IS NOT NULL
      LIMIT 1
    `)).rows?.[0];
    if (fallbackRow?.role) return String(fallbackRow.role);
    throw new Error('Nao foi possivel resolver enum de role para provisionamento.');
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

async function provisionShopeeUserFromHubLogin({ email, hubLogin }) {
  const payload = hubPayload(hubLogin);
  const tenantGlobalId = String(payload?.tenant_id || "").trim();
  const userGlobalId = String(payload?.user_id || "").trim();
  if (!tenantGlobalId || !userGlobalId) return null;
  const accountName = String(payload?.company_name || "Empresa Davantti").trim() || "Empresa Davantti";
  const userName = String(payload?.name || payload?.full_name || email || "Usuario Davantti").trim();
  const passwordHash = await bcrypt.hash(createTemporaryPassword(), 10);
  return withClient(async (client) => {
    await client.query("BEGIN");
    try {
      let account = (await client.query('SELECT id, name, "tenantGlobalId" AS tenant_global_id FROM "Account" WHERE "tenantGlobalId" = $1 LIMIT 1', [tenantGlobalId])).rows[0] || null;
      if (!account) {
        const accountId = await reserveNextNumericId(client, "Account");
        account = (await client.query('INSERT INTO "Account" (id, name, "tenantGlobalId", "createdAt", "updatedAt") VALUES ($1, $2, $3, NOW(), NOW()) RETURNING id, name, "tenantGlobalId" AS tenant_global_id', [accountId, accountName, tenantGlobalId])).rows[0] || null;
      }
      let user = (await client.query('SELECT id, name, email, "passwordHash" AS password_hash, role, status, "accountId" AS account_id, "userGlobalId" AS user_global_id, "createdAt" AS created_at FROM "User" WHERE email = $1 LIMIT 1', [email])).rows[0] || null;
      if (!user) {
        const role = isMasterAdminEmail(email) ? "SUPER_ADMIN" : await resolveProvisionedUserRole(client);
        const userId = await reserveNextNumericId(client, "User");
        const accountIdForUser = toNullableInteger(account?.id);
        user = (await client.query('INSERT INTO "User" (id, name, email, "passwordHash", role, status, "accountId", "userGlobalId", "createdAt", "updatedAt", "activatedAt") VALUES ($1, $2, $3, $4, $5, \'ACTIVE\', $6, $7, NOW(), NOW(), NOW()) RETURNING id, name, email, "passwordHash" AS password_hash, role, status, "accountId" AS account_id, "userGlobalId" AS user_global_id, "createdAt" AS created_at', [userId, userName, email, passwordHash, role, accountIdForUser, userGlobalId])).rows[0] || null;
      } else {
        const accountIdForUser = toNullableInteger(account?.id);
        const nextRole = isMasterAdminEmail(email) ? "SUPER_ADMIN" : user.role;
        user = (await client.query('UPDATE "User" SET "userGlobalId" = $2, "accountId" = $3, role = $4, status = \'ACTIVE\', "activatedAt" = COALESCE("activatedAt", NOW()), "activationTokenHash" = NULL, "activationExpiresAt" = NULL, "activationSentAt" = NULL, "updatedAt" = NOW() WHERE id = $1 RETURNING id, name, email, "passwordHash" AS password_hash, role, status, "accountId" AS account_id, "userGlobalId" AS user_global_id, "createdAt" AS created_at', [user.id, userGlobalId, accountIdForUser, nextRole])).rows[0] || user;
      }
      await client.query("COMMIT");
      return user ? { id: Number(user.id), name: user.name || null, email: user.email, passwordHash: user.password_hash || null, role: user.role, status: user.status, accountId: user.account_id == null ? null : Number(user.account_id), userGlobalId: user.user_global_id || userGlobalId, createdAt: user.created_at || null } : null;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    }
  });
}

function setSessionCookie(res, sid) {
  const isProd = process.env.NODE_ENV === "production";
  res.clearCookie("sid", { path: "/shopee" });
  res.cookie("sid", sid, {
    httpOnly: true,
    secure: isProd,
    sameSite: "lax",
    path: "/",
  });
}

function clearSessionCookie(res) {
  res.clearCookie("sid", { path: "/" });
  res.clearCookie("sid", { path: "/shopee" });
}

function createActivationToken() {
  return crypto.randomBytes(32).toString("hex");
}

function createResetToken() {
  return crypto.randomBytes(32).toString("hex");
}

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token || "")).digest("hex");
}

function expiryDate(hours, fallback) {
  const n = Number(hours || fallback);
  const safeHours = Number.isFinite(n) && n > 0 ? n : fallback;
  return new Date(Date.now() + safeHours * 60 * 60 * 1000);
}

function activationExpiryDate() {
  return expiryDate(process.env.SHOPEE_ACTIVATION_HOURS, 48);
}

function resetExpiryDate() {
  return expiryDate(process.env.SHOPEE_RESET_HOURS, 1);
}

function resolvePublicBaseUrl() {
  const candidates = [
    process.env.SHOPEE_PUBLIC_BASE_URL,
    process.env.PUBLIC_BASE_URL,
    process.env.FRONTEND_URL,
    process.env.WEB_BASE_URL,
    process.env.API_BASE_URL,
  ];

  for (const value of candidates) {
    const normalized = String(value || "").trim().replace(/\/$/, "");
    if (!normalized) continue;

    // Evita enviar convite para dominio legado do onrender em producao.
    if (/onrender\.com/i.test(normalized)) {
      return "https://www.davanttisuite.com.br";
    }

    return normalized;
  }

  return "";
}

function buildPublicLink(pathname, token) {
  const base = resolvePublicBaseUrl();
  const safePath = String(pathname || "").startsWith("/")
    ? String(pathname || "")
    : `/${String(pathname || "")}`;
  const encodedToken = encodeURIComponent(token);

  if (!base) {
    return `/shopee${safePath}?token=${encodedToken}`;
  }

  const normalizedBase = /\/shopee$/i.test(base) ? base : `${base}/shopee`;
  return `${normalizedBase}${safePath}?token=${encodedToken}`;
}

function buildActivationLink(token) {
  return buildPublicLink("/activate", token);
}

function buildResetLink(token) {
  return buildPublicLink("/reset-password", token);
}

function createTemporaryPassword() {
  return crypto.randomBytes(24).toString("base64url");
}

function isExpired(dateValue) {
  const d = dateValue ? new Date(dateValue) : null;
  return !d || Number.isNaN(d.getTime()) || d < new Date();
}

function serializeShopForResponse(shop) {
  return {
    id: shop.id,
    shopId: shop.shopId == null ? null : String(shop.shopId),
    region: shop.region || null,
    status: shop.status || null,
  };
}

async function audit(req, payload) {
  await cleanupAuthAudit().catch(() => {});
  await recordAuthEvent({
    ...payload,
    ip: getRequestIp(req),
    userAgent: getRequestUserAgent(req),
  }).catch(() => {});
}

async function findActivationUserByToken(token) {
  return findUserByActivationTokenHash(hashToken(token));
}

async function findResetUserByToken(token) {
  return findUserByResetTokenHash(hashToken(token));
}

async function sendResetEmailSafe({ email, name, resetLink, expiresAt }) {
  try {
    return await sendPasswordResetEmail({
      toEmail: email,
      toName: name,
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

router.post("/login", async (req, res, next) => {
  try {
    const email = String(req.body?.email || "")
      .trim()
      .toLowerCase();
    const password = String(req.body?.password || "");

    if (!email || !password) {
      return res
        .status(400)
        .json({ error: "bad_request", message: "Informe e-mail e senha." });
    }

    let user = await findUserByEmail(email);
    let hubLogin = null;
    if (!user) {
      hubLogin = await verifyHubGlobalLogin({ email, password, module: "shopee" });
      if (hubLogin.allow) {
        user = await provisionShopeeUserFromHubLogin({ email, hubLogin });
      }
    }

    if (!user) {
      await audit(req, {
        email,
        event: "login_failed",
        status: "error",
        metadata: { reason: hubLogin?.reason || "user_not_found" },
      });
      return res.status(401).json({
        error: "invalid_credentials",
        message: "Credenciais invalidas.",
      });
    }

    if (String(user.status || "ACTIVE").toUpperCase() === "PENDING_ACTIVATION") {
      await audit(req, {
        userId: user.id,
        email,
        event: "login_blocked",
        status: "warn",
        metadata: { reason: "pending_activation" },
      });
      return res.status(403).json({
        error: "pending_activation",
        message:
          "Sua conta ainda nao foi ativada. Use o link de convite enviado para definir sua senha.",
      });
    }

    if (String(user.status || "ACTIVE").toUpperCase() === "INACTIVE") {
      await audit(req, {
        userId: user.id,
        email,
        event: "login_blocked",
        status: "warn",
        metadata: { reason: "inactive" },
      });
      return res.status(403).json({
        error: "inactive_account",
        message: "Sua conta esta inativa. Fale com o administrador da conta.",
      });
    }

    let ok = Boolean(hubLogin?.allow) || await bcrypt.compare(password, user.passwordHash);
    if (!ok) {
      hubLogin = await verifyHubGlobalLogin({ email, password, module: "shopee" });
      ok = Boolean(hubLogin.allow);
    }
    if (!ok) {
      await audit(req, {
        userId: user.id,
        email,
        event: "login_failed",
        status: "error",
        metadata: { reason: hubLogin?.reason || "bad_password" },
      });
      return res.status(401).json({
        error: "invalid_credentials",
        message: "Credenciais invalidas.",
      });
    }

    if (isMasterAdminEmail(email) && String(user.role || "").toUpperCase() !== "SUPER_ADMIN") {
      const promotedUser = await updateUserRole(user.id, "SUPER_ADMIN").catch(() => null);
      if (promotedUser) {
        user = { ...user, role: promotedUser.role };
      }
    }

    const account = user.accountId ? await findAccountById(user.accountId) : null;
    const hubAccess = await evaluateHubLoginAccess({
      user,
      account,
      isSuperAdmin: getEffectiveShopeeRole(user) === "SUPER_ADMIN",
    });

    if (!hubAccess.allow) {
      await audit(req, {
        userId: user.id,
        email,
        event: "login_blocked",
        status: "warn",
        metadata: {
          reason: "hub_denied",
          hub_reason: hubAccess.reason || null,
          hub_status: hubAccess.status || null,
          hub_tenant_status: hubAccess.tenant_status || null,
        },
      });
      return res.status(403).json({
        error: "hub_access_denied",
        reason: hubAccess.reason || "hub_denied",
        message:
          hubAccess.message ||
          "Acesso bloqueado pela politica de assinatura da sua conta.",
      });
    }

    const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 7);
    const session = await createSessionForUser(user.id, expiresAt);

    setSessionCookie(res, session.id);
    await audit(req, {
      userId: user.id,
      email,
      event: "login_success",
      status: "success",
    });
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

router.post("/auth/forgot-password", async (req, res, next) => {
  try {
    const email = String(req.body?.email || "")
      .trim()
      .toLowerCase();

    if (!email) {
      return res.status(400).json({
        error: "bad_request",
        message: "Informe o email para recuperar a senha.",
      });
    }

    const user = await findUserByEmail(email);

    await audit(req, {
      userId: user?.id || null,
      email,
      event: "password_reset_requested",
      status: "info",
    });

    if (user && String(user.status || "ACTIVE").toUpperCase() === "ACTIVE") {
      const resetToken = createResetToken();
      const resetExpiresAt = resetExpiryDate();
      const resetLink = buildResetLink(resetToken);

      await updatePasswordResetRequest(
        user.id,
        hashToken(resetToken),
        resetExpiresAt,
      );

      const emailDelivery = await sendResetEmailSafe({
        email: user.email,
        name: user.name,
        resetLink,
        expiresAt: resetExpiresAt.toISOString(),
      });

      await audit(req, {
        userId: user.id,
        email,
        event: "password_reset_email",
        status: emailDelivery.sent ? "success" : "warn",
        metadata: emailDelivery,
      });
    } else {
      await audit(req, {
        email,
        event: "password_reset_email",
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
    return next(err);
  }
});

router.get("/auth/reset-info", async (req, res, next) => {
  try {
    const token = String(req.query?.token || "").trim();
    if (!token) {
      return res
        .status(400)
        .json({ error: "bad_request", message: "Token ausente." });
    }

    const user = await findResetUserByToken(token);
    if (!user) {
      return res
        .status(404)
        .json({ error: "not_found", message: "Link invalido." });
    }

    if (String(user.status || "ACTIVE").toUpperCase() !== "ACTIVE") {
      return res.status(403).json({
        error: "forbidden",
        message: "A conta nao esta ativa para redefinicao.",
      });
    }

    if (isExpired(user.resetExpiresAt)) {
      return res
        .status(410)
        .json({ error: "invite_expired", message: "Link expirado." });
    }

    return res.json({
      ok: true,
      reset: {
        name: user.name,
        email: user.email,
        expiresAt: new Date(user.resetExpiresAt).toISOString(),
      },
    });
  } catch (err) {
    return next(err);
  }
});

router.post("/auth/reset-password", async (req, res, next) => {
  try {
    const token = String(req.body?.token || "").trim();
    const password = String(req.body?.password || "");

    if (!token || !password) {
      return res.status(400).json({
        error: "bad_request",
        message: "Informe token e nova senha.",
      });
    }

    if (password.length < 6) {
      return res.status(400).json({
        error: "bad_request",
        message: "Senha deve ter pelo menos 6 caracteres.",
      });
    }

    const user = await findResetUserByToken(token);
    if (!user) {
      await audit(req, {
        event: "password_reset_completed",
        status: "error",
        metadata: { reason: "token_not_found" },
      });
      return res
        .status(404)
        .json({ error: "not_found", message: "Link invalido." });
    }

    if (String(user.status || "ACTIVE").toUpperCase() !== "ACTIVE") {
      await audit(req, {
        userId: user.id,
        email: user.email,
        event: "password_reset_completed",
        status: "warn",
        metadata: { reason: "user_not_active" },
      });
      return res.status(403).json({
        error: "forbidden",
        message: "A conta nao esta ativa para redefinicao.",
      });
    }

    if (isExpired(user.resetExpiresAt)) {
      await audit(req, {
        userId: user.id,
        email: user.email,
        event: "password_reset_completed",
        status: "warn",
        metadata: { reason: "token_expired" },
      });
      return res
        .status(410)
        .json({ error: "invite_expired", message: "Link expirado." });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    await resetUserPassword(user.id, passwordHash);

    await audit(req, {
      userId: user.id,
      email: user.email,
      event: "password_reset_completed",
      status: "success",
    });

    return res.json({
      ok: true,
      message: "Senha redefinida com sucesso.",
      redirect: "/shopee/login",
    });
  } catch (err) {
    return next(err);
  }
});

router.get("/auth/activation-info", async (req, res, next) => {
  try {
    const token = String(req.query?.token || "").trim();
    if (!token) {
      return res
        .status(400)
        .json({ error: "bad_request", message: "Token ausente." });
    }

    const user = await findActivationUserByToken(token);
    if (!user) {
      return res
        .status(404)
        .json({ error: "not_found", message: "Convite invalido." });
    }

    if (String(user.status || "").toUpperCase() !== "PENDING_ACTIVATION") {
      return res.status(409).json({
        error: "invite_used",
        message: "Este convite ja foi utilizado ou a conta ja esta ativa.",
      });
    }

    if (isExpired(user.activationExpiresAt)) {
      return res
        .status(410)
        .json({ error: "invite_expired", message: "Convite expirado." });
    }

    return res.json({
      ok: true,
      invite: {
        name: user.name,
        email: user.email,
        expiresAt: new Date(user.activationExpiresAt).toISOString(),
      },
    });
  } catch (err) {
    return next(err);
  }
});

router.post("/auth/activate", async (req, res, next) => {
  try {
    const token = String(req.body?.token || "").trim();
    const password = String(req.body?.password || "");

    if (!token || !password) {
      return res.status(400).json({
        error: "bad_request",
        message: "Informe token e nova senha.",
      });
    }

    if (password.length < 6) {
      return res.status(400).json({
        error: "bad_request",
        message: "Senha deve ter pelo menos 6 caracteres.",
      });
    }

    const user = await findActivationUserByToken(token);
    if (!user) {
      return res
        .status(404)
        .json({ error: "not_found", message: "Convite invalido." });
    }

    if (String(user.status || "").toUpperCase() !== "PENDING_ACTIVATION") {
      return res.status(409).json({
        error: "invite_used",
        message: "Este convite ja foi utilizado ou a conta ja esta ativa.",
      });
    }

    if (isExpired(user.activationExpiresAt)) {
      return res
        .status(410)
        .json({ error: "invite_expired", message: "Convite expirado." });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const activatedUser = await activateUserAccount(user.id, passwordHash);

    const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 7);
    const session = await createSessionForUser(activatedUser.id, expiresAt);

    setSessionCookie(res, session.id);
    await audit(req, {
      userId: activatedUser.id,
      email: activatedUser.email,
      event: "invite_activated",
      status: "success",
    });
    const shopsCount = await countShopsByAccountId(activatedUser.accountId);

    return res.json({
      ok: true,
      redirect:
        shopsCount > 0 ? "/shopee/" : "/shopee/?tab=auth&startOauth=1",
    });
  } catch (err) {
    return next(err);
  }
});

router.post("/auth/logout", sessionAuth, async (req, res, next) => {
  try {
    const sid = req.cookies?.sid;
    if (sid) {
      await deleteSessionById(sid).catch(() => {});
    }
    clearSessionCookie(res);
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

router.get("/me", sessionAuth, async (req, res, next) => {
  try {
    if (!req.auth) {
      return res.status(401).json({ error: "unauthorized" });
    }

    const shops = await listShopsByAccountId(req.auth.accountId, 2);

    return res.json({
      user: {
        id: req.auth.userId,
        email: req.auth.email,
        role: req.auth.role,
      },
      account: {
        id: req.auth.accountId,
        name: req.auth.accountName,
      },
      shops: shops.map(serializeShopForResponse),
      activeShopId: req.auth.activeShopId,
    });
  } catch (err) {
    return next(err);
  }
});

router.post(
  "/auth/select-shop",
  sessionAuth,
  requireAuth,
  async (req, res, next) => {
    try {
      const shopId = Number(req.body?.shopId);
      if (!Number.isInteger(shopId)) {
        return res
          .status(400)
          .json({ error: "bad_request", message: "shopId invalido." });
      }

      const shop = await findShopForAccountById(shopId, req.auth.accountId);

      if (!shop) {
        return res.status(404).json({
          error: "not_found",
          message: "Loja nao encontrada para esta conta.",
        });
      }

      await updateSessionActiveShopId(req.auth.sid, shop.id);

      return res.json({ ok: true, activeShopId: shop.id });
    } catch (err) {
      return next(err);
    }
  },
);

router.post("/auth/register", async (_req, res) => {
  return res.status(403).json({
    error: "invite_only",
    message: "Cadastro publico desativado. O acesso e liberado somente por convite.",
  });
});

module.exports = router;
module.exports.createActivationToken = createActivationToken;
module.exports.hashToken = hashToken;
module.exports.activationExpiryDate = activationExpiryDate;
module.exports.buildActivationLink = buildActivationLink;
module.exports.createTemporaryPassword = createTemporaryPassword;
