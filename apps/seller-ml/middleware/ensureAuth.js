"use strict";

const jwt = require("jsonwebtoken");

// ✅ Aceita o padrão novo (ML_) e mantém compatibilidade com o antigo
const JWT_SECRET = process.env.ML_JWT_SECRET || (process.env.ML_JWT_SECRET || process.env.JWT_SECRET);
if (!JWT_SECRET) {
  throw new Error(
    "JWT_SECRET não definido. Configure ML_JWT_SECRET (preferido) ou JWT_SECRET no .env / Render Environment."
  );
}

/**
 * Rotas/paths que PRECISAM ser públicas, senão você não consegue:
 * - abrir login/cadastro
 * - carregar CSS/JS/IMG do login
 * - usar /api/auth pra autenticar
 *
 * ✅ IMPORTANTE (Render):
 * O Render faz healthcheck SEM cookies. Então /api/system/health PRECISA passar 200.
 * Senão o deploy fica "Waiting for internal health check..." e falha por timeout.
 */
const PUBLIC_PATHS = [
  // ✅ Render healthcheck (DEVE ser público)
  /^\/api\/system\/health(?:\/|$)/i,
  /^\/api\/system\/stats(?:\/|$)/i,
  /^\/healthz(?:\/|$)/i,

  // páginas públicas
  /^\/(?:login|cadastro|selecao-plataforma|privacidade|privacy|politica-de-privacidade)(?:\/|$)/i,

  // auth do app
  /^\/api\/auth(?:\/|$)/i,
  /^\/api\/integrations(?:\/|$)/i,

  // ✅ callback OAuth precisa ser público para o redirect do Mercado Livre
  // conseguir concluir a vinculação mesmo se o cookie auth_token não vier.
  /^\/api\/meli\/oauth\/callback(?:\/|$)/i,

  // assets estáticos (necessários pro login/cadastro)
  /^\/(?:css|js|img|fonts)(?:\/|$)/i,

  // favicon
  /^\/favicon\.ico$/i,
];

const SKIP_METHODS = new Set(["OPTIONS", "HEAD"]);

function isPublic(req) {
  if (SKIP_METHODS.has(req.method)) return true;
  const p = req.path || req.originalUrl || "";
  return PUBLIC_PATHS.some((rx) => rx.test(p));
}

function readToken(req) {
  return req.cookies?.auth_token || null;
}

function wantsHtml(req) {
  const accept = String(req.headers?.accept || "").toLowerCase();
  return accept.includes("text/html") || accept.includes("application/xhtml+xml");
}

function isApiCall(req) {
  const p = req.path || req.originalUrl || "";
  const accept = String(req.headers?.accept || "").toLowerCase();
  const xrw = String(req.headers?.["x-requested-with"] || "").toLowerCase();
  return (
    p.startsWith("/api/") ||
    accept.includes("application/json") ||
    xrw === "xmlhttprequest"
  );
}

function clearAuthCookie(res) {
  res.clearCookie("auth_token", { path: "/" });
}

// =====================
// Helpers: base path (suite /ml vs standalone /)
// =====================
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

  let p = String(path);
  if (!p.startsWith("/")) p = "/" + p;
  if (base && (p === base || p.startsWith(base + "/"))) return p;
  return base + p;
}

function unauthorized(req, res, reason = "Não autenticado") {
  // ✅ API/fetch: NUNCA redirecionar (senão volta HTML e quebra seu front)
  if (isApiCall(req) || !wantsHtml(req) || req.method !== "GET") {
    return res.status(401).json({
      ok: false,
      error: reason,
      // ✅ MUDANÇA: quando deslogado, manda pra seleção de plataforma
      redirect: withBase(req, "/selecao-plataforma"),
    });
  }

  // ✅ navegação (GET HTML): pode redirecionar
  // ✅ MUDANÇA: antes era /login
  return res.redirect(withBase(req, "/selecao-plataforma"));
}

function ensureAuth(req, res, next) {
  // ✅ deixa público apenas o essencial
  if (isPublic(req)) return next();

  try {
    const token = readToken(req);
    if (!token) return unauthorized(req, res, "Token ausente");

    const payload = jwt.verify(token, JWT_SECRET);

    req.user = payload; // { uid, email, nivel, nome, iat, exp }
    res.locals.user = payload;

    return next();
  } catch (err) {
    clearAuthCookie(res);
    return unauthorized(req, res, "Token inválido ou expirado");
  }
}

// Exige um nível específico (se quiser usar em alguma view/rota)
function requireNivel(nivelNecessario) {
  return function (req, res, next) {
    const u = req.user || res.locals.user;
    if (!u) return unauthorized(req, res, "Não autenticado");

    if (String(u.nivel) !== String(nivelNecessario)) {
      if (!isApiCall(req) && wantsHtml(req) && req.method === "GET") {
        return res.redirect(withBase(req, "/nao-autorizado"));
      }
      return res.status(403).json({ ok: false, error: "Acesso negado." });
    }

    return next();
  };
}

const ensureAdmin = requireNivel("administrador");

module.exports = {
  ensureAuth,
  requireNivel,
  ensureAdmin,
};
