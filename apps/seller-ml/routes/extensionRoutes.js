"use strict";

const crypto = require("crypto");
const express = require("express");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const db = require("../db/db");
const ClonarAnuncioService = require("../services/clonarAnuncioService");
const ExtensionRealtimeInsightsService = require("../services/extensionRealtimeInsightsService");
const KeywordCurationService = require("../services/keywordCurationService");
const TokenService = require("../services/tokenService");
const { evaluateHubLoginAccess } = require("../services/hubAccessService");
const {
  decryptToken,
  isEncryptedToken,
  encryptToken,
  canEncryptTokens,
} = require("../services/tokenCrypto");

const router = express.Router();
const JWT_SECRET = process.env.ML_JWT_SECRET || process.env.JWT_SECRET;

if (!JWT_SECRET) {
  throw new Error("JWT_SECRET nao definido para rotas da extensao.");
}

function normalizeNivel(n) {
  return String(n || "").trim().toLowerCase();
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeHubConfigValue(raw) {
  const value = String(raw ?? "").trim();
  if (!value) return "";
  if (["0", "false", "null", "undefined", "off", "none", "disabled", "(not set)"].includes(value.toLowerCase())) {
    return "";
  }
  return value;
}

function createTemporaryPassword() {
  return crypto.randomBytes(24).toString("base64url");
}

function signExtensionToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: "12h" });
}

function hubPayload(hubLogin) {
  return hubLogin?.payload || {};
}

function hubFallbackName(payload, email, fallback) {
  return String(payload?.name || payload?.full_name || fallback || email || "Usuario Davantti").trim();
}

function normalizeHubCompanyRole(role) {
  const normalized = String(role || "member").trim().toLowerCase();
  if (["owner", "proprietario", "proprietário"].includes(normalized)) return "owner";
  if (["admin", "administrador"].includes(normalized)) return "admin";
  return "operador";
}

async function verifyHubGlobalLogin({ email, password, module }) {
  const hubBaseUrl = normalizeHubConfigValue(process.env.HUB_BASE_URL).replace(/\/+$/, "");
  const hubToken = normalizeHubConfigValue(process.env.HUB_INTERNAL_TOKEN);
  if (!hubBaseUrl || !hubToken) {
    return { allow: false, reason: "hub_not_configured" };
  }

  try {
    const response = await fetch(`${hubBaseUrl}/v1/internal/auth/verify`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${hubToken}`,
      },
      body: JSON.stringify({ email, password, module }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      return {
        allow: false,
        reason: payload?.reason || payload?.error || `hub_auth_${response.status}`,
      };
    }
    return payload?.allow
      ? { allow: true, payload }
      : { allow: false, reason: payload?.reason || "hub_denied" };
  } catch (error) {
    return { allow: false, reason: error?.message || "hub_unreachable" };
  }
}

async function provisionMlUserFromHubLogin(client, { email, hubLogin }) {
  const payload = hubPayload(hubLogin);
  const tenantGlobalId = String(payload?.tenant_id || "").trim();
  const userGlobalId = String(payload?.user_id || "").trim();
  if (!tenantGlobalId || !userGlobalId) return null;

  const companyName = String(payload?.company_name || "Empresa Davantti").trim() || "Empresa Davantti";
  const userName = hubFallbackName(payload, email, null);
  let role = normalizeHubCompanyRole(payload?.role);
  const passwordHash = await bcrypt.hash(createTemporaryPassword(), 10);

  await client.query("begin");
  try {
    let company = (await client.query(
      "select id, nome, tenant_global_id from empresas where tenant_global_id = $1 limit 1",
      [tenantGlobalId],
    )).rows[0] || null;

    if (!company) {
      company = (await client.query(
        "insert into empresas (nome, tenant_global_id) values ($1, $2) returning id, nome, tenant_global_id",
        [companyName, tenantGlobalId],
      )).rows[0] || null;
    }

    let user = (await client.query(
      "select id, nome, email, senha_hash, nivel, status, user_global_id from usuarios where email = $1 limit 1",
      [email],
    )).rows[0] || null;

    if (!user) {
      user = (await client.query(
        "insert into usuarios (nome, email, senha_hash, nivel, status, user_global_id) values ($1, $2, $3, 'usuario', 'ativo', $4) returning id, nome, email, senha_hash, nivel, status, user_global_id",
        [userName, email, passwordHash, userGlobalId],
      )).rows[0] || null;
    } else {
      await client.query(
        "update usuarios set user_global_id = $2 where id = $1",
        [user.id, userGlobalId],
      );
      user = { ...user, user_global_id: userGlobalId };
    }

    if (role !== "owner" && ["administrador", "admin_master"].includes(normalizeNivel(user?.nivel))) {
      role = "admin";
    }

    if (company && user) {
      await client.query(
        "insert into empresa_usuarios (empresa_id, usuario_id, papel) values ($1, $2, $3) on conflict (empresa_id, usuario_id) do update set papel = excluded.papel",
        [company.id, user.id, role],
      );
    }

    await client.query("commit");
    return { user, company, role };
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  }
}

function getUserId(req) {
  const raw = req.user?.uid ?? req.user?.id ?? req.user?.user_id ?? null;
  const id = Number(raw);
  return Number.isFinite(id) ? id : null;
}

function isAdminNivel(nivel) {
  return normalizeNivel(nivel) === "administrador";
}

function isMasterNivel(nivel) {
  return normalizeNivel(nivel) === "admin_master";
}

function isMaster(req) {
  const nivel = normalizeNivel(req.user?.nivel);
  const role = normalizeNivel(req.user?.role);
  return isMasterNivel(nivel) || isMasterNivel(role);
}

function readBearerToken(req) {
  const header = String(req.headers?.authorization || "").trim();
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1].trim() : "";
}

function requireExtensionAuth(req, res, next) {
  try {
    const token = readBearerToken(req);
    if (!token) {
      return res.status(401).json({ ok: false, error: "Token da extensao ausente." });
    }

    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    return next();
  } catch {
    return res.status(401).json({
      ok: false,
      error: "Sessao da extensao invalida ou expirada. Faca login novamente.",
    });
  }
}

async function withClient(fn) {
  if (typeof db.withClient === "function") return db.withClient(fn);
  if (typeof db.connect === "function") {
    const client = await db.connect();
    try {
      return await fn(client);
    } finally {
      client.release?.();
    }
  }
  throw new Error("Cliente de banco indisponivel.");
}

async function getEmpresaDoUsuario(client, usuarioId) {
  const result = await client.query(
    `select eu.empresa_id,
            eu.papel,
            e.nome as empresa_nome,
            e.nome as company_name,
            e.tenant_global_id,
            e.document_type,
            e.document_number
       from empresa_usuarios eu
       join empresas e on e.id = eu.empresa_id
      where eu.usuario_id = $1
      order by case eu.papel when 'owner' then 1 when 'admin' then 2 else 3 end
      limit 1`,
    [usuarioId],
  );
  return result.rows[0] || null;
}

function hydrateTokens(tokens) {
  if (!tokens) return null;
  return {
    ...tokens,
    access_token: tokens.access_token ? decryptToken(tokens.access_token) : null,
    refresh_token: tokens.refresh_token ? decryptToken(tokens.refresh_token) : null,
  };
}

async function maybeUpgradeStoredTokens(client, contaId, tokens) {
  if (!tokens || !contaId || !canEncryptTokens()) return;

  const hasPlainAccess = tokens.access_token && !isEncryptedToken(tokens.access_token);
  const hasPlainRefresh = tokens.refresh_token && !isEncryptedToken(tokens.refresh_token);
  if (!hasPlainAccess && !hasPlainRefresh) return;

  await client.query(
    `update meli_tokens
        set access_token = $2,
            refresh_token = $3
      where meli_conta_id = $1`,
    [
      contaId,
      tokens.access_token ? encryptToken(decryptToken(tokens.access_token)) : null,
      tokens.refresh_token ? encryptToken(decryptToken(tokens.refresh_token)) : null,
    ],
  );
}

function buildAccountLabel({ account, master }) {
  const baseLabel = account.apelido || `Conta ${account.meli_user_id || account.id}`;
  return master && account.empresa_nome ? `${account.empresa_nome} • ${baseLabel}` : baseLabel;
}

async function listAccountsForUser(req) {
  const uid = getUserId(req);
  if (!uid) return [];

  return withClient(async (client) => {
    if (isMaster(req)) {
      const result = await client.query(
        `select mc.id,
                mc.empresa_id,
                e.nome as empresa_nome,
                mc.apelido,
                mc.meli_user_id,
                mc.status,
                mc.site_id,
                (mt.meli_conta_id is not null) as has_tokens
           from meli_contas mc
           join empresas e on e.id = mc.empresa_id
      left join meli_tokens mt on mt.meli_conta_id = mc.id
       order by e.nome asc, mc.id asc`,
      );
      return result.rows || [];
    }

    const result = await client.query(
      `select mc.id,
              mc.empresa_id,
              e.nome as empresa_nome,
              mc.apelido,
              mc.meli_user_id,
              mc.status,
              mc.site_id,
              (mt.meli_conta_id is not null) as has_tokens
         from meli_contas mc
         join empresas e on e.id = mc.empresa_id
         join empresa_usuarios eu on eu.empresa_id = mc.empresa_id
    left join meli_tokens mt on mt.meli_conta_id = mc.id
        where eu.usuario_id = $1
        order by e.nome asc,
                 case eu.papel when 'owner' then 1 when 'admin' then 2 else 3 end,
                 mc.id asc`,
      [uid],
    );
    return result.rows || [];
  });
}

async function resolveAccountForUser(req, meliContaId) {
  const uid = getUserId(req);
  const accountId = Number(meliContaId);
  if (!uid || !Number.isFinite(accountId) || accountId <= 0) return null;

  return withClient(async (client) => {
    let account = null;
    let empresaId = null;
    let empresaNome = null;

    if (isMaster(req)) {
      const accountResult = await client.query(
        `select mc.id,
                mc.empresa_id,
                e.nome as empresa_nome,
                mc.meli_user_id,
                mc.apelido,
                mc.site_id,
                mc.status
           from meli_contas mc
           join empresas e on e.id = mc.empresa_id
          where mc.id = $1
          limit 1`,
        [accountId],
      );
      account = accountResult.rows[0] || null;
      empresaId = account?.empresa_id || null;
      empresaNome = account?.empresa_nome || null;
    } else {
      const accountResult = await client.query(
        `select mc.id,
                mc.empresa_id,
                e.nome as empresa_nome,
                mc.meli_user_id,
                mc.apelido,
                mc.site_id,
                mc.status
           from meli_contas mc
           join empresas e on e.id = mc.empresa_id
           join empresa_usuarios eu on eu.empresa_id = mc.empresa_id
          where mc.id = $1
            and eu.usuario_id = $2
          limit 1`,
        [accountId, uid],
      );
      account = accountResult.rows[0] || null;
      empresaId = account?.empresa_id || null;
      empresaNome = account?.empresa_nome || null;
    }

    if (!account) return null;

    const tokenResult = await client.query(
      `select access_token,
              access_expires_at,
              refresh_token,
              scope,
              refresh_obtido_em,
              ultimo_refresh_em
         from meli_tokens
        where meli_conta_id = $1
        limit 1`,
      [account.id],
    );

    const rawTokens = tokenResult.rows[0] || null;
    await maybeUpgradeStoredTokens(client, account.id, rawTokens);
    const tokens = hydrateTokens(rawTokens);

    return {
      account,
      empresaId,
      empresaNome,
      tokens,
    };
  });
}

function buildMlCreds(pack) {
  return {
    app_id: process.env.ML_APP_ID || process.env.APP_ID || process.env.CLIENT_ID || null,
    client_secret: process.env.ML_CLIENT_SECRET || process.env.CLIENT_SECRET || null,
    redirect_uri: process.env.ML_REDIRECT_URI || process.env.REDIRECT_URI || null,
    account_key: String(pack.account.id),
    meli_conta_id: pack.account.id,
    meli_user_id: pack.account.meli_user_id,
    site_id: pack.account.site_id || "MLB",
    status: pack.account.status,
    access_token: pack.tokens?.access_token || null,
    refresh_token: pack.tokens?.refresh_token || null,
    access_expires_at: pack.tokens?.access_expires_at || null,
    scope: pack.tokens?.scope || null,
  };
}

async function resolveReadableAccountForUser(req, preferredContaId = 0) {
  const preferredId = Number(preferredContaId || 0);
  if (Number.isFinite(preferredId) && preferredId > 0) {
    const preferred = await resolveAccountForUser(req, preferredId);
    if (preferred?.tokens?.access_token) return preferred;
  }

  const accounts = await listAccountsForUser(req);
  const fallback = accounts.find((account) => {
    if (!account?.has_tokens) return false;
    const status = String(account.status || "").toLowerCase();
    return !status || ["ativo", "active", "connected"].includes(status);
  }) || accounts.find((account) => account?.has_tokens);

  return fallback?.id ? resolveAccountForUser(req, fallback.id) : null;
}

router.use(express.json({ limit: "10mb" }));

router.post("/auth/login", async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.senha || req.body?.password || "");
    const moduleName = String(
      process.env.EXTENSION_HUB_AUTH_MODULE ||
        process.env.ML_EXTENSION_HUB_AUTH_MODULE ||
        "ml",
    ).trim().toLowerCase() || "ml";

    if (!email || !password) {
      return res.status(400).json({ ok: false, error: "Informe email e senha." });
    }

    const hubLogin = await verifyHubGlobalLogin({ email, password, module: moduleName });
    const authContext = await withClient(async (client) => {
      const userResult = await client.query(
        `select id, nome, email, senha_hash, nivel, status, user_global_id
           from usuarios
          where email = $1
          limit 1`,
        [email],
      );

      let user = userResult.rows[0] || null;
      let provisioned = null;

      if (!user && hubLogin.allow) {
        provisioned = await provisionMlUserFromHubLogin(client, { email, hubLogin });
        user = provisioned?.user || null;
      } else if (user && hubLogin.allow) {
        provisioned = await provisionMlUserFromHubLogin(client, { email, hubLogin });
        if (provisioned?.user) {
          user = { ...user, ...provisioned.user };
        }
      }

      if (!user) {
        return { user: null, passwordOk: false, company: null, role: "member" };
      }

      let passwordOk = Boolean(hubLogin.allow);
      if (!passwordOk) {
        passwordOk = await bcrypt.compare(password, String(user.senha_hash || ""));
      }

      const preferredTenantGlobalId = hubLogin.allow
        ? String(hubPayload(hubLogin)?.tenant_id || "").trim()
        : "";

      const companyFromProvision = provisioned?.company
        ? {
            empresa_id: provisioned.company.id,
            company_name: provisioned.company.nome,
            tenant_global_id: provisioned.company.tenant_global_id || null,
            document_type: null,
            document_number: null,
          }
        : null;

      const company = companyFromProvision || await getEmpresaDoUsuario(client, user.id);
      const nivelUser = normalizeNivel(user.nivel || "usuario");
      const role = isMasterNivel(nivelUser) ||
        isAdminNivel(nivelUser) ||
        provisioned?.role === "owner" ||
        provisioned?.role === "admin"
        ? "admin"
        : "member";

      return {
        user,
        passwordOk,
        company: company || null,
        role,
      };
    });

    if (!authContext?.user) {
      return res.status(401).json({
        ok: false,
        error: "Credenciais invalidas.",
        reason: hubLogin.reason || "user_not_found",
      });
    }

    if (!authContext.passwordOk) {
      return res.status(401).json({
        ok: false,
        error: "Credenciais invalidas.",
        reason: hubLogin.reason || "bad_password",
      });
    }

    const status = normalizeNivel(authContext.user.status || "ativo");
    if (status === "pendente_ativacao") {
      return res.status(403).json({
        ok: false,
        error: "Sua conta ainda nao foi ativada. Use o link de convite enviado para definir sua senha.",
        reason: "pending_activation",
      });
    }

    if (status === "inativo") {
      return res.status(403).json({
        ok: false,
        error: "Sua conta esta inativa. Fale com o administrador do workspace.",
        reason: "inactive",
      });
    }

    const nivel = normalizeNivel(authContext.user.nivel || "usuario");
    const masterUser = isMasterNivel(nivel);
    const hubAccess = await evaluateHubLoginAccess({
      user: {
        id: authContext.user.id,
        name: authContext.user.nome || null,
        email: authContext.user.email,
        user_global_id: authContext.user.user_global_id || null,
        nivel,
      },
      company: authContext.company,
      role: authContext.role,
      isMaster: masterUser,
    });

    if (!hubAccess.allow) {
      return res.status(403).json({
        ok: false,
        error: hubAccess.message || "Acesso bloqueado pela politica de assinatura.",
        reason: hubAccess.reason || "hub_denied",
      });
    }

    await db.query("update usuarios set ultimo_login_em = now() where id = $1", [
      authContext.user.id,
    ]).catch(() => {});

    const token = signExtensionToken({
      uid: authContext.user.id,
      email: authContext.user.email,
      nivel,
      nome: authContext.user.nome || null,
      user_global_id: authContext.user.user_global_id || null,
    });

    return res.json({
      ok: true,
      user: {
        id: authContext.user.id,
        nome: authContext.user.nome,
        email: authContext.user.email,
        nivel,
      },
      extension_token: token,
      token_type: "Bearer",
      expires_in: 12 * 60 * 60,
      source: hubLogin.allow ? "hub" : "local",
    });
  } catch (error) {
    console.error("[ExtensionRoutes] POST /auth/login erro:", error);
    return res.status(500).json({
      ok: false,
      error: "Erro interno ao validar login no Hub.",
    });
  }
});

router.use(requireExtensionAuth);

router.get("/me", async (req, res) => {
  const accounts = await listAccountsForUser(req);
  return res.json({
    ok: true,
    user: {
      id: getUserId(req),
      email: req.user?.email || null,
      nome: req.user?.nome || null,
      nivel: normalizeNivel(req.user?.nivel),
    },
    accounts: accounts.map((account) => ({
      id: account.id,
      label: buildAccountLabel({ account, master: isMaster(req) }),
      empresa_id: account.empresa_id,
      empresa_nome: account.empresa_nome || null,
      meli_user_id: account.meli_user_id,
      status: account.status,
      site_id: account.site_id || "MLB",
      has_tokens: Boolean(account.has_tokens),
    })),
  });
});

router.get("/accounts", async (req, res) => {
  const accounts = await listAccountsForUser(req);
  return res.json({
    ok: true,
    accounts: accounts.map((account) => ({
      id: account.id,
      label: buildAccountLabel({ account, master: isMaster(req) }),
      empresa_id: account.empresa_id,
      empresa_nome: account.empresa_nome || null,
      meli_user_id: account.meli_user_id,
      status: account.status,
      site_id: account.site_id || "MLB",
      has_tokens: Boolean(account.has_tokens),
    })),
  });
});

router.post("/insights/realtime", async (req, res) => {
  try {
    const marketplace = String(req.body?.marketplace || "").trim().toLowerCase();
    const pageType = String(req.body?.page_type || req.body?.pageType || "").trim().toLowerCase();
    const url = String(req.body?.url || "").trim();
    const query = String(req.body?.query || "").trim();
    const title = String(req.body?.title || "").trim();
    const itemId = String(req.body?.item_id || req.body?.itemId || "").trim().toUpperCase();
    const productId = String(req.body?.product_id || req.body?.productId || "").trim().toUpperCase();
    const pageSignals = req.body?.page_signals && typeof req.body.page_signals === "object" ? req.body.page_signals : {};
    const networkEntries = Array.isArray(req.body?.network_entries) ? req.body.network_entries : [];
    const accountId = Number(req.body?.account_id || req.body?.meli_conta_id || 0);
    const generateKeywords = Boolean(req.body?.generate_keywords || req.body?.generateKeywords);

    if (!url) {
      return res.status(400).json({ ok: false, error: "URL obrigatoria para gerar insights." });
    }

    let mlCreds = null;
    const pack = await resolveReadableAccountForUser(req, accountId);
    if (pack) {
      mlCreds = buildMlCreds(pack);
      try {
        const refreshedToken = await TokenService.renovarTokenSeNecessario(mlCreds);
        if (refreshedToken) mlCreds.access_token = refreshedToken;
      } catch {
        if (!mlCreds.access_token) mlCreds = null;
      }
    }

    const realtime = await ExtensionRealtimeInsightsService.buildRealtimeInsights({
      marketplace,
      pageType,
      url,
      itemId,
      productId,
      pageSignals,
      networkEntries,
      query,
      title,
      mlCreds,
      generateKeywords,
    });

    return res.json({
      ok: true,
      realtime: realtime || null,
      fetched_at: new Date().toISOString(),
      marketplace: marketplace || null,
      page_type: pageType || null,
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error?.message || "Falha ao gerar insights em tempo real.",
    });
  }
});

router.post("/keywords/refine", async (req, res) => {
  try {
    const title = String(req.body?.title || "").trim().slice(0, 240);
    const category = String(req.body?.category || req.body?.category_name || "").trim().slice(0, 160);
    const candidates = Array.isArray(req.body?.candidates)
      ? req.body.candidates
      : Array.isArray(req.body?.keywords)
        ? req.body.keywords
        : [];

    if (!candidates.length) {
      return res.status(400).json({ ok: false, error: "Envie palavras candidatas para refinar." });
    }

    const refinement = await KeywordCurationService.refineKeywords({
      title,
      category,
      candidates,
    });

    return res.json({
      ok: true,
      refinement,
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error?.message || "Falha ao refinar palavras chave.",
    });
  }
});

router.post("/clonar-anuncio/browser-capture", async (req, res) => {
  try {
    const accountId = Number(req.body?.account_id || req.body?.meli_conta_id);
    const source = String(req.body?.url || req.body?.source || "").trim();
    const html = String(req.body?.html || "");

    if (!Number.isFinite(accountId) || accountId <= 0) {
      return res.status(400).json({ ok: false, error: "Selecione uma conta Mercado Livre." });
    }

    if (!source || !/mercadolivre\.com\.br/i.test(source)) {
      return res.status(400).json({ ok: false, error: "Abra um anuncio do Mercado Livre para clonar." });
    }

    if (!html.trim()) {
      return res.status(400).json({ ok: false, error: "Nao foi possivel capturar o HTML do anuncio." });
    }

    const pack = await resolveAccountForUser(req, accountId);
    if (!pack) {
      return res.status(403).json({ ok: false, error: "Conta nao encontrada ou nao permitida para este usuario." });
    }

    const mlCreds = buildMlCreds(pack);
    const draft = await ClonarAnuncioService.createDraftFromBrowserCapture({
      source,
      html,
      mlCreds,
      accountKey: String(pack.account.id),
      userId: getUserId(req),
    });

    return res.status(201).json({
      ok: true,
      message: "Rascunho criado na Davantti.",
      draft: {
        id: draft.id,
        status: draft.status,
        source_item_id: draft.source_item_id,
        source_title: draft.source_title,
        source_url: draft.source_url,
        created_at: draft.created_at,
      },
    });
  } catch (error) {
    const status = Number(error?.status || error?.statusCode) || 500;
    return res.status(status).json({
      ok: false,
      error: error?.message || "Falha ao criar rascunho pela extensao.",
    });
  }
});

module.exports = router;
