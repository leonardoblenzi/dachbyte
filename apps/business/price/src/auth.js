"use strict";

const bcrypt = require("bcryptjs");
const { config, publicPath } = require("./config");
const { query, withClient } = require("./db");
const { sha256, randomToken, encrypt } = require("./crypto");
const { audit } = require("./audit");
const { resolveLoginScope, assertPasswordChangeComplete } = require("./auth-policy");

const loginAttempts = new Map();

function normalizeEmail(value) { return String(value || "").trim().toLowerCase(); }

function validateEmail(value) {
  const email = normalizeEmail(value);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw Object.assign(new Error("Email invalido."), { statusCode: 400, code: "invalid_email" });
  }
  return email;
}

function validatePassword(value) {
  const password = String(value || "");
  if (password.length < 12) {
    throw Object.assign(new Error("A senha deve ter pelo menos 12 caracteres."), { statusCode: 400, code: "weak_password" });
  }
  return password;
}

function validatePasswordForChange(value, { isProduction = config.isProduction } = {}) {
  const password = validatePassword(value);
  if (isProduction && password.length < 16) {
    throw Object.assign(new Error("A senha deve ter pelo menos 16 caracteres em producao."), { statusCode: 400, code: "weak_password" });
  }
  return password;
}
function cookiePath(req) {
  const originalUrl = String(req?.originalUrl || "");
  return originalUrl === "/volt-price" || originalUrl.startsWith("/volt-price/")
    ? "/volt-price"
    : publicPath();
}
function cookieOptions(req) {
  return { httpOnly: true, secure: config.isProduction, sameSite: "lax", path: cookiePath(req), maxAge: config.sessionTtlHours * 3600 * 1000 };
}

function loginAttemptKey(req) {
  return String(req.ip || req.socket?.remoteAddress || "unknown");
}

function recentLoginFailures(req, now = Date.now()) {
  const key = loginAttemptKey(req);
  const recent = (loginAttempts.get(key) || []).filter((time) => now - time < 15 * 60_000);
  if (recent.length) loginAttempts.set(key, recent);
  else loginAttempts.delete(key);
  return recent;
}

function assertLoginAllowed(req) {
  const recent = recentLoginFailures(req);
  if (recent.length >= 10) {
    const error = new Error("Muitas tentativas de login. Tente novamente mais tarde.");
    error.statusCode = 429; error.code = "login_rate_limited"; throw error;
  }
}

function recordLoginFailure(req) {
  const key = loginAttemptKey(req);
  const recent = recentLoginFailures(req);
  recent.push(Date.now());
  loginAttempts.set(key, recent);
}

function clearLoginFailures(req) {
  loginAttempts.delete(loginAttemptKey(req));
}

async function createSession(client, { userId, tenantId = null, ip, userAgent, supportReason = null }) {
  const token = randomToken(40);
  const csrf = randomToken(24);
  const expiresAt = new Date(Date.now() + config.sessionTtlHours * 3600_000);
  const row = (await client.query(
    `INSERT INTO volt_price.sessions (user_id, tenant_id, token_hash, csrf_hash, expires_at, ip, user_agent, support_reason)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [userId, tenantId, sha256(token), sha256(csrf), expiresAt, ip || null, userAgent || null, supportReason],
  )).rows[0];
  return { token, csrf, expiresAt, sessionId: row.id };
}

async function authenticateSession(req, _res, next, { allowPasswordChange = false } = {}) {
  try {
    const token = req.cookies?.[config.sessionCookie];
    if (!token) return next(Object.assign(new Error("Sessao ausente."), { statusCode: 401, code: "unauthenticated" }));
    const result = await query(
      `SELECT s.id AS session_id, s.tenant_id, s.user_id, s.csrf_hash, s.support_reason,
              u.email, u.full_name, u.status AS user_status, u.must_change_password,
              pa.platform_role,
              m.role AS tenant_role, m.status AS membership_status,
              t.name AS tenant_name, t.slug AS tenant_slug, t.status AS tenant_status
       FROM volt_price.sessions s
       JOIN volt_price.users u ON u.id=s.user_id
       LEFT JOIN volt_price.platform_admins pa ON pa.user_id=u.id AND pa.status='active'
       LEFT JOIN volt_price.memberships m ON m.user_id=u.id AND m.tenant_id=s.tenant_id
       LEFT JOIN volt_price.tenants t ON t.id=s.tenant_id
       WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>now() LIMIT 1`,
      [sha256(token)],
    );
    const row = result.rows[0];
    if (!row || row.user_status !== "active") return next(Object.assign(new Error("Sessao invalida."), { statusCode: 401, code: "invalid_session" }));
    const isPlatformAdmin = Boolean(row.platform_role);
    const memberships = isPlatformAdmin ? [] : (await query(
      `SELECT m.tenant_id,m.role,t.name,t.slug,t.status FROM volt_price.memberships m JOIN volt_price.tenants t ON t.id=m.tenant_id
       WHERE m.user_id=$1 AND m.status='active' AND t.status='active' ORDER BY m.created_at ASC`,
      [row.user_id],
    )).rows;
    const scope = resolveLoginScope({ platformRole: row.platform_role, memberships });
    if (!isPlatformAdmin && (!row.tenant_id || row.membership_status !== "active" || row.tenant_status !== "active")) {
      return next(Object.assign(new Error("Acesso ao tenant indisponivel."), { statusCode: 403, code: "tenant_unavailable" }));
    }
    if (!isPlatformAdmin && scope.tenantId !== row.tenant_id) {
      return next(Object.assign(new Error("Acesso ao tenant indisponivel."), { statusCode: 403, code: "tenant_unavailable" }));
    }
    req.vpAuth = {
      sessionId: row.session_id, userId: row.user_id, tenantId: row.tenant_id, email: row.email,
      fullName: row.full_name, role: isPlatformAdmin ? row.platform_role : row.tenant_role,
      isPlatformAdmin, tenantName: row.tenant_name, tenantSlug: row.tenant_slug, csrfHash: row.csrf_hash,
      supportReason: row.support_reason, passwordChangeRequired: Boolean(row.must_change_password),
    };
    if (!allowPasswordChange) assertPasswordChangeComplete({ mustChangePassword: row.must_change_password });
    next();
  } catch (error) { next(error); }
}

async function authenticate(req, res, next) {
  return authenticateSession(req, res, next);
}

async function authenticateForPasswordChange(req, res, next) {
  return authenticateSession(req, res, next, { allowPasswordChange: true });
}

function requirePasswordChangeComplete(req, _res, next) {
  try {
    assertPasswordChangeComplete({ mustChangePassword: req.vpAuth?.passwordChangeRequired });
    next();
  } catch (error) { next(error); }
}

function requireCsrf(req, _res, next) {
  if (["GET","HEAD","OPTIONS"].includes(req.method)) return next();
  const provided = String(req.headers["x-csrf-token"] || "");
  if (!provided || !req.vpAuth?.csrfHash || sha256(provided) !== req.vpAuth.csrfHash) {
    return next(Object.assign(new Error("CSRF token invalido."), { statusCode: 403, code: "csrf_invalid" }));
  }
  next();
}

async function login(req, res) {
  assertLoginAllowed(req);
  const email = normalizeEmail(req.body?.email);
  const password = String(req.body?.password || "");
  if (!email || !password) throw Object.assign(new Error("Email e senha sao obrigatorios."), { statusCode: 400, code: "validation" });
  const userResult = await query(
    `SELECT u.id,u.email,u.full_name,u.password_hash,u.status,u.must_change_password,pa.platform_role
     FROM volt_price.users u LEFT JOIN volt_price.platform_admins pa ON pa.user_id=u.id AND pa.status='active'
     WHERE u.email=$1 LIMIT 1`, [email]);
  const user = userResult.rows[0];
  const ok = user && user.status === "active" && await bcrypt.compare(password, user.password_hash);
  if (!ok) {
    recordLoginFailure(req);
    throw Object.assign(new Error("Email ou senha invalidos."), { statusCode: 401, code: "invalid_credentials" });
  }

  clearLoginFailures(req);

  let memberships = [];
  if (!user.platform_role) {
    memberships = (await query(
      `SELECT m.tenant_id,m.role,t.name,t.slug,t.status FROM volt_price.memberships m JOIN volt_price.tenants t ON t.id=m.tenant_id
      WHERE m.user_id=$1 AND m.status='active' AND t.status='active' ORDER BY m.created_at ASC`, [user.id])).rows;
  }
  const scope = resolveLoginScope({ platformRole: user.platform_role, memberships });
  const { tenantId, tenant, role } = scope;

  const session = await withClient(async (client) => {
    await client.query("BEGIN");
    try {
      const created = await createSession(client, { userId:user.id, tenantId, ip:req.ip, userAgent:req.get("user-agent") });
      await client.query("UPDATE volt_price.users SET last_login_at=now(), updated_at=now() WHERE id=$1", [user.id]);
      await audit(client, { tenantId, actorUserId:user.id, actorType:scope.isPlatformAdmin?"platform_admin":"user", action:"auth.login", resourceType:"session", resourceId:created.sessionId, ip:req.ip, userAgent:req.get("user-agent") });
      await client.query("COMMIT"); return created;
    } catch (e) { await client.query("ROLLBACK"); throw e; }
  });
  res.cookie(config.sessionCookie, session.token, cookieOptions(req));
  return res.json({ success:true, csrfToken:session.csrf, user:{ id:user.id,email:user.email,fullName:user.full_name,role,isPlatformAdmin:scope.isPlatformAdmin,passwordChangeRequired:Boolean(user.must_change_password),tenant:tenant?{id:tenant.tenant_id,name:tenant.name,slug:tenant.slug}:null } });
}

async function logout(req, res) {
  const token = req.cookies?.[config.sessionCookie];
  if (token) await query("UPDATE volt_price.sessions SET revoked_at=now() WHERE token_hash=$1 AND revoked_at IS NULL", [sha256(token)]).catch(()=>{});
  res.clearCookie(config.sessionCookie, { path: cookiePath(req) });
  if (cookiePath(req) !== publicPath()) res.clearCookie(config.sessionCookie, { path: publicPath() });
  if (cookiePath(req) !== "/volt-price") res.clearCookie(config.sessionCookie, { path: "/volt-price" });
  res.status(204).end();
}

function authUser(vpAuth) {
  const isPlatformAdmin = Boolean(vpAuth.isPlatformAdmin);
  return {
    id: vpAuth.userId,
    email: vpAuth.email,
    fullName: vpAuth.fullName,
    role: vpAuth.role,
    isPlatformAdmin,
    tenantId: vpAuth.tenantId || null,
    tenantName: vpAuth.tenantName || null,
    tenantSlug: vpAuth.tenantSlug || null,
    supportReason: vpAuth.supportReason || null,
    passwordChangeRequired: Boolean(vpAuth.passwordChangeRequired),
    tenant: !vpAuth.tenantId ? null : {
      id: vpAuth.tenantId,
      name: vpAuth.tenantName,
      slug: vpAuth.tenantSlug,
    },
  };
}

async function changePassword(req, res) {
  const currentPassword = String(req.body?.currentPassword || "");
  const newPassword = validatePasswordForChange(req.body?.newPassword);
  if (!currentPassword) {
    throw Object.assign(new Error("A senha atual e obrigatoria."), { statusCode: 400, code: "validation" });
  }

  const session = await withClient(async (client) => {
    await client.query("BEGIN");
    try {
      const user = (await client.query(
        `SELECT id,email,full_name,password_hash,must_change_password
         FROM volt_price.users WHERE id=$1 FOR UPDATE`,
        [req.vpAuth.userId],
      )).rows[0];
      if (!user || !await bcrypt.compare(currentPassword, user.password_hash)) {
        throw Object.assign(new Error("Senha atual invalida."), { statusCode: 401, code: "invalid_credentials" });
      }

      const passwordHash = await bcrypt.hash(newPassword, 12);
      await client.query(
        "UPDATE volt_price.users SET password_hash=$2,must_change_password=false,updated_at=now() WHERE id=$1",
        [user.id, passwordHash],
      );
      await client.query("DELETE FROM volt_price.sessions WHERE user_id=$1", [user.id]);
      const created = await createSession(client, {
        userId: user.id,
        tenantId: req.vpAuth.isPlatformAdmin ? null : req.vpAuth.tenantId,
        ip: req.ip,
        userAgent: req.get("user-agent"),
      });
      await audit(client, {
        tenantId: req.vpAuth.isPlatformAdmin ? null : req.vpAuth.tenantId,
        actorUserId: user.id,
        actorType: req.vpAuth.isPlatformAdmin ? "platform_admin" : "user",
        action: "auth.password_change",
        resourceType: "session",
        resourceId: created.sessionId,
        ip: req.ip,
        userAgent: req.get("user-agent"),
      });
      await client.query("COMMIT");
      return { created, user };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    }
  });

  const responseAuth = req.vpAuth.isPlatformAdmin
    ? { ...req.vpAuth, tenantId: null, tenantName: null, tenantSlug: null, supportReason: null }
    : req.vpAuth;
  const user = authUser({ ...responseAuth, email: session.user.email, fullName: session.user.full_name, passwordChangeRequired: false });
  res.cookie(config.sessionCookie, session.created.token, cookieOptions(req));
  return res.json({ success: true, csrfToken: session.created.csrf, passwordChangeRequired: false, user });
}

async function ensureBootstrapMaster() {
  if (!config.bootstrapMasterEnabled || !config.bootstrapMasterEmail || !config.bootstrapMasterPassword) return null;
  if (config.isProduction && String(config.bootstrapMasterPassword).length < 16) throw new Error("VOLT_PRICE_BOOTSTRAP_MASTER_PASSWORD deve ter pelo menos 16 caracteres em producao.");
  return withClient(async (client) => {
    await client.query("BEGIN");
    try {
      const passwordHash = await bcrypt.hash(config.bootstrapMasterPassword, 12);
      const inserted = await client.query(
        `INSERT INTO volt_price.users (email,full_name,password_hash,status)
         VALUES ($1,'VoltPrice Admin Master',$2,'active')
         ON CONFLICT (email) DO NOTHING
         RETURNING id,email`,
        [config.bootstrapMasterEmail,passwordHash]);

      if (!inserted.rows[0]) {
        const existing = await client.query(
          "SELECT id,email FROM volt_price.users WHERE email=$1 LIMIT 1",
          [config.bootstrapMasterEmail],
        );
        await client.query("COMMIT");
        return existing.rows[0] ? { ...existing.rows[0], bootstrap_created: false } : null;
      }

      const user = inserted.rows[0];
      const totpCipher = config.bootstrapMasterTotpSecret ? encrypt(config.bootstrapMasterTotpSecret) : null;
      await client.query(
        `INSERT INTO volt_price.platform_admins (user_id,platform_role,status,totp_secret_cipher,mfa_confirmed)
         VALUES ($1,'platform_super_admin','active',$2,$3)
         ON CONFLICT (user_id) DO NOTHING`,
        [user.id, totpCipher, Boolean(totpCipher)],
      );
      await client.query("COMMIT");
      return { ...user, bootstrap_created: true };
    } catch (e) { await client.query("ROLLBACK"); if (e.code === "42P01") return null; throw e; }
  });
}

module.exports = { authenticate, authenticateForPasswordChange, requirePasswordChangeComplete, requireCsrf, login, logout, changePassword, authUser, createSession, cookieOptions, cookiePath, ensureBootstrapMaster, normalizeEmail, validateEmail, validatePassword, validatePasswordForChange, assertLoginAllowed, recordLoginFailure, clearLoginFailures };
