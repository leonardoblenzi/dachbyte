"use strict";

const TokenService = require("../services/tokenService");

// Rotas/métodos que não precisam de token ML (evita refresh desnecessário)
const SKIP_PATHS = [
  // ✅ Admin do sistema NÃO deve depender de token ML / conta selecionada
  // (MASTER precisa conseguir entrar no painel mesmo sem meli_conta_id)
  /^\/admin(?:\/|$)/i,
  /^\/api\/admin(?:\/|$)/i,

  // ✅ Páginas públicas / escolha de conta (não precisa token ML)
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

  // ✅ OAuth / seleção/vinculação (não precisa token ML)
  // (mais seguro: pula tudo do /api/meli e /api/account)
  /^\/api\/meli(?:\/|$)/i,
  /^\/api\/account(?:\/|$)/i,
  /^\/api\/integrations(?:\/|$)/i,

  // health checks (se você quiser PROTEGER esses também, remova daqui)
  /^\/api\/health(?:\/|$)/i,
  /^\/health(?:\/|$)/i,
  /^\/api\/system\/health(?:\/|$)/i,
  /^\/api\/system\/stats(?:\/|$)/i,
  // polling/download filtro-anuncios (não precisa token ML)
  /^\/api\/analytics\/filtro-anuncios\/jobs$/i,
  /^\/api\/analytics\/filtro-anuncios\/jobs\/[^\/]+(?:\/|$)/i,
];

const SKIP_METHODS = new Set(["OPTIONS", "HEAD"]);

function isSkipped(req) {
  if (SKIP_METHODS.has(req.method)) return true;
  const p = req.path || req.originalUrl || "";
  return SKIP_PATHS.some((rx) => rx.test(p));
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

  // Compat com código legado
  req.access_token = accessToken || null;

  // Atalho útil em handlers
  req.ml = {
    accessToken: accessToken || null,
    creds,
    accountKey: res?.locals?.accountKey || null,
    accountLabel: res?.locals?.accountLabel || null,
    accountMode: res?.locals?.accountMode || null,
  };
}

function wantsHtml(req) {
  // Evita tratar fetch "*/*" como HTML
  const accept = String(req.headers?.accept || "").toLowerCase();
  return (
    accept.includes("text/html") || accept.includes("application/xhtml+xml")
  );
}

/**
 * Decide para onde redirecionar quando falhar token.
 * - Se não há conta selecionada -> /select-conta
 * - Se há conta, mas falta refresh_token -> /vincular-conta
 */
function computeRedirectForTokenFailure(req, res) {
  const creds = res?.locals?.mlCreds || {};
  const hasConta = !!creds.meli_conta_id || !!res?.locals?.accountKey;

  // ✅ IMPORTANTE: quando o ML app está montado na Suite em /ml,
  // redirects precisam incluir o prefixo /ml, senão cai na Suite e vira 404.
  if (hasConta && !creds.refresh_token) return withBase(req, "/vincular-conta");
  return withBase(req, "/select-conta");
}

function build401Payload(message, req, res, extra = {}) {
  const account = getAccountMeta(res);
  const redirect = computeRedirectForTokenFailure(req, res);

  return {
    ok: false,
    error: message,
    account,
    redirect,
    ...extra,
  };
}

// 🔒 Exige token ML válido
const authMiddleware = async (req, res, next) => {
  if (isSkipped(req)) return next();

  try {
    const creds = ensureCredsBag(res);

    // ✅ Com OAuth, ensureAccount injeta:
    // creds.meli_conta_id, refresh_token, access_token, access_expires_at, etc.
    const token = await TokenService.renovarTokenSeNecessario(creds);

    if (!token) {
      const redirect = computeRedirectForTokenFailure(req, res);

      if (wantsHtml(req) && req.method === "GET") return res.redirect(redirect);

      return res
        .status(401)
        .json(
          build401Payload(
            "Token de acesso indisponível para a conta atual",
            req,
            res
          )
        );
    }

    attachAuthContext(req, res, token);

    // (opcional) preenche dados do user para logs/ui
    try {
      const teste = await TokenService.testarToken(res.locals.mlCreds);
      if (teste?.success) {
        req.user_data = { user_id: teste.user_id, nickname: teste.nickname };
      }
    } catch (e) {
      console.warn(
        "⚠️ authMiddleware: falha ao testar token:",
        e?.message || e
      );
    }

    return next();
  } catch (error) {
    console.error("❌ authMiddleware:", error?.message || error);

    const redirect = computeRedirectForTokenFailure(req, res);

    if (wantsHtml(req) && req.method === "GET") return res.redirect(redirect);

    return res
      .status(401)
      .json(
        build401Payload(
          "Token inválido e não foi possível renovar: " +
            (error?.message || "Erro desconhecido"),
          req,
          res
        )
      );
  }
};

// 🔓 Não bloqueia se não tiver token (apenas injeta contexto)
const authMiddlewareOptional = async (req, res, next) => {
  if (isSkipped(req)) return next();

  try {
    const creds = ensureCredsBag(res);

    let token = null;
    try {
      token = await TokenService.renovarTokenSeNecessario(creds);
    } catch (e) {
      console.warn(
        "⚠️ authMiddlewareOptional: não foi possível obter/renovar token:",
        e?.message || e
      );
    }

    attachAuthContext(req, res, token);

    if (token) {
      try {
        const teste = await TokenService.testarToken(res.locals.mlCreds);
        if (teste?.success) {
          req.user_data = { user_id: teste.user_id, nickname: teste.nickname };
        }
      } catch (e) {
        console.warn(
          "⚠️ authMiddlewareOptional: falha ao testar token:",
          e?.message || e
        );
      }
    }

    return next();
  } catch (error) {
    console.warn("⚠️ authMiddlewareOptional:", error?.message || error);
    return next(); // não bloqueia
  }
};

module.exports = { authMiddleware, authMiddlewareOptional };
