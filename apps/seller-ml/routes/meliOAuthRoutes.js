// routes/meliOAuthRoutes.js
"use strict";

const express = require("express");
const crypto = require("crypto");
const db = require("../db/db");
const { createAuditAction } = require("../middleware/auditAction");
const { oauthRateLimiter } = require("../middleware/security");
const { canEncryptTokens, encryptToken } = require("../services/tokenCrypto");
const {
  setDefaultAccountForUser,
  setDefaultIfMissingForMembership,
} = require("../services/defaultMeliAccount");
const { buildPlanCheckoutUrl } = require("../services/hubCreditsService");
const { buildAccountBillingPayload } = require("../services/accountBillingStatus");

const router = express.Router();

// ===============================
// Config do seu App (Mercado Livre)
// ===============================
const ML_APP_ID =
  process.env.ML_APP_ID || process.env.APP_ID || process.env.CLIENT_ID;

const ML_CLIENT_SECRET =
  process.env.ML_CLIENT_SECRET || process.env.CLIENT_SECRET;

const ML_REDIRECT_URI_ENV =
  process.env.ML_REDIRECT_URI || process.env.REDIRECT_URI || "";
const ML_PUBLIC_ORIGIN_ENV =
  process.env.ML_PUBLIC_ORIGIN ||
  process.env.PUBLIC_APP_ORIGIN ||
  process.env.APP_PUBLIC_URL ||
  "";

if (!ML_APP_ID) {
  console.warn("⚠️ ML_APP_ID não definido (ML_APP_ID / APP_ID / CLIENT_ID).");
}
if (!ML_CLIENT_SECRET) {
  console.warn(
    "⚠️ ML_CLIENT_SECRET não definido (ML_CLIENT_SECRET / CLIENT_SECRET).",
  );
}
if (!String(ML_REDIRECT_URI_ENV || "").trim()) {
  console.warn(
    "⚠️ ML_REDIRECT_URI não definido (ML_REDIRECT_URI / REDIRECT_URI). Será tentado fallback automático em runtime.",
  );
}
if (!canEncryptTokens()) {
  console.warn(
    "⚠️ ML_TOKEN_ENCRYPTION_KEY/TOKEN_ENCRYPTION_KEY não configurada; a persistência de tokens continuará em texto puro até a chave ser definida.",
  );
}

// Brasil (ajuste se precisar multi-país)
const AUTH_BASE = "https://auth.mercadolivre.com.br/authorization";
const TOKEN_URL = "https://api.mercadolibre.com/oauth/token";
const ML_USERS_URL = "https://api.mercadolibre.com/users";

// Cookie da conta selecionada (novo padrão)
const COOKIE_MELI_CONTA = "meli_conta_id";

const isProd =
  String(process.env.NODE_ENV || "").toLowerCase() === "production";

// Em produção (Render), você está com trust proxy = 1, então secure funciona
function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: true,
    maxAge: 30 * 24 * 3600 * 1000,
    path: "/",
  };
}
// ===============================
// Helpers: base path (suite /ml vs standalone /)
// ===============================
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
  const p = String(path).startsWith("/") ? String(path) : `/${path}`;
  if (base && (p === base || p.startsWith(base + "/"))) return p;
  return base + p;
}

function getPublicOrigin(req) {
  const configuredOriginRaw = String(ML_PUBLIC_ORIGIN_ENV || "").trim();
  if (configuredOriginRaw) {
    try {
      return new URL(configuredOriginRaw).origin;
    } catch {
      // fallback para origem calculada da request
    }
  }

  const proto =
    String(req.headers?.["x-forwarded-proto"] || req.protocol || "https")
      .split(",")[0]
      .trim() || "https";

  const host = String(
    req.headers?.["x-forwarded-host"] || req.headers?.host || "",
  )
    .split(",")[0]
    .trim();

  if (!host) return "";
  return `${proto}://${host}`;
}

function buildAbsoluteUrl(req, path) {
  const origin = getPublicOrigin(req);
  const mountedPath = withBase(req, path || "/");
  return origin ? `${origin}${mountedPath}` : mountedPath;
}

function resolveRedirectUri(req) {
  const configured = String(ML_REDIRECT_URI_ENV || "").trim();
  const runtime = buildAbsoluteUrl(req, "/api/meli/oauth/callback");
  const configuredOriginRaw = String(ML_PUBLIC_ORIGIN_ENV || "").trim();
  let canonicalOrigin = "";

  if (configuredOriginRaw) {
    try {
      canonicalOrigin = new URL(configuredOriginRaw).origin;
    } catch {
      canonicalOrigin = "";
    }
  }

  if (!configured) {
    if (!canonicalOrigin) return runtime;
    try {
      const run = new URL(runtime);
      return `${canonicalOrigin}${run.pathname}`;
    } catch {
      return runtime;
    }
  }

  try {
    const cfg = new URL(configured);
    const run = new URL(runtime);

    const cfgPath = cfg.pathname.replace(/\/+$/, "") || "/";
    const runPath = run.pathname.replace(/\/+$/, "") || "/";

    const cfgLooksLikeOAuthCallback = /(?:\/ml)?\/api\/meli\/oauth\/callback$/i.test(
      cfgPath,
    );

    if (!cfgLooksLikeOAuthCallback) {
      console.warn(
        `⚠️ [ML][OAuth] ML_REDIRECT_URI (${configured}) não parece callback OAuth válido. Usando callback em runtime (${runtime}).`,
      );
      if (canonicalOrigin) return `${canonicalOrigin}${runPath}`;
      return runtime;
    }

    if (canonicalOrigin) {
      if (cfg.origin !== canonicalOrigin || cfgPath !== runPath) {
        console.warn(
          `⚠️ [ML][OAuth] Forçando origem canônica (${canonicalOrigin}) e path atual (${runPath}) para o callback OAuth.`,
        );
      }
      return `${canonicalOrigin}${runPath}`;
    }

    if (cfgPath !== runPath || cfg.origin !== run.origin) {
      console.warn(
        `⚠️ [ML][OAuth] ML_REDIRECT_URI (${configured}) diverge da requisição atual (${runtime}). Usando callback em runtime para manter o mesmo host da sessão.`,
      );
      return runtime;
    }

    return configured;
  } catch {
    return runtime;
  }
}

function getFetchImpl() {
  if (typeof fetch === "function") return fetch.bind(globalThis);
  // fallback para ambientes Node mais antigos
  // eslint-disable-next-line global-require
  const mod = require("node-fetch");
  return mod.default || mod;
}

async function doFetch(...args) {
  const fetchImpl = getFetchImpl();
  return fetchImpl(...args);
}

function wantsHtml(req) {
  const accept = String(req.headers?.accept || "").toLowerCase();
  return (
    accept.includes("text/html") || accept.includes("application/xhtml+xml")
  );
}

// ===============================
// Helpers: auth/role
// ===============================
function mustBeLogged(req) {
  const uid = Number(req.user?.uid);
  return Number.isFinite(uid) ? uid : null;
}

function normalizeNivel(n) {
  return String(n || "")
    .trim()
    .toLowerCase();
}

function isMaster(req) {
  return (
    normalizeNivel(req.user?.nivel) === "admin_master" ||
    req.user?.is_master === true
  );
}

function readCurrentContaId(req) {
  const raw = req.cookies?.[COOKIE_MELI_CONTA];
  const id = Number(raw);
  return Number.isFinite(id) ? id : null;
}

function parseBoolLike(v) {
  const s = String(v ?? "")
    .trim()
    .toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

function clampInt(n, min, max, def) {
  const x = Number(n);
  if (!Number.isFinite(x)) return def;
  return Math.max(min, Math.min(max, Math.trunc(x)));
}

// ===============================
// Helpers PKCE + state
// ===============================
function base64Url(buf) {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function sha256Base64Url(str) {
  const hash = crypto.createHash("sha256").update(str).digest();
  return base64Url(hash);
}

function randomState() {
  return base64Url(crypto.randomBytes(24));
}

function randomVerifier() {
  // 64 bytes -> ~86 chars base64url
  return base64Url(crypto.randomBytes(64));
}

// Evita open redirect: só aceita path interno do seu app
function sanitizeReturnTo(input) {
  let rt = String(input || "/vincular-conta").trim() || "/vincular-conta";
  // precisa começar com "/" e não pode começar com "//"
  if (!rt.startsWith("/") || rt.startsWith("//")) rt = "/vincular-conta";
  return rt;
}

async function getEmpresaDoUsuario(client, usuarioId) {
  // MVP: assume 1 usuário -> 1 empresa (owner/admin/operador)
  const r = await client.query(
    `select eu.empresa_id, eu.papel, e.nome as empresa_nome
       from empresa_usuarios eu
       join empresas e on e.id = eu.empresa_id
      where eu.usuario_id = $1
      order by case eu.papel when 'owner' then 1 when 'admin' then 2 else 3 end
      limit 1`,
    [usuarioId],
  );
  return r.rows[0] || null;
}

function createUserWithoutCompanyError(usuarioId) {
  const err = new Error(
    `Usuario ${usuarioId} nao esta vinculado a nenhuma empresa.`,
  );
  err.code = "USER_WITHOUT_COMPANY";
  err.status = 403;
  return err;
}

function isUserWithoutCompanyError(err) {
  return (
    String(err?.code || "").toUpperCase() === "USER_WITHOUT_COMPANY" ||
    /nao esta vinculado a nenhuma empresa/i.test(String(err?.message || ""))
  );
}

function isMissingMlSchemaError(err) {
  const code = String(err?.code || "").toUpperCase();
  return code === "42P01" || code === "42703" || code === "3F000";
}

function userWithoutCompanyPayload() {
  return {
    ok: false,
    code: "USER_WITHOUT_COMPANY",
    error:
      "Seu usuario ainda nao esta vinculado a uma empresa. Peca para o administrador criar o vinculo em /admin/vinculos.",
  };
}

function missingSchemaPayload() {
  return {
    ok: false,
    code: "ML_SCHEMA_INCOMPLETE",
    error:
      "Estrutura OAuth/contas do Mercado Livre incompleta no banco. Execute as migracoes 004, 005 e 006.",
  };
}

// (Opcional) busca nickname no ML para usar como apelido default
async function tryGetMlNickname(accessToken, meliUserId) {
  try {
    if (!accessToken || !meliUserId) return null;

    const resp = await doFetch(`${ML_USERS_URL}/${meliUserId}`, {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${accessToken}`,
      },
    });

    if (!resp.ok) return null;

    const data = await resp.json().catch(() => null);
    const nick = String(data?.nickname || "").trim();
    return nick || null;
  } catch {
    return null;
  }
}

// ===============================
// ✅ GET /api/meli/contas
// - Usuário normal/admin: lista contas da empresa do usuário
// - Master: lista TODAS as contas (todas empresas)
// Suporta:
//   ?q=busca (empresa/apelido/meli_user_id)   (empresa só master)
//   ?active_only=1 (somente status='ativa')
//   ?page=1..n
//   ?limit=6..50
//
// Retorna também:
// - has_tokens (true/false)
// - access_expires_at
// - expires_in_min (✅ calculado no banco)
// - empresa_nome (apenas master)
// - paginação (total/total_pages)
// - current_meli_conta_id (cookie)
// ===============================
router.get("/contas", async (req, res) => {
  try {
    const uid = mustBeLogged(req);
    if (!uid)
      return res.status(401).json({ ok: false, error: "Não autenticado." });

    const master = isMaster(req);
    let currentId = readCurrentContaId(req);

    const q = String(req.query?.q || "").trim();
    const onlyActive = parseBoolLike(
      req.query?.active_only || req.query?.onlyActive,
    );
    const includeUnlinked = parseBoolLike(
      req.query?.include_unlinked || req.query?.includeUnlinked,
    );

    const page = clampInt(req.query?.page, 1, 999999, 1);
    const pageSize = clampInt(
      req.query?.limit || req.query?.pageSize,
      6,
      50,
      12,
    );
    const offset = (page - 1) * pageSize;

    const data = await db.withClient(async (client) => {
      const where = [];
      const params = [];
      let p = 1;

      // Se NÃO for master, restringe à empresa do usuário
      if (!master) {
        const emp = await getEmpresaDoUsuario(client, uid);
        if (!emp) throw createUserWithoutCompanyError(uid);
        where.push(`c.empresa_id = $${p++}`);
        params.push(emp.empresa_id);
      }

      if (onlyActive) {
        // tolerante a variações
        where.push(`lower(c.status) in ('ativa','active','enabled')`);
      }

      if (!includeUnlinked) {
        where.push(`lower(coalesce(c.status, '')) not in ('desvinculada','revogada','unlinked','revoked')`);
      }

      if (q) {
        if (master) {
          where.push(`(
            e.nome ilike $${p} or
            c.apelido ilike $${p} or
            cast(c.meli_user_id as text) ilike $${p}
          )`);
          params.push(`%${q}%`);
          p++;
        } else {
          where.push(`(
            c.apelido ilike $${p} or
            cast(c.meli_user_id as text) ilike $${p}
          )`);
          params.push(`%${q}%`);
          p++;
        }
      }

      const whereSql = where.length ? `where ${where.join(" and ")}` : "";

      const countSql = master
        ? `select count(*)::int as total
             from meli_contas c
             join empresas e on e.id = c.empresa_id
             ${whereSql}`
        : `select count(*)::int as total
             from meli_contas c
             ${whereSql}`;

      const total =
        (await client.query(countSql, params)).rows?.[0]?.total || 0;

      // ✅ expires_in_min: calculado no banco (evita parse errado no front)
      const expiresExpr = `
        case
          when t.access_expires_at is null then null
          else floor(extract(epoch from (t.access_expires_at - now()))/60)::int
        end as expires_in_min
      `;

      const listSql = master
        ? `select
             c.id, c.empresa_id, e.nome as empresa_nome,
             c.meli_user_id, c.apelido, c.site_id, c.status,
             c.billing_status, c.billing_mode, c.usage_policy, c.range_enforcement,
             c.plan_code, c.order_range_code, c.recommended_range_code,
             c.last_closed_period_orders, c.billing_grace_expires_at, c.billing_review_due_at,
             e.tenant_global_id,
             c.criado_em, c.atualizado_em, c.ultimo_uso_em,
             (t.meli_conta_id is not null) as has_tokens,
             false as is_default,
             t.access_expires_at,
             ${expiresExpr}
           from meli_contas c
           join empresas e on e.id = c.empresa_id
           left join meli_tokens t on t.meli_conta_id = c.id
           ${whereSql}
           order by c.id desc
           limit $${p} offset $${p + 1}`
        : `select
             c.id, c.empresa_id, e.nome as empresa_nome,
             c.meli_user_id, c.apelido, c.site_id, c.status,
             c.billing_status, c.billing_mode, c.usage_policy, c.range_enforcement,
             c.plan_code, c.order_range_code, c.recommended_range_code,
             c.last_closed_period_orders, c.billing_grace_expires_at, c.billing_review_due_at,
             e.tenant_global_id,
             c.criado_em, c.atualizado_em, c.ultimo_uso_em,
             (t.meli_conta_id is not null) as has_tokens,
             (eu.default_meli_conta_id = c.id) as is_default,
             t.access_expires_at,
             ${expiresExpr}
           from meli_contas c
           join empresas e on e.id = c.empresa_id
           left join meli_tokens t on t.meli_conta_id = c.id
           left join empresa_usuarios eu
             on eu.usuario_id = $${p}
            and eu.empresa_id = c.empresa_id
           ${whereSql}
           order by (eu.default_meli_conta_id = c.id) desc, c.id desc
           limit $${p + 1} offset $${p + 2}`;

      const listParams = master
        ? [...params, pageSize, offset]
        : [...params, uid, pageSize, offset];
      const rows = (await client.query(listSql, listParams)).rows || [];

      const rowsWithCheckout = rows.map((row) => {
        const renewalCheckoutUrl = buildPlanCheckoutUrl({
          account: row,
          customerEmail: req.user?.email || req.user?.email_usuario || req.user?.login || null,
          customerName: req.user?.nome || req.user?.name || null,
        });
        return {
          ...row,
          renewal_checkout_url: renewalCheckoutUrl,
          billing: buildAccountBillingPayload(row, { renewalCheckoutUrl }),
        };
      });

      return { rows: rowsWithCheckout, total };
    });

    // ✅ Higiene do cookie (somente NÃO-master): valida no banco se a conta pertence à empresa do usuário
    // (não pode depender da página atual, senão apaga cookie por paginação)
    if (currentId && !master) {
      const okCurrent = await db.withClient(async (client) => {
        const emp = await getEmpresaDoUsuario(client, uid);
        if (!emp) return false;

        const r = await client.query(
          `select 1
             from meli_contas
            where id = $1 and empresa_id = $2
              and lower(coalesce(status, '')) not in ('desvinculada','revogada','unlinked','revoked')
            limit 1`,
          [currentId, emp.empresa_id],
        );
        return !!r.rows[0];
      });

      if (!okCurrent) {
        res.clearCookie(COOKIE_MELI_CONTA, { path: "/" });
        currentId = null;
      }
    }

    const totalPages = Math.max(1, Math.ceil((data.total || 0) / pageSize));

    return res.json({
      ok: true,
      contas: data.rows,
      current_meli_conta_id: currentId || null,
      page,
      pageSize,
      total: data.total || 0,
      totalPages,
      is_master: master,
    });
  } catch (e) {
    if (isUserWithoutCompanyError(e)) {
      res.clearCookie(COOKIE_MELI_CONTA, { path: "/ml" });
      res.clearCookie(COOKIE_MELI_CONTA, { path: "/" });
      return res.status(403).json(userWithoutCompanyPayload());
    }

    if (isMissingMlSchemaError(e)) {
      return res.status(503).json(missingSchemaPayload());
    }

    console.error("GET /api/meli/contas erro:", {
      message: e?.message || e,
      code: e?.code || null,
    });
    return res.status(500).json({
      ok: false,
      error: "Erro ao listar contas vinculadas.",
    });
  }
});

// ===============================
// POST /api/meli/selecionar
// body: { meli_conta_id }
// - Usuário normal/admin: só seleciona conta da própria empresa
// - Master: pode selecionar qualquer conta existente
// ===============================

async function handleSelecionarConta(req, res, rawContaId, opts = {}) {
  const { redirectOnSuccess = false } = opts;
  const wantsRedirect =
    redirectOnSuccess && wantsHtml(req) && req.method === "GET";

  const uid = mustBeLogged(req);
  if (!uid) {
    if (wantsRedirect) return res.redirect(withBase(req, "/login"));
    return res.status(401).json({ ok: false, error: "Não autenticado." });
  }

  const master = isMaster(req);
  const meli_conta_id = Number(rawContaId);

  if (!Number.isFinite(meli_conta_id) || meli_conta_id <= 0) {
    if (wantsRedirect) return res.redirect(withBase(req, "/select-conta"));
    return res.status(400).json({
      ok: false,
      error: "meli_conta_id inválido.",
      received: rawContaId ?? null,
    });
  }

  try {
    const conta = await db.withClient(async (client) => {
      if (master) {
        const r = await client.query(
          `
          select id, empresa_id, meli_user_id, apelido, site_id, status
            from meli_contas
           where id = $1
             and lower(coalesce(status, '')) not in ('desvinculada','revogada','unlinked','revoked')
           limit 1
          `,
          [meli_conta_id],
        );
        return r.rows[0] || null;
      }

      const emp = await getEmpresaDoUsuario(client, uid);
      if (!emp) {
        throw createUserWithoutCompanyError(uid);
      }

      const r = await client.query(
        `
        select c.id, c.empresa_id, c.meli_user_id, c.apelido, c.site_id, c.status
          from meli_contas c
         where c.id = $1
           and c.empresa_id = $2
           and lower(coalesce(c.status, '')) not in ('desvinculada','revogada','unlinked','revoked')
         limit 1
        `,
        [meli_conta_id, emp.empresa_id],
      );

      return r.rows[0] || null;
    });

    if (!conta) {
      if (wantsRedirect) return res.redirect(withBase(req, "/select-conta"));
      return res.status(404).json({
        ok: false,
        error: master
          ? "Conta não encontrada."
          : "Conta não encontrada para sua empresa.",
      });
    }

    try {
      await db.query(
        `update meli_contas set ultimo_uso_em = now() where id = $1`,
        [meli_conta_id],
      );
    } catch (e) {
      console.warn(
        "⚠️ Falha ao atualizar ultimo_uso_em em /api/meli/selecionar:",
        e?.message || e,
      );
    }

    res.clearCookie(COOKIE_MELI_CONTA, { path: "/ml" });
    res.clearCookie(COOKIE_MELI_CONTA, { path: "/" });
    res.cookie(COOKIE_MELI_CONTA, String(meli_conta_id), cookieOptions());

    if (wantsRedirect) {
      return res.redirect(withBase(req, "/painel"));
    }

    return res.json({
      ok: true,
      meli_conta_id,
      conta: {
        id: conta.id,
        empresa_id: conta.empresa_id,
        meli_user_id: conta.meli_user_id,
        apelido: conta.apelido,
        site_id: conta.site_id,
        status: conta.status,
      },
    });
  } catch (e) {
    if (isUserWithoutCompanyError(e)) {
      if (wantsRedirect) return res.redirect(withBase(req, "/select-conta"));
      return res.status(403).json(userWithoutCompanyPayload());
    }

    console.error("handleSelecionarConta erro:", {
      message: e?.message || String(e),
      stack: e?.stack || null,
      uid,
      rawContaId,
      meli_conta_id,
      master,
      user: req.user || null,
    });

    if (wantsRedirect) {
      return res.redirect(withBase(req, "/select-conta"));
    }

    return res.status(500).json({
      ok: false,
      error: "Erro ao selecionar conta.",
      detail: e?.message || "Erro interno",
    });
  }
}

router.get(
  "/selecionar",
  createAuditAction({
    evento: "meli_account_selected",
    metadata: (req) => ({
      meli_conta_id: Number(req.query?.meli_conta_id) || null,
      via: "query",
    }),
  }),
  async (req, res) => {
  return handleSelecionarConta(req, res, req.query?.meli_conta_id, {
    redirectOnSuccess: true,
  });
  },
);

router.post(
  "/selecionar",
  createAuditAction({
    evento: "meli_account_selected",
    metadata: (req) => ({
      meli_conta_id: Number(req.body?.meli_conta_id) || null,
      via: "body",
    }),
  }),
  express.json({ limit: "50kb" }),
  async (req, res) => {
    return handleSelecionarConta(req, res, req.body?.meli_conta_id, {
      redirectOnSuccess: false,
    });
  },
);

// ===============================
// POST /api/meli/limpar-selecao
// Limpa cookie meli_conta_id
// ===============================
router.post(
  "/limpar-selecao",
  createAuditAction({
    evento: "meli_account_selection_cleared",
  }),
  async (_req, res) => {
    res.clearCookie(COOKIE_MELI_CONTA, { path: "/ml" });
    res.clearCookie(COOKIE_MELI_CONTA, { path: "/" });
    return res.json({ ok: true });
  },
);

// ===============================
// POST /api/meli/default
// Define a conta padrao do usuario comum para os proximos logins.
// ===============================
router.post(
  "/default",
  createAuditAction({
    evento: "meli_default_account_selected",
    metadata: (req) => ({
      meli_conta_id: Number(req.body?.meli_conta_id) || null,
    }),
  }),
  express.json({ limit: "50kb" }),
  async (req, res) => {
    try {
      const uid = mustBeLogged(req);
      if (!uid) {
        return res.status(401).json({ ok: false, error: "NÃ£o autenticado." });
      }

      if (isMaster(req)) {
        return res.status(403).json({
          ok: false,
          error: "Master nao usa conta padrao individual neste fluxo.",
        });
      }

      const meliContaId = Number(req.body?.meli_conta_id);
      if (!Number.isFinite(meliContaId) || meliContaId <= 0) {
        return res.status(400).json({
          ok: false,
          error: "meli_conta_id invÃ¡lido.",
        });
      }

      const account = await setDefaultAccountForUser(uid, meliContaId);
      if (!account) {
        return res.status(404).json({
          ok: false,
          error: "Conta nÃ£o encontrada para sua empresa.",
        });
      }

      return res.json({
        ok: true,
        default_meli_conta_id: account.id,
        conta: {
          id: account.id,
          empresa_id: account.empresa_id,
          meli_user_id: account.meli_user_id,
          apelido: account.apelido,
          site_id: account.site_id,
          status: account.status,
          is_default: true,
        },
      });
    } catch (e) {
      console.error("POST /api/meli/default erro:", e?.message || e);
      return res.status(500).json({
        ok: false,
        error: "Erro ao definir conta padrao.",
      });
    }
  },
);

// ===============================
// POST /api/meli/oauth/start
// body: { return_to? }
// ===============================
router.post(
  "/oauth/start",
  oauthRateLimiter,
  createAuditAction({
    evento: "meli_oauth_started",
    metadata: (req) => ({
      return_to: sanitizeReturnTo(req.body?.return_to || "/vincular-conta"),
    }),
  }),
  express.json({ limit: "200kb" }),
  async (req, res) => {
    try {
      if (!ML_APP_ID || !ML_CLIENT_SECRET) {
        return res.status(500).json({
          ok: false,
          error: "Config do Mercado Livre incompleta (APP_ID/SECRET).",
        });
      }

      const uid = mustBeLogged(req);
      if (!uid)
        return res.status(401).json({ ok: false, error: "Não autenticado." });

      const return_to = sanitizeReturnTo(
        req.body?.return_to || "/vincular-conta",
      );

      const redirectUri = resolveRedirectUri(req);
      if (!redirectUri) {
        return res.status(500).json({
          ok: false,
          error:
            "Não foi possível determinar a URL de callback do Mercado Livre.",
        });
      }

      const state = randomState();
      const code_verifier = randomVerifier();
      const code_challenge = sha256Base64Url(code_verifier);

      const expiraEm = new Date(Date.now() + 10 * 60 * 1000); // 10 min

      await db.withClient(async (client) => {
        await client.query("begin");
        try {
          const empresa = await getEmpresaDoUsuario(client, uid);
          if (!empresa) throw createUserWithoutCompanyError(uid);

          await client.query(
            `delete from oauth_states where expira_em < now()`,
          );

          await client.query(
            `insert into oauth_states (state, empresa_id, usuario_id, code_verifier, return_to, expira_em)
           values ($1, $2, $3, $4, $5, $6)`,
            [
              state,
              empresa.empresa_id,
              uid,
              code_verifier,
              return_to,
              expiraEm.toISOString(),
            ],
          );

          await client.query("commit");
        } catch (e) {
          await client.query("rollback");
          throw e;
        }
      });

      const url = new URL(AUTH_BASE);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("client_id", String(ML_APP_ID));
      url.searchParams.set("redirect_uri", String(redirectUri));
      url.searchParams.set("state", state);
      url.searchParams.set("code_challenge", code_challenge);
      url.searchParams.set("code_challenge_method", "S256");

      return res.json({
        ok: true,
        url: url.toString(),
        redirect_uri_in_use: redirectUri,
      });
    } catch (err) {
      if (isUserWithoutCompanyError(err)) {
        return res.status(403).json(userWithoutCompanyPayload());
      }

      if (isMissingMlSchemaError(err)) {
        return res.status(503).json(missingSchemaPayload());
      }

      console.error("POST /api/meli/oauth/start erro:", {
        message: err?.message || err,
        code: err?.code || null,
      });
      return res
        .status(500)
        .json({ ok: false, error: "Erro ao iniciar vinculação." });
    }
  },
);

// ===============================
// GET /api/meli/oauth/callback?code=...&state=...
// ===============================
router.get(
  "/oauth/callback",
  oauthRateLimiter,
  createAuditAction({
    evento: "meli_oauth_callback",
    metadata: (req) => ({
      oauth_state: String(req.query?.state || "").trim() || null,
      has_code: !!String(req.query?.code || "").trim(),
    }),
  }),
  async (req, res) => {
  const code = String(req.query?.code || "").trim();
  const state = String(req.query?.state || "").trim();

  if (!code || !state) {
    return res.status(400).send("Callback inválido: faltou code ou state.");
  }

  try {
    if (!ML_APP_ID || !ML_CLIENT_SECRET) {
      return res
        .status(500)
        .send("Config do Mercado Livre incompleta (APP_ID/SECRET).");
    }

    const redirectUri = resolveRedirectUri(req);
    if (!redirectUri) {
      return res
        .status(500)
        .send(
          "Não foi possível determinar a URL de callback do Mercado Livre.",
        );
    }

    const outcome = await db.withClient(async (client) => {
      await client.query("begin");
      try {
        const st = await client.query(
          `select state, empresa_id, usuario_id, code_verifier, return_to, expira_em
             from oauth_states
            where state = $1
            limit 1`,
          [state],
        );

        const row = st.rows[0];
        if (!row)
          throw new Error("state não encontrado (expirou ou já foi usado).");
        if (new Date(row.expira_em).getTime() < Date.now())
          throw new Error("state expirado.");

        const body = new URLSearchParams();
        body.set("grant_type", "authorization_code");
        body.set("client_id", String(ML_APP_ID));
        body.set("client_secret", String(ML_CLIENT_SECRET));
        body.set("code", code);
        body.set("redirect_uri", String(redirectUri));
        body.set("code_verifier", String(row.code_verifier));

        const resp = await doFetch(TOKEN_URL, {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/x-www-form-urlencoded",
          },
          body,
        });

        const data = await resp.json().catch(() => null);

        if (
          !resp.ok ||
          !data?.access_token ||
          !data?.refresh_token ||
          !data?.user_id
        ) {
          let msg =
            data?.error_description ||
            data?.message ||
            data?.error ||
            "Falha ao trocar code por token.";

          const lower = String(msg).toLowerCase();
          if (lower.includes("redirect") || lower.includes("callback")) {
            msg += ` Verifique ML_REDIRECT_URI e o callback cadastrado no app do Mercado Livre. URI usada agora: ${redirectUri}`;
          }

          throw new Error(msg);
        }

        const meli_user_id = Number(data.user_id);
        const access_token = String(data.access_token);
        const refresh_token = String(data.refresh_token);
        const access_token_db = encryptToken(access_token);
        const refresh_token_db = encryptToken(refresh_token);
        const scope = String(data.scope || "").trim() || null;

        const expiresInSec = Number(data.expires_in || 0);
        const access_expires_at = new Date(
          Date.now() + Math.max(60, expiresInSec) * 1000,
        );

        const anotherEmpresa = await client.query(
          `select mc.id, mc.empresa_id, e.nome as empresa_nome
             from meli_contas mc
             join empresas e on e.id = mc.empresa_id
            where mc.meli_user_id = $1
              and mc.empresa_id <> $2
            limit 1`,
          [meli_user_id, row.empresa_id],
        );

        if (anotherEmpresa.rows[0]) {
          const other = anotherEmpresa.rows[0];
          const err = new Error(
            `Essa conta do Mercado Livre já está vinculada à empresa ${other.empresa_nome} (#${other.empresa_id}) neste sistema.`,
          );
          err.statusCode = 409;
          err.code = "ML_ACCOUNT_ALREADY_LINKED";
          throw err;
        }

        const apelidoDefault = `Conta ${meli_user_id}`;
        let apelido = await tryGetMlNickname(access_token, meli_user_id);
        if (!apelido) apelido = apelidoDefault;

        let contaId = null;

        const existing = await client.query(
          `select id
             from meli_contas
            where empresa_id = $1 and meli_user_id = $2
            limit 1`,
          [row.empresa_id, meli_user_id],
        );

        if (existing.rows[0]) {
          contaId = existing.rows[0].id;

          await client.query(
            `update meli_contas
                set apelido = coalesce(nullif($2, ''), apelido),
                    status = 'ativa',
                    atualizado_em = now(),
                    ultimo_uso_em = now()
              where id = $1`,
            [contaId, apelido],
          );
        } else {
          // Existing accounts are preserved as legacy by the migration. This
          // branch only handles accounts created after the billing rollout.
          const linkedAccounts = await client.query(
            `select count(*)::int as total from meli_contas where empresa_id = $1`,
            [row.empresa_id],
          );
          const isFirstAccount = Number(linkedAccounts.rows[0]?.total || 0) === 0;
          const billingStatus = isFirstAccount
            ? "legacy_active"
            : "awaiting_subscription";
          const billingMode = isFirstAccount ? "legacy" : "paid";
          const usagePolicy = isFirstAccount ? "unlimited" : "metered";

          const ins = await client.query(
            `insert into meli_contas
              (empresa_id, meli_user_id, apelido, site_id, status, billing_status, billing_mode, usage_policy, range_enforcement)
             values ($1, $2, $3, 'MLB', 'ativa', $4, $5, $6, false)
             returning id`,
            [row.empresa_id, meli_user_id, apelido, billingStatus, billingMode, usagePolicy],
          );

          contaId = ins.rows[0].id;
        }

        await client.query(
          `insert into meli_tokens
            (meli_conta_id, access_token, access_expires_at, refresh_token, scope, refresh_obtido_em, ultimo_refresh_em)
           values ($1, $2, $3, $4, $5, now(), now())
           on conflict (meli_conta_id)
           do update set
              access_token = excluded.access_token,
              access_expires_at = excluded.access_expires_at,
              refresh_token = excluded.refresh_token,
              scope = excluded.scope,
              ultimo_refresh_em = now()`,
          [
            contaId,
            access_token_db,
            access_expires_at.toISOString(),
            refresh_token_db,
            scope,
          ],
        );

        await client.query(`delete from oauth_states where state = $1`, [
          state,
        ]);

        await client.query("commit");

        return {
          return_to: row.return_to || "/vincular-conta",
          empresaId: row.empresa_id,
          usuarioId: row.usuario_id,
          meli_user_id,
          contaId,
          redirectUri,
        };
      } catch (e) {
        await client.query("rollback");
        throw e;
      }
    });

    if (outcome?.contaId) {
      await setDefaultIfMissingForMembership(
        outcome.usuarioId,
        outcome.empresaId,
        outcome.contaId,
      ).catch(() => null);
      res.cookie(COOKIE_MELI_CONTA, String(outcome.contaId), cookieOptions());
    }

    const go = withBase(
      req,
      sanitizeReturnTo(outcome.return_to || "/vincular-conta"),
    );
    return res.redirect(go);
  } catch (err) {
    const explicitStatus = Number(err?.statusCode || 0);
    if (explicitStatus >= 400 && explicitStatus < 600) {
      return res
        .status(explicitStatus)
        .send(err?.message || "Erro ao vincular conta.");
    }

    const pgCode = String(err?.code || "");
    if (pgCode === "23505") {
      const constraint = String(err?.constraint || "");

      if (constraint.includes("ux_meli_contas_empresa_apelido")) {
        return res
          .status(409)
          .send("Já existe uma conta com esse apelido nesta empresa.");
      }

      if (constraint.includes("ux_meli_contas_empresa_meli_user")) {
        return res
          .status(409)
          .send("Essa conta do Mercado Livre já está vinculada nesta empresa.");
      }

      if (
        constraint.toLowerCase().includes("global") ||
        constraint.toLowerCase().includes("meli_user")
      ) {
        return res
          .status(409)
          .send(
            "Essa conta do Mercado Livre já está vinculada a outra empresa neste sistema.",
          );
      }

      return res
        .status(409)
        .send("Conflito ao salvar vinculação (registro duplicado).");
    }

    console.error("GET /api/meli/oauth/callback erro:", err?.message || err, {
      redirectUri: resolveRedirectUri(req),
      state,
    });
    return res
      .status(500)
      .send(`Erro ao vincular conta: ${err?.message || "erro desconhecido"}`);
  }
  },
);

// ===============================
// GET /api/meli/current
// - Usuário normal/admin: valida por empresa
// - Master: lê qualquer conta selecionada
// ===============================
router.get("/current", async (req, res) => {
  try {
    const uid = mustBeLogged(req);
    if (!uid) return res.status(401).json({ ok: false });

    const master = isMaster(req);

    const contaId = readCurrentContaId(req);
    if (!contaId || contaId <= 0) {
      return res.json({ ok: true, selected: false });
    }

    const pack = await db.withClient(async (client) => {
      if (master) {
        const c = await client.query(
          `select c.id, c.meli_user_id, c.apelido, c.site_id, c.status, c.empresa_id, e.nome as empresa_nome
             from meli_contas c
             join empresas e on e.id = c.empresa_id
            where c.id = $1
            limit 1`,
          [contaId],
        );
        return c.rows[0] || null;
      }

      const emp = await getEmpresaDoUsuario(client, uid);
      if (!emp) return null;

      const c = await client.query(
        `select id, meli_user_id, apelido, site_id, status
           from meli_contas
          where id = $1 and empresa_id = $2
          limit 1`,
        [contaId, emp.empresa_id],
      );
      return c.rows[0] || null;
    });

    if (!pack) return res.json({ ok: true, selected: false });

    return res.json({
      ok: true,
      selected: true,
      meli_conta_id: pack.id,
      meli_user_id: pack.meli_user_id,
      label: pack.apelido || `Conta ${pack.meli_user_id}`,
      site_id: pack.site_id || "MLB",
      status: pack.status || "ativa",
      ...(master
        ? {
            empresa_id: pack.empresa_id || null,
            empresa_nome: pack.empresa_nome || null,
          }
        : {}),
    });
  } catch (e) {
    return res
      .status(500)
      .json({ ok: false, error: "Erro ao ler conta atual" });
  }
});

module.exports = router;
