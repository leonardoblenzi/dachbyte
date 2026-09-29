"use strict";

const TokenService = require("../services/tokenService");

// Rotas/métodos que não precisam de token ML (evita refresh desnecessário)
const SKIP_PATHS = [
  /^\/admin(?:\/|$)/i,
  /^\/api\/admin(?:\/|$)/i,
  /^\/login(?:\/|$)/i,
  /^\/cadastro(?:\/|$)/i,
  /^\/selecao-plataforma(?:\/|$)/i,
  /^\/privacidade(?:\/|$)/i,
  /^\/privacy(?:\/|$)/i,
  /^\/politica-de-privacidade(?:\/|$)/i,
  /^\/nao-autorizado(?:\/|$)/i,
  /^\/select-conta(?:\/|$)/i,
  /^\/vincular-conta(?:\/|$)/i,
  /^\/conta\/contas(?:\/|$)/i,
  /^\/api\/meli(?:\/|$)/i,
  /^\/api\/account(?:\/|$)/i,
  /^\/api\/integrations(?:\/|$)/i,
  /^\/api\/health(?:\/|$)/i,
  /^\/health(?:\/|$)/i,
  /^\/api\/system\/health(?:\/|$)/i,
  /^\/api\/system\/stats(?:\/|$)/i,
  /^\/api\/analytics\/filtro-anuncios\/jobs$/i,
  /^\/api\/analytics\/filtro-anuncios\/jobs\/[^\/]+(?:\/|$)/i,
];

const SKIP_METHODS = new Set(["OPTIONS", "HEAD"]);

function isSkipped(req) {
  if (SKIP_METHODS.has(req.method)) return true;
  const p = req.path || req.originalUrl || "";
  return SKIP_PATHS.some((rx) => rx.test(p));
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

function ensureCredsBag(res) {
  if (!res.locals) res.locals = {};
  if (!res.locals.mlCreds) res.locals.mlCreds = {};
  return res.locals.mlCreds;
}

function getAccountMeta(res) {
  return {
    key: res?.locals?.accountKey || null,
    label: res?.locals?.accountLabel || null,
    mode: res?.locals?.accountMode || null,
    meli_conta_id: res?.locals?.mlCreds?.meli_conta_id || null,
  };
}

function attachAuthContext(req, res, accessToken) {
  const creds = ensureCredsBag(res);

  res.locals.accessToken = accessToken || null;
  creds.access_token = accessToken || creds.access_token || null;
  req.access_token = accessToken || null;

  req.ml = {
    accessToken: accessToken || null,
    creds,
    accountKey: res?.locals?.accountKey || null,
    accountLabel: res?.locals?.accountLabel || null,
    accountMode: res?.locals?.accountMode || null,
  };

  // Evita /users/me por request. A identidade do seller já veio da conta
  // carregada pelo ensureAccount e é suficiente para logs/contexto local.
  const sellerId = Number(creds.meli_user_id);
  if (Number.isFinite(sellerId) && sellerId > 0) {
    req.user_data = {
      user_id: sellerId,
      nickname: res?.locals?.accountLabel || creds.account_label || null,
    };
  }
}

function wantsHtml(req) {
  const accept = String(req.headers?.accept || "").toLowerCase();
  return (
    accept.includes("text/html") || accept.includes("application/xhtml+xml")
  );
}

function computeRedirectForTokenFailure(req, res) {
  const creds = res?.locals?.mlCreds || {};
  const hasConta = !!creds.meli_conta_id || !!res?.locals?.accountKey;
  if (hasConta && !creds.refresh_token) return withBase(req, "/vincular-conta");
  return withBase(req, "/select-conta");
}

function build401Payload(message, req, res, extra = {}) {
  return {
    ok: false,
    error: message,
    account: getAccountMeta(res),
    redirect: computeRedirectForTokenFailure(req, res),
    ...extra,
  };
}

const authMiddleware = async (req, res, next) => {
  if (isSkipped(req)) return next();

  try {
    const creds = ensureCredsBag(res);
    const token = await TokenService.renovarTokenSeNecessario(creds);

    if (!token) {
      const redirect = computeRedirectForTokenFailure(req, res);
      if (wantsHtml(req) && req.method === "GET") return res.redirect(redirect);
      return res.status(401).json(
        build401Payload(
          "Token de acesso indisponivel para a conta atual",
          req,
          res,
        ),
      );
    }

    attachAuthContext(req, res, token);
    return next();
  } catch (error) {
    console.error("authMiddleware:", error?.message || error);
    const redirect = computeRedirectForTokenFailure(req, res);
    if (wantsHtml(req) && req.method === "GET") return res.redirect(redirect);

    return res.status(401).json(
      build401Payload(
        "Nao foi possivel obter um token valido para a conta atual.",
        req,
        res,
        { reason: error?.code || "ml_token_unavailable" },
      ),
    );
  }
};

const authMiddlewareOptional = async (req, res, next) => {
  if (isSkipped(req)) return next();

  try {
    const creds = ensureCredsBag(res);
    let token = null;
    try {
      token = await TokenService.renovarTokenSeNecessario(creds);
    } catch (error) {
      console.warn(
        "authMiddlewareOptional: nao foi possivel obter/renovar token:",
        error?.message || error,
      );
    }

    attachAuthContext(req, res, token);
    return next();
  } catch (error) {
    console.warn("authMiddlewareOptional:", error?.message || error);
    return next();
  }
};

module.exports = { authMiddleware, authMiddlewareOptional };
