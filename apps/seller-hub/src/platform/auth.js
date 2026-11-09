// @ts-check
"use strict";

const jwt = require("jsonwebtoken");

const ADMIN_COMPANY_ROLES = new Set(["owner", "admin", "administrador"]);
/** Sessão própria do DACH Hub (página /hub/login). */
const HUB_COOKIE = "dach_hub_session";
/** Marca "saiu do Hub": a sessão da suíte deixa de entrar sozinha até o próximo login. */
const SIGNED_OUT_COOKIE = "dach_hub_signed_out";
const SESSION_AUDIENCE = "dach-hub";
const SESSION_TTL_SECONDS = 12 * 60 * 60;

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
 * @typedef {{ tenantId: string, userId: string, email: string, name: string, companyRole: string | null, companyName: string | null,
 *             isAdmin: boolean, isPlatformAdmin: boolean, source: "hub" | "suite" }} HubIdentity
 */

/** @param {Record<string, any>} payload @param {{ platformAdminEmails: Set<string> }} config @param {"hub" | "suite"} [source] @returns {HubIdentity} */
function identityFromPayload(payload, config, source = "suite") {
  const email = String(payload.email || "").trim().toLowerCase();
  const companyRole = String(payload.company_role || "").trim().toLowerCase() || null;
  const isPlatformAdmin = config.platformAdminEmails.has(email);
  return {
    tenantId: String(payload.tenant_id || "").trim(),
    userId: String(payload.user_id || "").trim(),
    email,
    name: String(payload.name || payload.nome || email || "Usuário").trim(),
    companyRole,
    companyName: String(payload.company_name || "").trim() || null,
    isPlatformAdmin,
    isAdmin: isPlatformAdmin || (companyRole != null && ADMIN_COMPANY_ROLES.has(companyRole)),
    source,
  };
}

/** Assina a sessão própria do Hub. @param {HubIdentity} identity @param {string} secret */
function signHubSession(identity, secret) {
  return jwt.sign({
    tenant_id: identity.tenantId, user_id: identity.userId, email: identity.email, name: identity.name,
    company_role: identity.companyRole, company_name: identity.companyName,
  }, secret, { audience: SESSION_AUDIENCE, expiresIn: SESSION_TTL_SECONDS });
}

/**
 * Lê a sessão: primeiro a do Hub; sem ela, a da suíte (atalho para quem já entrou na suíte),
 * a menos que a pessoa tenha saído do Hub.
 * @param {{ headers?: Record<string, any> }} req
 * @param {{ suiteJwtSecret: string, sessionSecret: string, platformAdminEmails: Set<string> }} config
 */
function readSession(req, config) {
  const cookies = parseCookies(req.headers?.cookie);
  const hubToken = String(cookies[HUB_COOKIE] || "").trim();
  if (hubToken && config.sessionSecret) {
    try {
      const payload = /** @type {Record<string, any>} */ (jwt.verify(hubToken, config.sessionSecret, { audience: SESSION_AUDIENCE }));
      const identity = identityFromPayload(payload, config, "hub");
      if (identity.tenantId && identity.userId && identity.email) return { ok: true, identity };
    } catch (_error) { /* sessão vencida ou adulterada: tenta a da suíte */ }
  }
  if (cookies[SIGNED_OUT_COOKIE] === "1") return { ok: false, status: 401, code: "unauthorized", message: "Entre no DACH Hub." };
  return readSuiteSession(cookies, config);
}

/**
 * Sessão da suíte DACH (cookie suite_auth_token).
 * @param {Record<string, string>} cookies @param {{ suiteJwtSecret: string, platformAdminEmails: Set<string> }} config
 */
function readSuiteSession(cookies, config) {
  const token = String(cookies.suite_auth_token || "").trim();
  if (!token) return { ok: false, status: 401, code: "unauthorized", message: "Entre no DACH Hub." };
  if (!config.suiteJwtSecret) return { ok: false, status: 401, code: "unauthorized", message: "Entre no DACH Hub." };
  let payload;
  try { payload = /** @type {Record<string, any>} */ (jwt.verify(token, config.suiteJwtSecret)); }
  catch (_error) { return { ok: false, status: 401, code: "invalid_session", message: "Sessão expirada. Entre de novo." }; }
  // Token com audiência é de outro produto (ex.: a própria sessão do Hub): não vale como sessão da suíte.
  if (payload.aud) return { ok: false, status: 401, code: "invalid_session", message: "Sessão inválida. Entre de novo." };
  const identity = identityFromPayload(payload, config, "suite");
  if (!identity.tenantId || !identity.userId || !identity.email) {
    return { ok: false, status: 401, code: "invalid_identity", message: "Sessão sem identidade DACH válida." };
  }
  return { ok: true, identity };
}

/**
 * Quem pode usar o Hub: equipe da plataforma; empresas na lista de reserva (HUB_ALLOWED_TENANTS);
 * senão, o hub de acessos decide (módulo dach_hub). Sem resposta do hub de acessos = não entra.
 * @param {HubIdentity} identity
 * @param {{ allowedTenants: Set<string> }} config
 * @param {{ configured: boolean, checkAccess: (identity: { tenantId: string, userId: string }) => Promise<{ allow: boolean, reason: string }> } | null | undefined} accessHub
 * @returns {Promise<{ allow: boolean, reason: string }>}
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

/** Caminho de volta depois do login: só dentro do /hub. @param {unknown} value */
function safeReturnPath(value) {
  const path = String(value || "");
  if (!/^\/hub(\/|$|\?)/.test(path) || path.startsWith("//") || /[\\\r\n]/.test(path)) return "/hub/";
  return path;
}

/** @param {boolean} secure */
function cookieOptions(secure) {
  return { httpOnly: true, sameSite: /** @type {const} */ ("lax"), secure, path: "/hub" };
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
        if (wantsHtml(req)) return res.redirect(302, `/hub/login?volta=${encodeURIComponent(safeReturnPath(`/hub${req.url}`))}`);
        return res.status(session.status || 401).json({ ok: false, error: session.code, message: session.message });
      }
      const decision = await decideAccess(session.identity, config, accessHub);
      if (!decision.allow) {
        if (session.identity.source === "hub") res.clearCookie(HUB_COOKIE, cookieOptions(config.secureCookies));
        if (wantsHtml(req)) return res.redirect(302, `/hub/login?erro=${decision.reason === "hub_unavailable" || decision.reason === "hub_unreachable" ? "indisponivel" : "sem_acesso"}`);
        return res.status(403).json({ ok: false, error: "hub_not_enabled", reason: decision.reason, message: "O DACH Hub não está liberado para esta empresa ou usuário." });
      }
      /** @type {any} */ (req).hubIdentity = session.identity;
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
  createAuthMiddleware, requireAdmin, readSession, readSuiteSession, decideAccess, signHubSession, identityFromPayload,
  safeReturnPath, cookieOptions, parseCookies, HUB_COOKIE, SIGNED_OUT_COOKIE, SESSION_TTL_SECONDS,
  _test: { parseCookies, identityFromPayload },
};
