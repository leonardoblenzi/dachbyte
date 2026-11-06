"use strict";

// Ranking de anuncios (SKUs) do Magalu, com as mesmas regras do ranking do Mercado Livre.
// Ao vivo: pedidos ja replicados no banco. Meses fechados: usa a foto mensal quando
// o historico esta ligado e a foto cobre o Top pedido (mesmo criterio do ML).

const accountRepository = require("../repositories/accountRepository");
const uxAnalyticsRepository = require("../repositories/uxAnalyticsRepository");
const rankingRepository = require("../repositories/rankingRepository");
const rankingSnapshotService = require("../services/rankingSnapshotService");
const userAccess = require("../services/userAccessService");
const { checkAccountAccess } = require("../services/hubResourceAccessService");
const rules = require("../services/rankingRules");

const CACHE_TTL_SEC = 300;
const cache = new Map();
const MODE_LABELS = { 30: "Leve (30)", 50: "Balanceado (50)", 100: "Detalhado (100)" };

function accountId(value) { const id = Number.parseInt(String(value == null ? "" : value), 10); return Number.isFinite(id) && id > 0 ? id : null; }

async function authorizedAccount(req) {
  const id = accountId(req.query?.account_id || req.body?.account_id);
  if (!id) throw rules.badRequest("Selecione uma conta Magalu.", "MAGALU_ACCOUNT_ID_REQUIRED");
  const identity = req.magaluIdentity;
  const account = await accountRepository.findAccountByIdForTenant(id, identity.dachTenantId);
  if (!account) throw Object.assign(new Error("Conta Magalu não encontrada."), { status: 404, code: "MAGALU_ACCOUNT_NOT_FOUND" });
  const access = await checkAccountAccess(identity, account, { action: "READ magalu" });
  if (!access.allow) throw Object.assign(new Error("O Hub não confirmou acesso à conta Magalu."), { status: 403, code: "MAGALU_HUB_ACCESS_DENIED" });
  return account;
}

function fail(res, error) {
  const status = Number(error?.status) || 500;
  if (status >= 500) console.error("[magalu] ranking", error);
  return res.status(status).json({ ok: false, error: error?.code || "MAGALU_RANKING_ERROR", message: status >= 500 ? "Não foi possível montar o ranking agora." : error.message });
}

function statusLabel(config) {
  return config.persist_enabled ? `Histórico mensal ativo · ${MODE_LABELS[config.snapshot_limit] || MODE_LABELS[30]}` : "Histórico mensal inativo";
}

// Lado do ranking (periodo principal ou comparacao): foto mensal ou ao vivo.
async function sideRows(account, range, { orderBy, limit, useSnapshots }) {
  if (useSnapshots && rules.isClosedMonthRange(range)) {
    const found = await rankingRepository.findSnapshot(account.id, range, orderBy, limit).catch(() => null);
    if (found) {
      return {
        source: "snapshot",
        rows: found.rows.map((row) => ({ ...row, stock_known: false })),
        totals: { revenue: Number(found.snapshot.total_revenue), units: Number(found.snapshot.total_units), products: Number(found.snapshot.products_sold) },
      };
    }
  }
  const key = JSON.stringify([account.id, range]);
  let entry = cache.get(key);
  if (!entry || Date.now() > entry.expiresAt) {
    entry = { rows: await uxAnalyticsRepository.soldSkus(account.id, { ...range, limit: 5000 }), expiresAt: Date.now() + CACHE_TTL_SEC * 1000 };
    cache.set(key, entry);
    if (cache.size > 100) cache.delete(cache.keys().next().value);
  }
  return { source: "live", rows: entry.rows, totals: null };
}

async function ranking(req, res) {
  try {
    const account = await authorizedAccount(req);
    const mainRange = rules.resolveMainRange(req.query);
    const compareRange = rules.resolveCompareRange(req.query, mainRange);
    const orderBy = String(req.query?.ordenarPor || "faturamento") === "quantidade" ? "quantidade" : "faturamento";
    const limit = rules.LIMITS.includes(Number(req.query?.limite)) ? Number(req.query.limite) : 10;
    const fulfillmentRaw = String(req.query?.fulfillment || "").toLowerCase();
    const filters = { q: String(req.query?.q || "").trim().toLowerCase().slice(0, 120), fulfillment: fulfillmentRaw === "1" ? true : fulfillmentRaw === "0" ? false : null };
    // Foto mensal so guarda o Top N sem filtros: com busca/Full o calculo e ao vivo.
    const useSnapshots = !filters.q && filters.fulfillment === null;
    if (String(req.query?.fresh || "") === "1") cache.clear();

    const [current, previous] = await Promise.all([
      sideRows(account, mainRange, { orderBy, limit, useSnapshots }),
      sideRows(account, compareRange, { orderBy, limit, useSnapshots }),
    ]);
    const payload = rules.buildRankingPayload({
      currentRows: current.rows, previousRows: previous.rows, mainRange, compareRange, orderBy, limit, filters,
      currentTotals: current.totals, previousTotals: previous.totals,
      sources: { main: current.source, compare: previous.source },
    });
    payload.meta.cache_ttl_sec = CACHE_TTL_SEC;
    return res.json(payload);
  } catch (error) {
    return fail(res, error);
  }
}

async function getConfig(req, res) {
  try {
    const account = await authorizedAccount(req);
    const config = await rankingRepository.getSettings(account.id);
    const months = await rankingRepository.listSnapshotMonths(account.id);
    return res.json({ ok: true, config, permissions: { can_manage: userAccess.isAdmin(req) }, micro_status: statusLabel(config),
      snapshots: months.map((row) => ({ month: String(row.period_start).slice(0, 7), snapshot_limit: Number(row.snapshot_limit), generated_at: row.generated_at })) });
  } catch (error) {
    return fail(res, error);
  }
}

// So administrador (rota protegida por requireAdmin). Ao ligar o historico,
// os meses fechados que faltam sao gerados em segundo plano.
async function saveConfig(req, res) {
  try {
    const account = await authorizedAccount(req);
    const config = await rankingRepository.saveSettings(account.id, {
      persistEnabled: req.body?.persist_enabled === true,
      snapshotLimit: req.body?.snapshot_limit,
      userId: req.magaluIdentity?.dachUserId || null,
    });
    if (config.persist_enabled) {
      void rankingSnapshotService.runForAccount(account.id, { snapshotLimit: config.snapshot_limit })
        .catch((error) => console.error("[magalu] fotos do ranking ao salvar config:", error?.message || error));
    }
    return res.json({ ok: true, config, permissions: { can_manage: true }, micro_status: statusLabel(config), generating: config.persist_enabled });
  } catch (error) {
    return fail(res, error);
  }
}

module.exports = { ranking, getConfig, saveConfig, _test: { ...rules, statusLabel } };
