// middleware/ensurePermission.js
// ACL simples baseado em `req.user` (injetado pelo ensureAuth/authMiddleware)
//
// ✅ Objetivo:
// - Permitir usar `app.use(ensurePermission)` sem quebrar (middleware padrão)
// - Manter compat com o padrão antigo: `ensurePermission.requireAdmin()` etc.

"use strict";

function normalizeNivel(n) {
  return String(n || "").trim().toLowerCase();
}

function truthy(v) {
  return v === true || v === 1 || v === "1" || v === "true";
}

function isMaster(req) {
  const nivel = normalizeNivel(req.user?.nivel);
  const role = normalizeNivel(req.user?.role);

  return (
    nivel === "admin_master" ||
    role === "admin_master" ||
    truthy(req.user?.is_master) ||
    truthy(req.user?.isMaster) ||
    truthy(req.user?.flags?.is_master)
  );
}

function isAdmin(req) {
  const nivel = normalizeNivel(req.user?.nivel);
  const role = normalizeNivel(req.user?.role);

  return (
    nivel === "administrador" ||
    role === "administrador" ||
    truthy(req.user?.is_admin) ||
    truthy(req.user?.isAdmin) ||
    truthy(req.user?.flags?.is_admin)
  );
}

function ensurePermission(req, res, next) {
  // Middleware padrão: só injeta flags úteis pra views/headers
  const _is_master = isMaster(req);
  const _is_admin = isAdmin(req);
  const _is_admin_any = _is_master || _is_admin;

  res.locals = res.locals || {};
  res.locals.perms = {
    is_master: _is_master,
    is_admin: _is_admin,
    is_admin_any: _is_admin_any,
  };

  return next();
}

function isApi(req) {
  const p = req.path || req.originalUrl || "";
  return String(p).startsWith("/api/");
}

function wantsHtml(req) {
  if (isApi(req)) return false;
  const accept = String(req.headers?.accept || "").toLowerCase();
  // fetch() geralmente manda */* — não tratar como HTML
  if (!accept) return false;
  return accept.includes("text/html") || accept.includes("application/xhtml+xml");
}

function mountBase(req) {
  const b = String(req.baseUrl || "");
  const i = b.indexOf("/api/");
  if (i >= 0) return b.slice(0, i) || "";
  return b;
}

function withBase(req, path) {
  const base = mountBase(req);
  if (!path) return base || "/";
  if (/^https?:\/\//i.test(path)) return path;
  const p = path.startsWith("/") ? path : `/${path}`;
  if (base && (p === base || p.startsWith(base + "/"))) return p;
  return base + p;
}

function deny(req, res, status, error, redirect = "/nao-autorizado") {
  if (wantsHtml(req) && req.method === "GET") {
    return res.redirect(withBase(req, redirect));
  }
  return res.status(status).json({ ok: false, error, redirect: withBase(req, redirect) });
}

ensurePermission.requireAdmin = function requireAdmin() {
  return (req, res, next) => {
    if (isMaster(req) || isAdmin(req)) return next();
    return deny(req, res, 403, "Não autorizado (admin requerido)");
  };
};

ensurePermission.requireMaster = function requireMaster() {
  return (req, res, next) => {
    if (isMaster(req)) return next();
    return deny(req, res, 403, "Não autorizado (master requerido)");
  };
};

ensurePermission.isMaster = isMaster;
ensurePermission.isAdmin = isAdmin;
ensurePermission.normalizeNivel = normalizeNivel;

module.exports = ensurePermission;
