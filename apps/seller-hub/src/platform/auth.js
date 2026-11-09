// @ts-check
"use strict";

const jwt = require("jsonwebtoken");

const ADMIN_COMPANY_ROLES = new Set(["owner", "admin", "administrador"]);
/** Sessão única da suíte DACHBYTE: o mesmo login vale para o Hub e para os módulos. */
const SUITE_COOKIE = "suite_auth_token";

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
 * @typedef {{ tenantId: string, userId: string, email: string, name: string, companyRole: string | null,
 *             isAdmin: boolean, isPlatformAdmin: boolean, accountLimit?: number | null }} HubIdentity
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
 * Lê a sessão da suíte (cookie suite_auth_token), a mesma de /login e da seleção de plataforma.
 * @param {{ headers?: Record<string, any> }} req
 * @param {{ suiteJwtSecret: string, platformAdminEmails: Set<string> }} config
 */
function readSession(req, config) {
  const token = String(parseCookies(req.headers?.cookie)[SUITE_COOKIE] || "").trim();
  if (!token || !config.suiteJwtSecret) return { ok: false, status: 401, code: "unauthorized", message: "Entre no DACH Hub." };
  let payload;
  try { payload = /** @type {Record<string, any>} */ (jwt.verify(token, config.suiteJwtSecret)); }
  catch (_error) { return { ok: false, status: 401, code: "invalid_session", message: "Sessão expirada. Entre de novo." }; }
  // Token com audiência é de outro produto: não vale como sessão da suíte.
  if (payload.aud) return { ok: false, status: 401, code: "invalid_session", message: "Sessão inválida. Entre de novo." };
  const identity = identityFromPayload(payload, config);
  if (!identity.tenantId || !identity.userId || !identity.email) {
    return { ok: false, status: 401, code: "invalid_identity", message: "Sessão sem identidade DACH válida." };
  }
  return { ok: true, identity };
}

/**
 * Quem pode usar o Hub: equipe da plataforma; empresas na lista de reserva (HUB_ALLOWED_TENANTS);
 * senão, o hub de acessos decide pelo produto dach_hub (quem assinou só o Hub, só os módulos ou os dois).
 * Sem resposta do hub de acessos = não entra.
 * @param {HubIdentity} identity
 * @param {{ allowedTenants: Set<string> }} config
 * @param {{ configured: boolean, checkAccess: (identity: { tenantId: string, userId: string }) => Promise<{ allow: boolean, reason: string, accountLimit?: number | null }> } | null | undefined} accessHub
 * @returns {Promise<{ allow: boolean, reason: string, accountLimit?: number | null }>}
 */
async function decideAccess(identity, config, accessHub) {
  if (identity.isPlatformAdmin) return { allow: true, reason: "platform_admin" };
  if (config.allowedTenants.has(identity.tenantId)) return { allow: true, reason: "allowlist" };
  if (!accessHub || !accessHub.configured) return { allow: false, reason: "hub_not_configured" };
  return accessHub.checkAccess(identity);
}

/** @param {{ method?: string, headers?: Record<string, any> }} req */
function wantsHtml(req) {
  const accept = String(req.headers?.accept || "").toLowerCase();
  return req.method === "GET" && accept.includes("text/html");
}

/**
 * @param {ReturnType<typeof import("./config").loadConfig>} config
 * @param {{ accessHub?: Parameters<typeof decideAccess>[2] }} [deps]
 */
function createAuthMiddleware(config, { accessHub } = {}) {
  /** @type {import("express").RequestHandler} */
  return async function hubAuth(req, res, next) {
    try {
      const session = readSession(req, config);
      if (!session.ok || !session.identity) {
        // Login único da DACHBYTE: depois de entrar, a pessoa escolhe o Hub na seleção de plataforma.
        if (wantsHtml(req)) return res.redirect(302, "/login");
        return res.status(session.status || 401).json({ ok: false, error: session.code, message: session.message });
      }
      const decision = await decideAccess(session.identity, config, accessHub);
      if (!decision.allow) {
        // Não contratou (ou não foi liberado): a seleção de plataforma mostra o Hub como disponível para contratar.
        if (wantsHtml(req)) return res.redirect(302, "/selecao-plataforma?module=dach_hub_unavailable");
        return res.status(403).json({ ok: false, error: "hub_not_enabled", reason: decision.reason, message: "O DACH Hub não está liberado para esta empresa ou usuário." });
      }
      // Limite de contas do plano (null = não informado): vale para conectar contas e gerar links.
      /** @type {any} */ (req).hubIdentity = { ...session.identity, accountLimit: decision.accountLimit ?? null };
      return next();
    } catch (error) { return next(error); }
  };
}

/** @param {any} req @param {any} res @param {() => void} next */
function requireAdmin(req, res, next) {
  const identity = /** @type {any} */ (req).hubIdentity;
  if (identity && identity.isAdmin) return next();
  return res.status(403).json({ ok: false, error: "admin_required", message: "Somente o administrador da empresa pode fazer isso." });
}

module.exports = {
  createAuthMiddleware, requireAdmin, readSession, decideAccess, identityFromPayload, parseCookies,
  SUITE_COOKIE, _test: { parseCookies, identityFromPayload },
};
