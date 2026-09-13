// middleware/ensureAccount.js
// Garante que uma conta foi selecionada e injeta credenciais em res.locals.mlCreds
// Suporta (NOVO):
//  - OAuth: cookie "meli_conta_id" (id de meli_contas) -> busca tokens no banco
//
// Mantém o modo LEGADO comentado no final (cookie "ml_account" -> .env)

"use strict";

const db = require("../db/db");
const {
  canEncryptTokens,
  decryptToken,
  encryptToken,
  isEncryptedToken,
} = require("../services/tokenCrypto");
const {
  applySelectedAccountCookie,
  getDefaultAccountForUser,
} = require("../services/defaultMeliAccount");
const { isProductionEnvironment } = require("../../../lib/runtimeEnv");
const { buildPlanCheckoutUrl } = require("../services/hubCreditsService");
const { buildAccountBillingPayload } = require("../services/accountBillingStatus");

// ====== Cookie (NOVO padrão) ======
const COOKIE_OAUTH = "meli_conta_id"; // ✅ OAuth

// ✅ Flag opcional: manter compat com código antigo que lê process.env.*
// (DESLIGADO por padrão para não vazar token entre contas/usuários)
const LEGACY_ENV_COMPAT_REQUESTED =
  String(process.env.LEGACY_ENV_COMPAT || "") === "1";
const LEGACY_ENV_COMPAT =
  LEGACY_ENV_COMPAT_REQUESTED && !isProductionEnvironment();

// ✅ Log opcional (DESLIGADO por padrão)
const ENSURE_ACCOUNT_DEBUG =
  String(process.env.ENSURE_ACCOUNT_DEBUG || "") === "1";

if (LEGACY_ENV_COMPAT_REQUESTED && isProductionEnvironment()) {
  console.warn(
    "LEGACY_ENV_COMPAT foi ignorado em producao para evitar espelhamento de credenciais em process.env.",
  );
}

// ====== Rotas abertas (NÃO exigem conta selecionada) ======
// ⚠️ IMPORTANTE: isso NÃO é “público sem login”.
// No seu index.js, ensureAuth roda ANTES, então aqui é apenas “não exigir conta”.
const OPEN_PREFIXES = [
  // auth do app (login/cadastro)
  "/api/auth",

  // ✅ ADMIN: não exigir conta (master precisa entrar sem conta)
  "/api/admin",
  "/admin",

  // páginas necessárias pra escolher/vincular conta
  "/select-conta",
  "/vincular-conta",

  // OAuth ML (start/callback/contas/selecionar/limpar)
  "/api/meli",

  // API de conta (whoami/listar contas etc.)
  "/api/account",

  // Webhooks de integrações externas (server-to-server, validação por assinatura)
  "/api/integrations",

  // utilitários/health (se quiser exigir conta até aqui, remova)
  "/api/system/health",
  "/api/system/stats",
  "/api/health",
  "/health",
  "/test-basic",
  "/debug/routes",

  // estáticos
  "/favicon.ico",
  "/robots.txt",
  "/public",
  "/css",
  "/js",
  "/img",
  "/assets",
  "/_next",
  "/static",
];

const SKIP_METHODS = new Set(["OPTIONS", "HEAD"]);

function getReqPath(req) {
  // req.path é o melhor para comparar prefixos (sem querystring)
  return req.path || req.originalUrl || "";
}

function isOpen(req) {
  if (SKIP_METHODS.has(req.method)) return true;
  const p = getReqPath(req);

  // ✅ removeu "/" daqui de propósito: ter "/" aqui abre o app inteiro.
  return OPEN_PREFIXES.some((base) => p === base || p.startsWith(base + "/"));
}

function isApi(req) {
  const p = getReqPath(req);
  return p.startsWith("/api/");
}

function isBillingRecoveryPath(req) {
  const p = normalizedReqPath(req);
  if (p === "/conta/regularizar") return true;
  if (p === "/conta/creditos") return true;
  if (p === "/conta/contas") return true;
  if (p.startsWith("/api/account/")) return true;
  if (p.startsWith("/api/meli/")) return true;
  if (p.startsWith("/api/billing/")) return true;
  return false;
}

function wantsHtml(req) {
  // IMPORTANTE:
  // fetch() geralmente manda Accept "*/*" -> isso NÃO deve ser tratado como HTML.
  if (isApi(req)) return false;

  const accept = String(req.headers?.accept || "").toLowerCase();
  if (!accept) return false;

  return (
    accept.includes("text/html") || accept.includes("application/xhtml+xml")
  );
}

function normalizedReqPath(req) {
  const p = getReqPath(req);
  return p.replace(/^\/ml(?=\/)/, "");
}

function shouldHydrateOAuthTokens(req) {
  const method = String(req.method || "").toUpperCase();
  const p = normalizedReqPath(req);

  if (method === "GET") {
    if (p === "/api/analytics/filtro-anuncios/jobs") return false;
    if (/^\/api\/analytics\/filtro-anuncios\/jobs\/[^/]+$/.test(p)) {
      return false;
    }
  }

  if (
    method === "POST" &&
    /^\/api\/analytics\/filtro-anuncios\/jobs\/[^/]+\/cancel$/.test(p)
  ) {
    return false;
  }

  return true;
}

// ===============================
// Helpers: base path (suite /ml vs standalone /)
// ===============================
function mountBase(req) {
  const b = String(req.baseUrl || '');
  const i = b.indexOf('/api/');
  if (i >= 0) return b.slice(0, i) || '';
  return b;
}

function withBase(req, path) {
  const base = mountBase(req);
  if (!path) return base || '/';
  if (/^https?:\/\//i.test(path)) return path;
  const p = path.startsWith('/') ? path : `/${path}`;
  if (base && (p === base || p.startsWith(base + '/'))) return p;
  return base + p;
}

function deny(
  req,
  res,
  { status = 401, error = "Acesso negado", redirect = "/select-conta" } = {},
) {
  const redir = withBase(req, redirect);
  if (wantsHtml(req) && req.method === "GET") return res.redirect(redir);
  return res.status(status).json({ ok: false, error, redirect: redir });
}

function clearOAuthCookie(res) {
  // ✅ limpa possíveis versões antigas do cookie (path "/ml" vs "/")
  res.clearCookie(COOKIE_OAUTH, { path: "/ml" });
  res.clearCookie(COOKIE_OAUTH, { path: "/" });
}

// ===============================
// Helpers: uid / role (ROBUSTO)
// ===============================
function getUid(req) {
  // cobre formatos comuns do ensureAuth
  const raw =
    req.user?.uid ??
    req.user?.id ??
    req.user?.user_id ??
    req.user?.usuario_id ??
    null;

  const uid = Number(raw);
  return Number.isFinite(uid) ? uid : null;
}

function normalizeNivel(n) {
  return String(n || "")
    .trim()
    .toLowerCase();
}

function truthy(v) {
  return v === true || v === 1 || v === "1" || v === "true";
}

function isMaster(req) {
  // cobre formatos comuns:
  // - req.user.is_master
  // - req.user.flags.is_master
  // - req.user.isMaster
  // - req.user.nivel === admin_master
  // - req.user.role === admin_master
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

// ====== Helpers DB ======
async function withClient(fn) {
  // Compat: alguns projetos têm db.withClient; outros usam pool diretamente.
  if (typeof db.withClient === "function") return db.withClient(fn);

  // fallback: tenta usar db.connect() se existir (pg.Pool)
  if (typeof db.connect === "function") {
    const client = await db.connect();
    try {
      return await fn(client);
    } finally {
      client.release?.();
    }
  }

  throw new Error("db.withClient/db.connect não disponíveis em ../db/db");
}

// ====== Helpers OAuth (banco) ======
async function getEmpresaDoUsuario(client, usuarioId) {
  const r = await client.query(
    `select eu.empresa_id,
            eu.papel,
            e.nome as empresa_nome,
            e.tenant_global_id,
            e.document_type,
            e.document_number,
            u.user_global_id
       from empresa_usuarios eu
       join empresas e on e.id = eu.empresa_id
       join usuarios u on u.id = eu.usuario_id
      where eu.usuario_id = $1
      order by case eu.papel when 'owner' then 1 when 'admin' then 2 else 3 end
      limit 1`,
    [usuarioId],
  );
  return r.rows[0] || null;
}

async function maybeUpgradeStoredTokens(client, contaId, tokens) {
  if (!tokens || !contaId || !canEncryptTokens()) return;

  const hasPlainAccess =
    tokens.access_token && !isEncryptedToken(tokens.access_token);
  const hasPlainRefresh =
    tokens.refresh_token && !isEncryptedToken(tokens.refresh_token);

  if (!hasPlainAccess && !hasPlainRefresh) return;

  await client.query(
    `update meli_tokens
        set access_token = $2,
            refresh_token = $3
      where meli_conta_id = $1`,
    [
      contaId,
      tokens.access_token ? encryptToken(decryptToken(tokens.access_token)) : null,
      tokens.refresh_token
        ? encryptToken(decryptToken(tokens.refresh_token))
        : null,
    ],
  );
}

async function hydrateTokenPack(client, contaId, rawTokens) {
  try {
    await maybeUpgradeStoredTokens(client, contaId, rawTokens);
    return {
      tokens: hydrateTokens(rawTokens),
      token_error: null,
    };
  } catch (err) {
    console.error(
      "Erro ao carregar tokens OAuth da conta:",
      contaId,
      err?.message || err,
    );
    return {
      tokens: null,
      token_error: {
        code: err?.code || "TOKEN_LOAD_FAILED",
        message: err?.message || "Erro ao carregar tokens OAuth.",
      },
    };
  }
}

/**
 * Usuário comum/admin: valida que a conta pertence à empresa do usuário.
 */
async function getOAuthCredsForUserAndContaId(usuarioId, meliContaId, options = {}) {
  return withClient(async (client) => {
    const hydrateTokensForRequest = options.hydrateTokens !== false;
    const emp = await getEmpresaDoUsuario(client, usuarioId);
    if (!emp) return null;

    const c = await client.query(
      `select mc.id,
              mc.empresa_id,
              mc.meli_user_id,
              mc.apelido,
              mc.site_id,
              mc.status,
              mc.billing_status,
              mc.billing_mode,
              mc.usage_policy,
              mc.range_enforcement,
              mc.plan_code as billing_plan_code,
              mc.order_range_code as billing_order_range_code,
              mc.recommended_range_code,
              mc.last_closed_period_orders,
              mc.billing_grace_expires_at,
              mc.billing_review_due_at,
              $3::text as document_type,
              $4::text as document_number,
              $5::text as user_global_id
         from meli_contas mc
        where mc.id = $1 and mc.empresa_id = $2
          and lower(coalesce(mc.status, '')) not in ('desvinculada','revogada','unlinked','revoked')
        limit 1`,
      [
        meliContaId,
        emp.empresa_id,
        emp.document_type || null,
        emp.document_number || null,
        emp.user_global_id || null,
      ],
    );

    const conta = c.rows[0];
    if (!conta) return null;

    const tokenPack = hydrateTokensForRequest
      ? await (async () => {
          const t = await client.query(
            `select mt.access_token,
                    mt.access_expires_at,
                    mt.refresh_token,
                    mt.scope,
                    mt.refresh_obtido_em,
                    mt.ultimo_refresh_em
               from meli_tokens mt
              where mt.meli_conta_id = $1
              limit 1`,
            [conta.id],
          );

          return hydrateTokenPack(client, conta.id, t.rows[0] || null);
        })()
      : { tokens: null, token_error: null };

    return {
      conta,
      tokens: tokenPack.tokens,
      token_error: tokenPack.token_error,
      empresa_id: emp.empresa_id,
      empresa_nome: emp.empresa_nome,
      tenant_global_id: emp.tenant_global_id,
    };
  });
}

/**
 * ✅ Admin master: pode usar qualquer conta existente.
 * Retorna empresa_nome da conta selecionada (pra UI/header).
 */
async function getOAuthCredsForMasterAndContaId(meliContaId, options = {}) {
  return withClient(async (client) => {
    const hydrateTokensForRequest = options.hydrateTokens !== false;
    const c = await client.query(
      `select mc.id,
              mc.empresa_id,
              e.nome as empresa_nome,
              mc.meli_user_id,
              mc.apelido,
              mc.site_id,
              mc.status,
              mc.billing_status,
              mc.billing_mode,
              mc.usage_policy,
              mc.range_enforcement,
              mc.plan_code as billing_plan_code,
              mc.order_range_code as billing_order_range_code,
              mc.recommended_range_code,
              mc.last_closed_period_orders,
              mc.billing_grace_expires_at,
              mc.billing_review_due_at,
              e.tenant_global_id,
              e.document_type,
              e.document_number,
              null::text as user_global_id
         from meli_contas mc
         join empresas e on e.id = mc.empresa_id
        where mc.id = $1
          and lower(coalesce(mc.status, '')) not in ('desvinculada','revogada','unlinked','revoked')
        limit 1`,
      [meliContaId],
    );

    const conta = c.rows[0];
    if (!conta) return null;

    const tokenPack = hydrateTokensForRequest
      ? await (async () => {
          const t = await client.query(
            `select mt.access_token,
                    mt.access_expires_at,
                    mt.refresh_token,
                    mt.scope,
                    mt.refresh_obtido_em,
                    mt.ultimo_refresh_em
               from meli_tokens mt
              where mt.meli_conta_id = $1
              limit 1`,
            [conta.id],
          );

          return hydrateTokenPack(client, conta.id, t.rows[0] || null);
        })()
      : { tokens: null, token_error: null };

    return {
      conta: {
        id: conta.id,
        empresa_id: conta.empresa_id,
        meli_user_id: conta.meli_user_id,
        apelido: conta.apelido,
        site_id: conta.site_id,
        status: conta.status,
        billing_status: conta.billing_status,
        billing_mode: conta.billing_mode,
        usage_policy: conta.usage_policy,
        range_enforcement: conta.range_enforcement,
        billing_plan_code: conta.billing_plan_code,
        billing_order_range_code: conta.billing_order_range_code,
        recommended_range_code: conta.recommended_range_code,
        last_closed_period_orders: conta.last_closed_period_orders,
        billing_grace_expires_at: conta.billing_grace_expires_at,
        billing_review_due_at: conta.billing_review_due_at,
        document_type: conta.document_type || null,
        document_number: conta.document_number || null,
        user_global_id: conta.user_global_id || null,
      },
      tokens: tokenPack.tokens,
      token_error: tokenPack.token_error,
      empresa_id: conta.empresa_id,
      empresa_nome: conta.empresa_nome,
      tenant_global_id: conta.tenant_global_id,
    };
  });
}

function ensureCredsBag(res) {
  if (!res.locals) res.locals = {};
  if (!res.locals.mlCreds) res.locals.mlCreds = {};
  return res.locals.mlCreds;
}

function hydrateTokens(tokens) {
  if (!tokens) return null;

  return {
    ...tokens,
    access_token: tokens.access_token ? decryptToken(tokens.access_token) : null,
    refresh_token: tokens.refresh_token
      ? decryptToken(tokens.refresh_token)
      : null,
  };
}

function setMasterNoAccount(res) {
  // ✅ mínimo pra UI/header não quebrar
  res.locals.accountMode = "master_no_account";
  res.locals.accountKey = "master";
  res.locals.accountLabel = "MASTER (sem conta selecionada)";
  res.locals.account = {
    mode: "master_no_account",
    key: "master",
    label: res.locals.accountLabel,
    meli_user_id: null,
    site_id: "MLB",
    status: "no_account",
    empresa_id: null,
    empresa_nome: null,
  };

  const creds = ensureCredsBag(res);
  creds.account_key = "master";
  creds.meli_conta_id = null;
  creds.meli_user_id = null;
  creds.site_id = "MLB";
  creds.status = "no_account";
  creds.access_token = null;
  creds.refresh_token = null;
  creds.access_expires_at = null;
  creds.scope = null;
}

/**
 * ensureAccount
 */
async function ensureAccount(req, res, next) {
  if (isOpen(req)) return next();

  // 0) precisa estar autenticado no app (ensureAuth antes)
  const uid = getUid(req);
  if (!uid) {
    return deny(req, res, {
      status: 401,
      error: "Não autenticado",
      redirect: "/login",
    });
  }

  const master = isMaster(req);

  // 1) cookie OAuth (meli_conta_id)
  const raw = req.cookies?.[COOKIE_OAUTH];
  let meliContaId = raw ? Number(raw) : null;

  // ✅ NOVO: MASTER não depende de conta selecionada
  if (master && (!Number.isFinite(meliContaId) || meliContaId <= 0)) {
    setMasterNoAccount(res);

    if (ENSURE_ACCOUNT_DEBUG) {
      console.log(`🔐 ensureAccount master (sem conta) | uid=${uid}`);
    }

    return next();
  }

  if (!Number.isFinite(meliContaId) || meliContaId <= 0) {
    const defaultAccount = await getDefaultAccountForUser(uid);
    if (defaultAccount?.id) {
      meliContaId = Number(defaultAccount.id);
      applySelectedAccountCookie(res, meliContaId);
    }
  }

  // usuário comum precisa de conta
  if (!Number.isFinite(meliContaId) || meliContaId <= 0) {
    if (isBillingRecoveryPath(req)) {
      return next();
    }
    return deny(req, res, {
      status: 401,
      error: "Conta não selecionada",
      redirect: "/vincular-conta",
    });
  }

  try {
    const hydrateTokensForRequest = shouldHydrateOAuthTokens(req);
    const pack = master
      ? await getOAuthCredsForMasterAndContaId(meliContaId, {
          hydrateTokens: hydrateTokensForRequest,
        })
      : await getOAuthCredsForUserAndContaId(uid, meliContaId, {
          hydrateTokens: hydrateTokensForRequest,
        });

    if (!pack) {
      clearOAuthCookie(res);

      if (isBillingRecoveryPath(req)) {
        return next();
      }

      return deny(req, res, {
        status: 401,
        error: master
          ? "Conta selecionada não encontrada."
          : "Conta não selecionada",
        redirect: "/select-conta",
      });
    }

    // Identidade da conta para UI/log
    res.locals.accountMode = "oauth";
    res.locals.accountKey = String(pack.conta.id);

    // ✅ label mais informativo no modo master
    const baseLabel = pack.conta.apelido || `Conta ${pack.conta.meli_user_id}`;
    res.locals.accountLabel =
      master && pack.empresa_nome
        ? `${pack.empresa_nome} • ${baseLabel}`
        : baseLabel;

    res.locals.account = {
      mode: "oauth",
      key: String(pack.conta.id),
      label: res.locals.accountLabel,
      meli_user_id: pack.conta.meli_user_id,
      site_id: pack.conta.site_id || "MLB",
      status: pack.conta.status,
      empresa_id: pack.empresa_id,
      empresa_nome: pack.empresa_nome,
      tenant_id: pack.tenant_global_id || `ml_empresa_${pack.empresa_id}`,
      billing_status: pack.conta.billing_status || "legacy_active",
      billing_mode: pack.conta.billing_mode || "legacy",
      usage_policy: pack.conta.usage_policy || "metered",
      range_enforcement: Boolean(pack.conta.range_enforcement),
      plan_code: pack.conta.billing_plan_code || null,
      order_range_code: pack.conta.billing_order_range_code || null,
      recommended_range_code: pack.conta.recommended_range_code || null,
      last_closed_period_orders: pack.conta.last_closed_period_orders ?? null,
      billing_grace_expires_at: pack.conta.billing_grace_expires_at || null,
      billing_review_due_at: pack.conta.billing_review_due_at || null,
      document_type: pack.conta.document_type || null,
      document_number: pack.conta.document_number || null,
    };

    res.locals.empresaId = pack.empresa_id;
    res.locals.empresaNome = pack.empresa_nome;

    const creds = ensureCredsBag(res);

    creds.app_id =
      process.env.ML_APP_ID ||
      process.env.APP_ID ||
      process.env.CLIENT_ID ||
      null;

    creds.client_secret =
      process.env.ML_CLIENT_SECRET || process.env.CLIENT_SECRET || null;

    creds.redirect_uri =
      process.env.ML_REDIRECT_URI || process.env.REDIRECT_URI || null;

    creds.account_key = String(pack.conta.id);
    creds.meli_conta_id = pack.conta.id;
    creds.meli_user_id = pack.conta.meli_user_id;
    creds.site_id = pack.conta.site_id || "MLB";
    creds.status = pack.conta.status;
    creds.tenant_id = pack.tenant_global_id || `ml_empresa_${pack.empresa_id}`;
    creds.account_label = res.locals.accountLabel;
    creds.billing_status = pack.conta.billing_status || "legacy_active";
    creds.billing_mode = pack.conta.billing_mode || "legacy";
    creds.usage_policy = pack.conta.usage_policy || "metered";
    creds.range_enforcement = Boolean(pack.conta.range_enforcement);
    creds.billing_plan_code = pack.conta.billing_plan_code || null;
    creds.billing_order_range_code = pack.conta.billing_order_range_code || null;
    creds.billing_account = {
      meli_conta_id: pack.conta.id,
      meli_user_id: pack.conta.meli_user_id,
      tenant_id: creds.tenant_id,
      label: res.locals.accountLabel,
      billing_status: creds.billing_status,
      billing_mode: creds.billing_mode,
      usage_policy: creds.usage_policy,
      range_enforcement: creds.range_enforcement,
      plan_code: creds.billing_plan_code,
      order_range_code: creds.billing_order_range_code,
      recommended_range_code: pack.conta.recommended_range_code || null,
      last_closed_period_orders: pack.conta.last_closed_period_orders ?? null,
      billing_grace_expires_at: pack.conta.billing_grace_expires_at || null,
      billing_review_due_at: pack.conta.billing_review_due_at || null,
    };

    const renewalCheckoutUrl = buildPlanCheckoutUrl({
      mlCreds: creds,
      account: creds.billing_account,
      customerEmail: req.user?.email || req.user?.email_usuario || req.user?.login || null,
      customerName: req.user?.nome || req.user?.name || null,
      userId: pack.conta.user_global_id || req.user?.uid || req.user?.id || null,
      documentType: pack.conta.document_type || null,
      documentNumber: pack.conta.document_number || null,
    });
    const accountBilling = buildAccountBillingPayload(creds.billing_account, {
      renewalCheckoutUrl,
    });
    res.locals.account.billing = accountBilling;
    res.locals.mlCreds.billing = accountBilling;

    if (pack.tokens) {
      creds.access_token = pack.tokens.access_token || null;
      creds.refresh_token = pack.tokens.refresh_token || null;
      creds.access_expires_at = pack.tokens.access_expires_at || null;
      creds.scope = pack.tokens.scope || null;
    } else {
      creds.access_token = null;
      creds.refresh_token = null;
      creds.access_expires_at = null;
      creds.scope = null;
    }

    // ✅ IMPORTANTÍSSIMO:
    // Não escrever token em process.env por padrão (evita vazar token entre contas/usuários).
    creds.oauth_token_error = pack.token_error?.message || null;
    creds.oauth_token_error_code = pack.token_error?.code || null;

    if (LEGACY_ENV_COMPAT) {
      if (creds.access_token)
        process.env.ACCESS_TOKEN = String(creds.access_token);
      if (creds.app_id) process.env.APP_ID = String(creds.app_id);
      if (creds.client_secret)
        process.env.CLIENT_SECRET = String(creds.client_secret);
      if (creds.refresh_token)
        process.env.REFRESH_TOKEN = String(creds.refresh_token);
      if (creds.redirect_uri)
        process.env.REDIRECT_URI = String(creds.redirect_uri);
    }

    if (ENSURE_ACCOUNT_DEBUG) {
      console.log(
        `🔐 ensureAccount oauth ok | uid=${uid} master=${master} conta=${creds.meli_conta_id} empresa=${pack.empresa_nome} label="${res.locals.accountLabel}"`,
      );
    }

    if (!master && !accountBilling.can_operate && !isBillingRecoveryPath(req)) {
      const redirect = "/conta/regularizar";
      if (wantsHtml(req) && req.method === "GET") {
        return res.redirect(withBase(req, redirect));
      }
      return res.status(402).json({
        ok: false,
        error: "account_billing_required",
        message: accountBilling.reason,
        redirect: withBase(req, redirect),
        billing: accountBilling,
      });
    }

    return next();
  } catch (e) {
    console.error("❌ ensureAccount (oauth) erro:", e?.message || e);
    return deny(req, res, {
      status: 401,
      error: "Erro ao carregar conta OAuth",
      redirect: "/select-conta",
    });
  }
}

module.exports = ensureAccount;
