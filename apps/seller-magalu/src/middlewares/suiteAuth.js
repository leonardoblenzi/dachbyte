"use strict";

const jwt = require("jsonwebtoken");
const env = require("../config/env");
const { checkHubAccess } = require("../services/hubAccessService");

function parseCookies(header) {
  const output = {};
  for (const part of String(header || "").split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!key) continue;
    try { output[key] = decodeURIComponent(value); } catch (_error) { output[key] = value; }
  }
  return output;
}

function moduleSet(payload = {}) {
  const rows = [payload.allowed_modules, payload.visible_modules, payload.modules]
    .filter(Array.isArray)
    .flat();
  return new Set(rows.map((value) => String(value || "").trim().toLowerCase()).filter(Boolean));
}

function identityFromPayload(payload = {}) {
  return {
    dachTenantId: String(payload.tenant_id || "").trim(),
    dachUserId: String(payload.user_id || "").trim(),
    email: String(payload.email || "").trim().toLowerCase(),
    name: String(payload.name || payload.nome || payload.email || "Usuário").trim(),
    modules: moduleSet(payload),
    subscription: payload.subscription || null,
    authSource: payload.auth_source || null,
  };
}

function readSuiteIdentity(req) {
  if (!env.SUITE_JWT_SECRET) {
    return { ok: false, status: 503, code: "suite_auth_not_configured", message: "SUITE_JWT_SECRET não configurado no módulo Magalu.", redirect: null };
  }
  const cookies = parseCookies(req?.headers?.cookie);
  const token = String(cookies.suite_auth_token || "").trim();
  if (!token) return { ok: false, status: 401, code: "unauthorized", message: "Sessão DACH não encontrada.", redirect: "/login" };

  let payload;
  try { payload = jwt.verify(token, env.SUITE_JWT_SECRET); }
  catch (_error) { return { ok: false, status: 401, code: "invalid_session", message: "Sessão DACH inválida ou expirada.", redirect: "/login" }; }

  const identity = identityFromPayload(payload);
  if (!identity.dachTenantId || !identity.dachUserId || !identity.email) {
    return { ok: false, status: 401, code: "invalid_identity", message: "A sessão não possui identidade global DACH válida.", redirect: "/login" };
  }
  if (!identity.modules.has("magalu")) {
    return { ok: false, status: 403, code: "module_not_allowed", message: "O módulo Magalu não está liberado para esta conta.", redirect: "/selecao-plataforma?module=magalu_denied", identity, payload };
  }
  return { ok: true, identity, payload };
}

function wantsHtml(req) {
  const accept = String(req.headers?.accept || "").toLowerCase();
  return req.method === "GET" && (accept.includes("text/html") || accept.includes("application/xhtml+xml"));
}

function deny(req, res, status, code, message, redirect = null) {
  if (wantsHtml(req) && redirect) return res.redirect(302, redirect);
  return res.status(status).json({ ok: false, error: code, message });
}

async function suiteAuth(req, res, next) {
  try {
    const session = readSuiteIdentity(req);
    if (!session.ok) return deny(req, res, session.status, session.code, session.message, session.redirect);
    const hub = await checkHubAccess(session.identity, { action: "ACCESS magalu" });
    if (!hub.allow) {
      return deny(req, res, 403, "hub_access_denied", "O Hub não confirmou acesso ao módulo Magalu.", "/selecao-plataforma?module=magalu_denied");
    }
    req.magaluIdentity = session.identity;
    req.magaluHubAccess = hub.payload || null;
    res.locals.magaluIdentity = session.identity;
    return next();
  } catch (error) { return next(error); }
}

module.exports = { suiteAuth, readSuiteIdentity, _test: { parseCookies, moduleSet, identityFromPayload, wantsHtml } };
