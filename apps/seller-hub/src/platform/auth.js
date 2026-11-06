// @ts-check
"use strict";

const jwt = require("jsonwebtoken");

const ADMIN_COMPANY_ROLES = new Set(["admin", "administrador"]);

/** @param {string | undefined} header */
function parseCookies(header) {
  /** @type {Record<string, string>} */
  const output = {};
  for (const part of String(header || "").split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    try { output[key] = decodeURIComponent(value); } catch (_error) { output[key] = value; }
  }
  return output;
}

/**
 * @typedef {{ tenantId: string, userId: string, email: string, name: string, companyRole: string | null, isAdmin: boolean, isPlatformAdmin: boolean }} HubIdentity
 */

/** @param {Record<string, any>} payload @param {{ platformAdminEmails: Set<string> }} config @returns {HubIdentity} */
function identityFromPayload(payload, config) {
  const email = String(payload.email || "").trim().toLowerCase();
  const companyRole = String(payload.company_role || "").trim().toLowerCase() || null;
  const isPlatformAdmin = config.platformAdminEmails.has(email);
  return {
    tenantId: String(payload.tenant_id || "").trim(),
    userId: String(payload.user_id || "").trim(),
    email,
    name: String(payload.name || payload.nome || email || "Usuário").trim(),
    companyRole,
    isPlatformAdmin,
    isAdmin: isPlatformAdmin || (companyRole != null && ADMIN_COMPANY_ROLES.has(companyRole)),
  };
}

/**
 * Lê a sessão da suíte (cookie suite_auth_token).
 * @param {{ headers?: Record<string, any> }} req
 * @param {{ suiteJwtSecret: string, platformAdminEmails: Set<string> }} config
 */
function readSession(req, config) {
  if (!config.suiteJwtSecret) return { ok: false, status: 503, code: "suite_auth_not_configured", message: "SUITE_JWT_SECRET não configurado no DACH Hub." };
  const token = String(parseCookies(req.headers?.cookie).suite_auth_token || "").trim();
  if (!token) return { ok: false, status: 401, code: "unauthorized", message: "Sessão DACH não encontrada." };
  let payload;
  try { payload = /** @type {Record<string, any>} */ (jwt.verify(token, config.suiteJwtSecret)); }
  catch (_error) { return { ok: false, status: 401, code: "invalid_session", message: "Sessão DACH inválida ou expirada." }; }
  const identity = identityFromPayload(payload, config);
  if (!identity.tenantId || !identity.userId || !identity.email) {
    return { ok: false, status: 401, code: "invalid_identity", message: "Sessão sem identidade DACH válida." };
  }
  return { ok: true, identity };
}

/**
 * Enquanto o DACH Hub estiver oculto, só empresas liberadas entram.
 * @param {HubIdentity} identity @param {{ allowedTenants: Set<string> }} config
 */
function canEnter(identity, config) {
  return identity.isPlatformAdmin || config.allowedTenants.has(identity.tenantId);
}

/** @param {{ method?: string, headers?: Record<string, any> }} req */
function wantsHtml(req) {
  const accept = String(req.headers?.accept || "").toLowerCase();
  return req.method === "GET" && accept.includes("text/html");
}

/** @param {ReturnType<typeof import("./config").loadConfig>} config */
function createAuthMiddleware(config) {
  /** @type {import("express").RequestHandler} */
  return function hubAuth(req, res, next) {
    const session = readSession(req, config);
    if (!session.ok || !session.identity) {
      if (wantsHtml(req) && session.status === 401) return res.redirect(302, "/login");
      return res.status(session.status || 401).json({ ok: false, error: session.code, message: session.message });
    }
    if (!canEnter(session.identity, config)) {
      if (wantsHtml(req)) return res.redirect(302, "/selecao-plataforma?module=dach_hub_unavailable");
      return res.status(403).json({ ok: false, error: "hub_not_enabled", message: "O DACH Hub ainda não está liberado para esta empresa." });
    }
    /** @type {any} */ (req).hubIdentity = session.identity;
    return next();
  };
}

/** @param {any} req @param {any} res @param {() => void} next */
function requireAdmin(req, res, next) {
  const identity = /** @type {any} */ (req).hubIdentity;
  if (identity && identity.isAdmin) return next();
  return res.status(403).json({ ok: false, error: "admin_required", message: "Somente o administrador da empresa pode fazer isso." });
}

module.exports = { createAuthMiddleware, requireAdmin, readSession, canEnter, _test: { parseCookies, identityFromPayload } };
