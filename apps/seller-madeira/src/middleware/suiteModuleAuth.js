"use strict";

const jwt = require("jsonwebtoken");

const MADEIRA_MODULE_ALIASES = new Set(["madeira", "madeiramadeira"]);

function getSuiteJwtSecret() {
  return (
    String(process.env.SUITE_JWT_SECRET || "").trim() ||
    String(process.env.ML_JWT_SECRET || "").trim() ||
    String(process.env.JWT_SECRET || "").trim()
  );
}

function readCookie(req, name) {
  if (req.cookies?.[name]) return String(req.cookies[name]);

  const cookieHeader = String(req.headers?.cookie || "");
  const prefix = `${name}=`;
  const value = cookieHeader
    .split(";")
    .map((item) => item.trim())
    .find((item) => item.startsWith(prefix));

  return value ? decodeURIComponent(value.slice(prefix.length)) : "";
}

function hasMadeiraModuleAccess(session) {
  const modules = Array.isArray(session?.allowed_modules)
    ? session.allowed_modules
    : [];

  return modules.some((moduleId) =>
    MADEIRA_MODULE_ALIASES.has(String(moduleId || "").trim().toLowerCase()),
  );
}

function wantsHtml(req) {
  const accept = String(req.headers?.accept || "").toLowerCase();
  return accept.includes("text/html") || accept.includes("application/xhtml+xml");
}

function denyRequest(req, res, { status, error, redirect }) {
  if (wantsHtml(req) && req.method === "GET") {
    return res.redirect(redirect);
  }

  return res.status(status).json({
    ok: false,
    error,
    redirect,
  });
}

function createSuiteModuleAuthMiddleware(options = {}) {
  const secret = String(options.secret || getSuiteJwtSecret()).trim();

  return function requireSuiteMadeiraAccess(req, res, next) {
    if (!secret) {
      return denyRequest(req, res, {
        status: 503,
        error: "Autenticacao central da Suite nao configurada.",
        redirect: "/login",
      });
    }

    const token = readCookie(req, "suite_auth_token");
    if (!token) {
      return denyRequest(req, res, {
        status: 401,
        error: "Sessao da Suite ausente ou invalida.",
        redirect: "/login",
      });
    }

    try {
      const session = jwt.verify(token, secret);
      if (!hasMadeiraModuleAccess(session)) {
        return denyRequest(req, res, {
          status: 403,
          error: "Sua conta nao possui acesso ao modulo MadeiraMadeira.",
          redirect: "/selecao-plataforma?module=denied",
        });
      }

      req.suiteSession = session;
      return next();
    } catch (_error) {
      return denyRequest(req, res, {
        status: 401,
        error: "Sessao da Suite ausente ou invalida.",
        redirect: "/login",
      });
    }
  };
}

module.exports = {
  createSuiteModuleAuthMiddleware,
  hasMadeiraModuleAccess,
};
