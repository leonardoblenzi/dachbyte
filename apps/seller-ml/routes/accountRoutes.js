// routes/accountRoutes.js
"use strict";

const express = require("express");
const db = require("../db/db");
const { createAuditAction } = require("../middleware/auditAction");
const { buildPlanCheckoutUrl, unlinkBillingResource } = require("../services/hubCreditsService");
const {
  buildAccountBillingPayload,
  recommendedRangeForOrders,
} = require("../services/accountBillingStatus");
const TokenService = require("../services/tokenService");
const { decryptToken } = require("../services/tokenCrypto");

const router = express.Router();

/**
 * Cookie OAuth (id da tabela meli_contas)
 * IMPORTANTE: tem que bater com middleware/ensureAccount.js
 */
const COOKIE_OAUTH = "meli_conta_id";
const UNLINKED_ACCOUNT_STATUSES = new Set(["desvinculada", "revogada", "unlinked", "revoked"]);

const BILLING_COLUMNS = `
  mc.billing_status,
  mc.billing_mode,
  mc.usage_policy,
  mc.range_enforcement,
  mc.plan_code,
  mc.order_range_code,
  mc.recommended_range_code,
  mc.last_closed_period_orders,
  mc.billing_grace_expires_at,
  mc.billing_review_due_at
`;

// ===============================
// Helpers: role
// ===============================
function normalizeNivel(n) {
  return String(n || "")
    .trim()
    .toLowerCase();
}
function isMaster(req) {
  return (
    normalizeNivel(req.user?.nivel) === "admin_master" ||
    req.user?.is_master === true ||
    req.user?.flags?.is_master === true
  );
}

function isAdminAny(req) {
  const nivel = normalizeNivel(req.user?.nivel);
  return isMaster(req) || nivel === "administrador";
}

function isUnlinkedAccountStatus(value) {
  return UNLINKED_ACCOUNT_STATUSES.has(String(value || "").trim().toLowerCase());
}

function buildViewerPayload(req) {
  const nivel = normalizeNivel(req.user?.nivel);
  const master = isMaster(req);

  return {
    id: req.user?.uid ?? null,
    nivel,
    is_master: master,
    is_admin: nivel === "administrador",
    is_admin_any: master || nivel === "administrador",
  };
}

/** Helper: pega empresa do usuário (MVP: 1 usuário -> 1 empresa) */
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
    [usuarioId]
  );
  return r.rows[0] || null;
}

function previousClosedMonthWindow(now = new Date()) {
  const startCurrent = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
  const startPrevious = new Date(Date.UTC(startCurrent.getUTCFullYear(), startCurrent.getUTCMonth() - 1, 1, 0, 0, 0, 0));
  return {
    from: startPrevious.toISOString(),
    to: startCurrent.toISOString(),
  };
}

async function fetchPaidOrdersTotal({ accessToken, sellerId, from, to }) {
  const url = new URL("https://api.mercadolibre.com/orders/search");
  url.searchParams.set("seller", String(sellerId));
  url.searchParams.set("order.status", "paid");
  url.searchParams.set("order.date_created.from", from);
  url.searchParams.set("order.date_created.to", to);
  url.searchParams.set("limit", "1");
  url.searchParams.set("offset", "0");

  const response = await fetch(url.toString(), {
    headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
  });
  if (!response.ok) throw new Error(`orders_search_${response.status}`);
  const body = await response.json().catch(() => ({}));
  const total = Number(body?.paging?.total ?? body?.total ?? 0);
  return Number.isFinite(total) ? total : 0;
}

async function refreshClosedMonthOrdersForCheckout(client, account) {
  if (!account?.id || !account?.meli_user_id) return account;
  const status = String(account.billing_status || account.status || "").toLowerCase();
  const policy = String(account.usage_policy || "").toLowerCase();
  if (policy === "unlimited" || status === "legacy_active" || status === "courtesy_unlimited") {
    return account;
  }

  try {
    const tokenRows = await client.query(
      `select access_token, access_expires_at, refresh_token, scope
         from meli_tokens
        where meli_conta_id = $1
        limit 1`,
      [account.id],
    );
    const tokenRow = tokenRows.rows[0] || null;
    if (!tokenRow?.access_token && !tokenRow?.refresh_token) return account;

    const creds = {
      meli_conta_id: account.id,
      account_key: String(account.id),
      meli_user_id: account.meli_user_id,
      access_token: tokenRow.access_token ? decryptToken(tokenRow.access_token) : null,
      refresh_token: tokenRow.refresh_token ? decryptToken(tokenRow.refresh_token) : null,
      access_expires_at: tokenRow.access_expires_at || null,
      scope: tokenRow.scope || null,
    };
    const accessToken = await TokenService.renovarTokenSeNecessario(creds);
    const period = previousClosedMonthWindow();
    const total = await fetchPaidOrdersTotal({
      accessToken,
      sellerId: account.meli_user_id,
      from: period.from,
      to: period.to,
    });
    const recommendedRange = recommendedRangeForOrders(total);
    await client.query(
      `update meli_contas
          set last_closed_period_orders = $2,
              recommended_range_code = $3,
              atualizado_em = now()
        where id = $1`,
      [account.id, total, recommendedRange],
    );
    return {
      ...account,
      last_closed_period_orders: total,
      recommended_range_code: recommendedRange,
    };
  } catch (error) {
    console.warn("[account-billing] last_closed_orders_refresh_failed", {
      meli_conta_id: account.id,
      message: error?.message || String(error),
    });
    return account;
  }
}

/** Cookie options */
function cookieOptions() {
  const isProd =
    String(process.env.NODE_ENV || "").toLowerCase() === "production";
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: isProd,
    maxAge: 30 * 24 * 3600 * 1000, // 30 dias
    path: "/",
  };
}

/** Normaliza "current" e devolve formato compatível com o front */
function buildCurrentPayload(cur, viewer = null) {
  if (!cur) {
    return {
      ok: true,
      success: true,
      current: null,
      accountType: null,
      accountKey: null,
      label: null,
      viewer,
    };
  }

  // OAuth-only
  const key = String(cur.id);
  const label =
    String(cur.label || "").trim() || `Conta ${cur.meli_user_id || key}`;

  return {
    ok: true,
    success: true,
    current: { ...cur, label },
    accountType: "oauth",
    accountKey: key,
    label,
    viewer,
  };
}

function normalizeAccountRow(c, { master = false, user = null } = {}) {
  if (!c) return null;
  const baseLabel = c.apelido || `Conta ${c.meli_user_id || c.id}`;
  const label =
    master && c.empresa_nome
      ? `${c.empresa_nome} - ${baseLabel}`
      : baseLabel;
  const renewalCheckoutUrl = buildPlanCheckoutUrl({
    account: {
      ...c,
      label,
    },
    customerEmail: user?.email || user?.email_usuario || user?.login || null,
    customerName: user?.nome || user?.name || null,
    userId: user?.user_global_id || user?.uid || user?.id || null,
    documentType: c.document_type || null,
    documentNumber: c.document_number || null,
  });
  const billing = buildAccountBillingPayload(c, { renewalCheckoutUrl });

  return {
    type: "oauth",
    id: c.id,
    label,
    empresa_id: c.empresa_id,
    empresa_nome: c.empresa_nome || null,
    meli_user_id: c.meli_user_id,
    status: c.status,
    site_id: c.site_id,
    has_tokens: !!c.has_tokens,
    is_default: c.is_default === true || c.is_default === "true",
    billing_status: billing.status,
    billing_mode: billing.billing_mode,
    usage_policy: billing.usage_policy,
    range_enforcement: billing.range_enforcement,
    plan_code: billing.plan_code,
    order_range_code: billing.order_range_code,
    recommended_range_code: billing.recommended_range_code,
    last_closed_period_orders: billing.last_closed_period_orders,
    billing_grace_expires_at: billing.grace_expires_at,
    billing_review_due_at: billing.review_due_at,
    renewal_checkout_url: billing.renewal_checkout_url,
    billing,
  };
}

// ===============================
// ✅ NOVO: GET /api/account/list
// ===============================
/**
 * GET /api/account/list
 * Lista contas disponíveis (OAuth only).
 * - Usuário comum: lista contas da sua empresa
 * - Master: lista global (com empresa no label) — útil para debug/admin
 *
 * Retorna formato compat com seu front:
 * { ok:true, success:true, oauth:[...], legacy:[], current, accountType, accountKey, label }
 */
router.get("/list", async (req, res) => {
  try {
    const uid = Number(req.user?.uid);
    if (!Number.isFinite(uid)) {
      return res.status(401).json({ ok: false, error: "Não autenticado." });
    }

    const master = isMaster(req);
    const includeUnlinked =
      String(req.query?.include_unlinked || req.query?.includeUnlinked || "").trim() === "1";

    const oauthId = req.cookies?.[COOKIE_OAUTH]
      ? Number(req.cookies[COOKIE_OAUTH])
      : null;
    const cookieHasValidId = Number.isFinite(oauthId) && oauthId > 0;

    const data = await db.withClient(async (client) => {
      if (master) {
        const whereUnlinked = includeUnlinked
          ? ""
          : "where lower(coalesce(mc.status, '')) not in ('desvinculada','revogada','unlinked','revoked')";
        const r = await client.query(
          `select mc.id,
                  mc.empresa_id,
                  e.nome as empresa_nome,
                  mc.apelido,
                  mc.meli_user_id,
                  mc.status,
                  mc.site_id,
                  ${BILLING_COLUMNS},
                  e.tenant_global_id,
                  e.document_type,
                  e.document_number,
                  false as is_default,
                  (mt.meli_conta_id is not null) as has_tokens
             from meli_contas mc
             join empresas e on e.id = mc.empresa_id
        left join meli_tokens mt on mt.meli_conta_id = mc.id
             ${whereUnlinked}
         order by e.nome asc, mc.id asc`
        );

        return { empresa: null, contas: r.rows || [] };
      }

      const emp = await getEmpresaDoUsuario(client, uid);
      if (!emp) return { empresa: null, contas: [] };

      const r = await client.query(
        `select mc.id,
                mc.empresa_id,
                $1::text as empresa_nome,
                mc.apelido,
                mc.meli_user_id,
                mc.status,
                mc.site_id,
                ${BILLING_COLUMNS},
                $4::text as tenant_global_id,
                $5::text as document_type,
                $6::text as document_number,
                (eu.default_meli_conta_id = mc.id) as is_default,
                (mt.meli_conta_id is not null) as has_tokens
           from meli_contas mc
      left join meli_tokens mt on mt.meli_conta_id = mc.id
      left join empresa_usuarios eu
             on eu.usuario_id = $3
            and eu.empresa_id = mc.empresa_id
          where mc.empresa_id = $2
            ${includeUnlinked ? "" : "and lower(coalesce(mc.status, '')) not in ('desvinculada','revogada','unlinked','revoked')"}
          order by (eu.default_meli_conta_id = mc.id) desc, mc.id asc`,
        [
          emp.empresa_nome || null,
          emp.empresa_id,
          uid,
          emp.tenant_global_id || null,
          emp.document_type || null,
          emp.document_number || null,
        ]
      );

      return { empresa: emp, contas: r.rows || [] };
    });

    const oauth = (data.contas || []).map((c) => {
      const baseLabel = c.apelido || `Conta ${c.meli_user_id || c.id}`;
      const label =
        master && c.empresa_nome
          ? `${c.empresa_nome} • ${baseLabel}`
          : baseLabel;

      const renewalCheckoutUrl = buildPlanCheckoutUrl({
        account: c,
        customerEmail: req.user?.email || req.user?.email_usuario || req.user?.login || null,
        customerName: req.user?.nome || req.user?.name || null,
        userId: data.empresa?.user_global_id || req.user?.uid || null,
        documentType: c.document_type || data.empresa?.document_type || null,
        documentNumber: c.document_number || data.empresa?.document_number || null,
      });
      const billing = buildAccountBillingPayload(c, { renewalCheckoutUrl });

      return {
        type: "oauth",
        id: c.id,
        label,
        apelido: c.apelido || null,
        empresa_id: c.empresa_id,
        empresa_nome: c.empresa_nome || null,
        meli_user_id: c.meli_user_id,
        status: c.status,
        site_id: c.site_id,
        has_tokens: !!c.has_tokens,
        is_default: c.is_default === true || c.is_default === "true",
        billing_status: billing.status,
        billing_mode: billing.billing_mode,
        usage_policy: billing.usage_policy,
        range_enforcement: billing.range_enforcement,
        plan_code: billing.plan_code,
        order_range_code: billing.order_range_code,
        recommended_range_code: billing.recommended_range_code,
        last_closed_period_orders: billing.last_closed_period_orders,
        billing_grace_expires_at: billing.grace_expires_at,
        billing_review_due_at: billing.review_due_at,
        renewal_checkout_url: renewalCheckoutUrl,
        billing,
      };
    });

    // valida current contra a lista (evita cookie apontando pra conta que não pode)
    let current = null;
    if (cookieHasValidId) {
      current = oauth.find((x) => Number(x.id) === Number(oauthId)) || null;
      if (!current) {
        res.clearCookie(COOKIE_OAUTH, { path: "/" });
      }
    }

    const payloadCurrent = buildCurrentPayload(current, buildViewerPayload(req));

    return res.json({
      ok: true,
      success: true,
      oauth,
      legacy: [], // (compat) você disse OAuth-only aqui
      ...payloadCurrent,
    });
  } catch (err) {
    console.error("GET /api/account/list erro:", err);
    return res.status(500).json({ ok: false, error: "Erro ao listar contas" });
  }
});

/**
 * GET /api/account/current
 * Retorna a conta atual selecionada (OAuth only).
 * - Para usuário comum: valida que a conta pertence à empresa do usuário
 * - Para master: pode ler qualquer conta selecionada
 */
router.get("/current", async (req, res) => {
  try {
    const uid = Number(req.user?.uid);
    if (!Number.isFinite(uid)) {
      return res.status(401).json({ ok: false, error: "Não autenticado." });
    }

    const master = isMaster(req);

    const oauthId = req.cookies?.[COOKIE_OAUTH]
      ? Number(req.cookies[COOKIE_OAUTH])
      : null;
    if (!Number.isFinite(oauthId) || oauthId <= 0) {
      return res.json(buildCurrentPayload(null, buildViewerPayload(req)));
    }

    const info = await db.withClient(async (client) => {
      if (master) {
        const r = await client.query(
          `select mc.id,
                  mc.empresa_id,
                  e.nome as empresa_nome,
                  mc.apelido,
                  mc.meli_user_id,
                  mc.status,
                  mc.site_id,
                  ${BILLING_COLUMNS},
                  e.tenant_global_id,
                  e.document_type,
                  e.document_number,
                  null::text as user_global_id
             from meli_contas mc
             join empresas e on e.id = mc.empresa_id
            where mc.id = $1
              and lower(coalesce(mc.status, '')) not in ('desvinculada','revogada','unlinked','revoked')
            limit 1`,
          [oauthId]
        );
        const account = r.rows[0] || null;
        return account ? await refreshClosedMonthOrdersForCheckout(client, account) : null;
      }

      const emp = await getEmpresaDoUsuario(client, uid);
      if (!emp) return null;

      const r = await client.query(
        `select mc.id,
                mc.empresa_id,
                $2::text as empresa_nome,
                mc.apelido,
                mc.meli_user_id,
                mc.status,
                mc.site_id,
                ${BILLING_COLUMNS},
                $4::text as tenant_global_id,
                $5::text as document_type,
                $6::text as document_number,
                $7::text as user_global_id,
                false as is_default
          from meli_contas mc
          where mc.id = $1 and mc.empresa_id = $3
            and lower(coalesce(mc.status, '')) not in ('desvinculada','revogada','unlinked','revoked')
          limit 1`,
        [
          oauthId,
          emp.empresa_nome || null,
          emp.empresa_id,
          emp.tenant_global_id || null,
          emp.document_type || null,
          emp.document_number || null,
          emp.user_global_id || null,
        ]
      );
      const account = r.rows[0] || null;
      return account ? await refreshClosedMonthOrdersForCheckout(client, account) : null;
    });

    if (!info) {
      // cookie inválido
      res.clearCookie(COOKIE_OAUTH, { path: "/" });
      return res.json(buildCurrentPayload(null, buildViewerPayload(req)));
    }

    const baseLabel = info.apelido || `Conta ${info.meli_user_id}`;

    // ✅ Master mostra empresa no label (ajuda muito)
    const label =
      master && info.empresa_nome
        ? `${info.empresa_nome} • ${baseLabel}`
        : baseLabel;

    const normalizedInfo = normalizeAccountRow(
      {
        ...info,
        label,
      },
      { master: false, user: { ...(req.user || {}), user_global_id: info.user_global_id || null } },
    );

    return res.json(
      buildCurrentPayload({
        ...normalizedInfo,
        type: "oauth",
        id: info.id,
        label,
        empresa_id: info.empresa_id,
        empresa_nome: info.empresa_nome,
        meli_user_id: info.meli_user_id,
        status: info.status,
        site_id: info.site_id,
      }, buildViewerPayload(req))
    );
  } catch (err) {
    console.error("GET /api/account/current erro:", err);
    return res
      .status(500)
      .json({ ok: false, error: "Erro ao obter conta atual" });
  }
});

/**
 * POST /api/account/clear
 * Limpa seleção (OAuth only)
 */
router.post(
  "/clear",
  createAuditAction({
    evento: "account_selection_cleared",
  }),
  (_req, res) => {
    res.clearCookie(COOKIE_OAUTH, { path: "/" });
    return res.json({ ok: true, success: true });
  },
);

/**
 * (Opcional) POST /api/account/select
 * Mantido só por compatibilidade: seta o cookie OAuth.
 * Você já tem /api/meli/selecionar — se quiser, pode remover este endpoint depois.
 */
router.post(
  "/select",
  createAuditAction({
    evento: "account_selected",
    metadata: (req) => ({
      meli_conta_id: Number(req.body?.meliContaId) || null,
    }),
  }),
  express.json({ limit: "100kb" }),
  async (req, res) => {
  try {
    const uid = Number(req.user?.uid);
    if (!Number.isFinite(uid)) {
      return res.status(401).json({ ok: false, error: "Não autenticado." });
    }

    const master = isMaster(req);
    const meliContaId = Number(req.body?.meliContaId);

    if (!Number.isFinite(meliContaId) || meliContaId <= 0) {
      return res
        .status(400)
        .json({ ok: false, error: "meliContaId inválido." });
    }

    const selected = await db.withClient(async (client) => {
      if (master) {
        const r = await client.query(
          `select mc.id, mc.apelido, mc.meli_user_id, mc.status, mc.site_id, mc.empresa_id, e.nome as empresa_nome
             from meli_contas mc
             join empresas e on e.id = mc.empresa_id
            where mc.id = $1
              and lower(coalesce(mc.status, '')) not in ('desvinculada','revogada','unlinked','revoked')
            limit 1`,
          [meliContaId]
        );
        return r.rows[0] || null;
      }

      const emp = await getEmpresaDoUsuario(client, uid);
      if (!emp) return null;

      const r = await client.query(
        `select mc.id, mc.apelido, mc.meli_user_id, mc.status, mc.site_id, mc.empresa_id, $2::text as empresa_nome
           from meli_contas mc
          where mc.id = $1 and mc.empresa_id = $3
            and lower(coalesce(mc.status, '')) not in ('desvinculada','revogada','unlinked','revoked')
          limit 1`,
        [meliContaId, emp.empresa_nome || null, emp.empresa_id]
      );
      return r.rows[0] || null;
    });

    if (!selected) {
      return res
        .status(404)
        .json({ ok: false, error: "Conta não encontrada (ou não permitida)." });
    }

    res.cookie(COOKIE_OAUTH, String(selected.id), cookieOptions());

    const baseLabel = selected.apelido || `Conta ${selected.meli_user_id}`;
    const label =
      master && selected.empresa_nome
        ? `${selected.empresa_nome} • ${baseLabel}`
        : baseLabel;

    return res.json(
      buildCurrentPayload({
        type: "oauth",
        id: selected.id,
        label,
        empresa_id: selected.empresa_id,
        empresa_nome: selected.empresa_nome,
        meli_user_id: selected.meli_user_id,
        status: selected.status,
        site_id: selected.site_id,
      }, buildViewerPayload(req))
    );
  } catch (err) {
    console.error("POST /api/account/select erro:", err);
    return res
      .status(500)
      .json({ ok: false, error: "Erro ao selecionar conta" });
  }
  },
);

router.post(
  "/:id/unlink",
  createAuditAction({
    evento: "meli_account_unlinked",
    metadata: (req) => ({
      meli_conta_id: Number(req.params?.id) || null,
      reason: String(req.body?.reason || "").trim() || null,
    }),
  }),
  async (req, res) => {
    try {
      const uid = Number(req.user?.uid);
      if (!Number.isFinite(uid)) {
        return res.status(401).json({ ok: false, error: "Nao autenticado." });
      }
      if (!isAdminAny(req)) {
        return res.status(403).json({
          ok: false,
          error: "Somente administradores da empresa podem desvincular contas.",
        });
      }

      const accountId = Number(req.params?.id);
      if (!Number.isFinite(accountId) || accountId <= 0) {
        return res.status(400).json({ ok: false, error: "meli_conta_id invalido." });
      }

      const reason =
        String(req.body?.reason || "").trim() ||
        "Conta ML desvinculada pelo administrador da empresa.";
      const master = isMaster(req);

      const result = await db.withClient(async (client) => {
        await client.query("begin");
        try {
          let account = null;
          if (master) {
            const r = await client.query(
              `select mc.id,
                      mc.empresa_id,
                      e.nome as empresa_nome,
                      e.tenant_global_id,
                      mc.meli_user_id,
                      mc.apelido,
                      mc.site_id,
                      mc.status,
                      ${BILLING_COLUMNS}
                 from meli_contas mc
                 join empresas e on e.id = mc.empresa_id
                where mc.id = $1
                limit 1`,
              [accountId],
            );
            account = r.rows[0] || null;
          } else {
            const emp = await getEmpresaDoUsuario(client, uid);
            if (!emp) {
              await client.query("rollback");
              return { notFound: true };
            }
            const r = await client.query(
              `select mc.id,
                      mc.empresa_id,
                      $2::text as empresa_nome,
                      $3::text as tenant_global_id,
                      mc.meli_user_id,
                      mc.apelido,
                      mc.site_id,
                      mc.status,
                      ${BILLING_COLUMNS}
                 from meli_contas mc
                where mc.id = $1
                  and mc.empresa_id = $4
                limit 1`,
              [accountId, emp.empresa_nome || null, emp.tenant_global_id || null, emp.empresa_id],
            );
            account = r.rows[0] || null;
          }

          if (!account) {
            await client.query("rollback");
            return { notFound: true };
          }
          if (isUnlinkedAccountStatus(account.status)) {
            await client.query("rollback");
            return { alreadyUnlinked: true, account };
          }

          await client.query(
            `update meli_contas
                set status = 'desvinculada',
                    billing_status = 'awaiting_subscription',
                    billing_mode = 'paid',
                    usage_policy = 'metered',
                    range_enforcement = true,
                    billing_review_due_at = now(),
                    atualizado_em = now()
              where id = $1`,
            [accountId],
          );

          const deletedTokens = await client.query(
            `delete from meli_tokens where meli_conta_id = $1`,
            [accountId],
          );

          const replacementRows = await client.query(
            `select mc.id
               from meli_contas mc
          left join meli_tokens mt on mt.meli_conta_id = mc.id
              where mc.empresa_id = $1
                and mc.id <> $2
                and lower(coalesce(mc.status, '')) not in ('desvinculada','revogada','unlinked','revoked')
              order by (mt.meli_conta_id is not null) desc, mc.ultimo_uso_em desc nulls last, mc.criado_em asc, mc.id asc
              limit 1`,
            [account.empresa_id, accountId],
          );
          const replacementId = replacementRows.rows[0]?.id || null;

          const defaultUpdate = await client.query(
            `update empresa_usuarios
                set default_meli_conta_id = $3
              where empresa_id = $1
                and default_meli_conta_id = $2`,
            [account.empresa_id, accountId, replacementId],
          );

          await client.query("commit");
          return {
            account,
            replacement_meli_conta_id: replacementId,
            removed_tokens: Number(deletedTokens.rowCount || 0),
            updated_default_users: Number(defaultUpdate.rowCount || 0),
          };
        } catch (error) {
          await client.query("rollback");
          throw error;
        }
      });

      if (result?.notFound) {
        return res.status(404).json({ ok: false, error: "Conta nao encontrada para sua empresa." });
      }
      if (result?.alreadyUnlinked) {
        return res.json({ ok: true, already_unlinked: true, account: result.account });
      }

      let hubSync = { ok: false, skipped: true };
      try {
        hubSync = await unlinkBillingResource({
          account: {
            ...result.account,
            label: result.account.apelido || `Conta ${result.account.meli_user_id || result.account.id}`,
            tenant_id: result.account.tenant_global_id,
            tenant_global_id: result.account.tenant_global_id,
            meli_conta_id: result.account.id,
          },
          reason,
          actor: `ml_user:${uid}`,
        });
      } catch (error) {
        console.warn("[account-unlink] hub_sync_failed", {
          accountId,
          message: error?.message || String(error),
          code: error?.code || null,
        });
        hubSync = {
          ok: false,
          error: error?.code || error?.message || "hub_sync_failed",
        };
      }

      const currentCookie = Number(req.cookies?.[COOKIE_OAUTH] || 0);
      if (Number(currentCookie) === accountId) {
        res.clearCookie(COOKIE_OAUTH, { path: "/" });
        res.clearCookie(COOKIE_OAUTH, { path: "/ml" });
        if (result.replacement_meli_conta_id) {
          res.cookie(COOKIE_OAUTH, String(result.replacement_meli_conta_id), cookieOptions());
        }
      }

      return res.json({
        ok: true,
        account: {
          id: result.account.id,
          empresa_id: result.account.empresa_id,
          meli_user_id: result.account.meli_user_id,
          apelido: result.account.apelido,
          status: "desvinculada",
        },
        replacement_meli_conta_id: result.replacement_meli_conta_id,
        removed_tokens: result.removed_tokens,
        updated_default_users: result.updated_default_users,
        hub_sync: hubSync,
      });
    } catch (err) {
      console.error("POST /api/account/:id/unlink erro:", err);
      return res.status(500).json({ ok: false, error: "Erro ao desvincular conta ML." });
    }
  },
);

module.exports = router;
