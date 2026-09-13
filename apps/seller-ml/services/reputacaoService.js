"use strict";

const fetch = require("node-fetch");
const TokenService = require("./tokenService");
const simpleCache = require("./simpleCache");
const db = require("../db/db");

const API_BASE = "https://api.mercadolibre.com";
const OVERVIEW_TTL_SEC = 900;
const OVERVIEW_CACHE_VERSION = 2;
const REASON_TTL_SEC = 60 * 60 * 12;
const MAX_PAGE_SIZE = 25;
const SNAPSHOT_RETENTION_DAYS = 90;
const SALES_WINDOW_DAYS = 60;
const SALES_WINDOW_HARD_CAP = 6000;
const POWER_SELLER_TIERS = {
  silver: { key: "silver", label: "MercadoLider", sales: 230, revenue: 37000 },
  gold: { key: "gold", label: "MercadoLider Gold", sales: 575, revenue: 118400 },
  platinum: { key: "platinum", label: "MercadoLider Platinum", sales: 1725, revenue: 296000 },
};
const POWER_SELLER_ORDER = ["silver", "gold", "platinum"];

function lower(v) {
  return String(v || "").trim().toLowerCase();
}

function compact(obj = {}) {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined && v !== null && v !== "")
  );
}

function accountKeyFrom(opts = {}) {
  return (
    opts.accountKey ||
    opts.key ||
    opts.mlCreds?.account_key ||
    opts.mlCreds?.accountKey ||
    process.env.ACCOUNT_KEY ||
    process.env.SELECTED_ACCOUNT ||
    null
  );
}

function resolveCredsFrom(opts = {}) {
  const key = accountKeyFrom(opts);
  return {
    app_id: opts.mlCreds?.app_id || process.env.APP_ID || process.env.ML_APP_ID,
    client_secret:
      opts.mlCreds?.client_secret || process.env.CLIENT_SECRET || process.env.ML_CLIENT_SECRET,
    refresh_token:
      opts.mlCreds?.refresh_token || process.env.REFRESH_TOKEN || process.env.ML_REFRESH_TOKEN,
    access_token:
      opts.mlCreds?.access_token || process.env.ACCESS_TOKEN || process.env.ML_ACCESS_TOKEN,
    redirect_uri:
      opts.mlCreds?.redirect_uri || process.env.REDIRECT_URI || process.env.ML_REDIRECT_URI,
    meli_conta_id: opts.mlCreds?.meli_conta_id || null,
    account_key: key,
    accountKey: key,
  };
}

async function prepareAuthState(options = {}) {
  const creds = resolveCredsFrom(options);
  const merged = {
    ...creds,
    access_token: options.access_token || creds.access_token,
    account_key: creds.account_key || creds.accountKey || null,
  };
  const token = await TokenService.renovarTokenSeNecessario(merged);
  return {
    token,
    creds: merged,
    key: merged.account_key || "sem-conta",
    logger: options.logger || console,
  };
}

async function authFetch(path, init = {}, state) {
  const url = /^https?:\/\//i.test(path) ? path : `${API_BASE}${path}`;
  const doCall = async (token) => {
    const headers = {
      accept: "application/json",
      ...(init.headers || {}),
      Authorization: `Bearer ${token}`,
    };
    return fetch(url, { ...init, headers });
  };

  let resp = await doCall(state.token);
  if (resp.status !== 401) return resp;

  const renewed = await TokenService.renovarToken(state.creds);
  state.token = renewed.access_token;
  return doCall(state.token);
}

async function readJson(resp) {
  const text = await resp.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function fetchJsonWithFallbacks(candidates, state, { soft = false } = {}) {
  let lastError = null;
  for (const candidate of candidates) {
    try {
      const resp = await authFetch(candidate, {}, state);
      if (resp.ok) {
        return { ok: true, url: candidate, status: resp.status, data: await readJson(resp) };
      }
      const payload = await readJson(resp);
      lastError = new Error(`HTTP ${resp.status} em ${candidate}: ${payload?.message || payload?.error || "falha"}`);
      if (![400, 404].includes(resp.status)) break;
    } catch (err) {
      lastError = err;
    }
  }
  if (soft) return { ok: false, error: lastError };
  throw lastError || new Error("Falha ao consultar API do Mercado Livre");
}

function normalizeArray(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.results)) return payload.results;
  if (Array.isArray(payload?.claims)) return payload.claims;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.data?.results)) return payload.data.results;
  if (Array.isArray(payload?.data?.claims)) return payload.data.claims;
  if (Array.isArray(payload?.data?.data)) return payload.data.data;
  if (Array.isArray(payload?.messages)) return payload.messages;
  return [];
}

function getPaging(payload = {}) {
  return (
    payload?.paging ||
    payload?.pagination ||
    payload?.pager ||
    payload?.data?.paging ||
    payload?.data?.pagination ||
    payload?.data?.pager ||
    {}
  );
}

function normalizeClaimSearchItem(item = {}) {
  const nested =
    item?.claim ||
    item?.data?.claim ||
    item?.data ||
    item?.result ||
    item;
  if (!nested || typeof nested !== "object" || Array.isArray(nested)) return item;
  return {
    ...item,
    ...nested,
    related_entities:
      nested.related_entities ||
      nested.relatedEntities ||
      item.related_entities ||
      item.relatedEntities ||
      {},
  };
}

function buildClaimsSearchPath({
  base = "/post-purchase/v1/claims/search",
  status,
  stage,
  playerRole,
  playerUserId,
  limit = 25,
  offset = 0,
  sort = "last_updated:desc",
} = {}) {
  const qs = new URLSearchParams();
  if (status) qs.set("status", status);
  if (stage) qs.set("stage", stage);
  if (playerRole) qs.set("players.role", playerRole);
  if (playerUserId) qs.set("players.user_id", String(playerUserId));
  qs.set("limit", String(limit));
  qs.set("offset", String(offset));
  if (sort) qs.set("sort", sort);
  return `${base}?${qs.toString()}`;
}

async function fetchClaimsSearch(state, { sellerId, limit = 25, offset = 0 } = {}) {
  const queryVariants = [
    { playerRole: "respondent", playerUserId: sellerId },
    { playerRole: "respondent", playerUserId: sellerId, status: "opened" },
    { playerRole: "respondent", playerUserId: sellerId, status: "closed" },
  ];

  const bases = ["/post-purchase/v1/claims/search", "/claims/search"];
  const warnings = [];
  const found = [];
  const seen = new Set();
  let total = 0;
  let anyOk = false;

  for (const base of bases) {
    for (const variant of queryVariants) {
      const path = buildClaimsSearchPath({ base, ...variant, limit, offset });
      const resp = await fetchJsonWithFallbacks([path], state, { soft: true });
      if (!resp.ok) {
        warnings.push(resp.error?.message || `Falha ao consultar ${path}`);
        continue;
      }

      anyOk = true;
      const arr = normalizeArray(resp.data);
      const paging = getPaging(resp.data);
      total = Math.max(total, Number(paging?.total || 0), arr.length + offset);

      if (arr.length) {
        for (const rawItem of arr) {
          const item = normalizeClaimSearchItem(rawItem);
          const id = item?.id || item?.resource_id || item?.claim_id;
          if (!id || seen.has(String(id))) continue;
          seen.add(String(id));
          found.push(item);
        }
        return {
          ok: true,
          warnings,
          data: found,
          paging: { total, offset, limit },
        };
      }
    }
  }

  return {
    ok: anyOk,
    warnings,
    data: found,
    paging: { total, offset, limit },
  };
}

function normalizeExposurePayload(payload = {}) {
  const ids = Array.isArray(payload?.results) ? payload.results : [];
  return {
    total: Number(payload?.paging?.total || ids.length || 0),
    items: ids.slice(0, 20),
  };
}

function pickReasonLabel(payload = {}, reasonId) {
  const candidates = [
    payload?.name,
    payload?.label,
    payload?.reason,
    payload?.reason_name,
    payload?.display_name,
    payload?.description,
    payload?.detail,
    payload?.category?.name,
    payload?.category_label,
    payload?.group?.name,
    payload?.type,
    payload?.title,
  ].filter(Boolean);

  if (candidates.length) return normalizeReasonLabel(candidates[0]);
  return normalizeReasonLabel(reasonId);
}

function normalizeReasonLabel(reason) {
  const source = lower(reason);
  if (!source) return "Por outros motivos";

  const exact = [
    ["com o produto entregue", "Com o produto entregue"],
    ["ao enviar ou entregar o produto", "Ao enviar ou entregar o produto"],
    ["ao gerenciar ou preparar a venda", "Ao gerenciar ou preparar a venda"],
    ["porque o comprador se arrependeu", "Porque o comprador se arrependeu"],
    ["por outros motivos", "Por outros motivos"],
  ];
  for (const [needle, label] of exact) {
    if (source.includes(needle)) return label;
  }

  const map = [
    { keys: ["product", "produto", "defect", "defeito", "damag", "avaria", "com o produto entregue"], label: "Com o produto entregue" },
    { keys: ["shipment", "shipping", "envio", "deliver", "entrega", "tracking", "ao enviar ou entregar o produto"], label: "Ao enviar ou entregar o produto" },
    { keys: ["cancel", "gerenciar", "preparar", "prepare", "manage", "stock", "estoque", "ao gerenciar ou preparar a venda"], label: "Ao gerenciar ou preparar a venda" },
    { keys: ["regret", "arrepend", "devolver", "return", "buyer_remorse", "porque o comprador se arrependeu"], label: "Porque o comprador se arrependeu" },
  ];
  const found = map.find((entry) => entry.keys.some((key) => source.includes(key)));
  return found?.label || "Por outros motivos";
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (value === null || value === undefined) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return "-";
}

function summarizeClaim({ claim, detail, order, categoryLabel }) {
  const c = detail || claim || {};
  const related = c.related_entities || c.relatedEntities || {};
  const orderItem = Array.isArray(order?.order_items) ? order.order_items[0] : null;
  const orderId = firstNonEmpty(
    c.order_id,
    c.resource_id,
    c.resourceId,
    related.order_id,
    claim?.order_id,
    order?.id
  );
  const itemId = firstNonEmpty(
    related.item_id,
    orderItem?.item?.id,
    orderItem?.item?.item_id,
    claim?.item_id,
    c.item_id
  );
  const itemTitle = firstNonEmpty(
    orderItem?.item?.title,
    c.item_title,
    claim?.item_title,
    related.item_title,
    c.item?.title,
    claim?.item?.title
  );
  const status = lower(c.status || c.claim_status || c.resolution?.status || c.current_status) || "-";
  const stage = lower(c.stage || c.claim_stage || c.type) || "-";
  const reason = firstNonEmpty(
    c.reason_id,
    c.reason?.id,
    c.reason?.name,
    c.reason,
    c.classification_id,
    c.classification
  );
  const createdAt = c.date_created || claim?.date_created || c.last_updated || detail?.last_updated || null;
  const finalizada = ["closed", "resolved", "cancelled", "finalized", "solution_applied", "finished"].some(
    (word) => status.includes(word) || stage.includes(word)
  );
  const emMediacao = stage.includes("dispute") || stage.includes("mediation");
  const eligibility = emMediacao
    ? { isEligible: false, code: "mediacao", label: "em mediacao", tone: "orange", helper: "exige leitura separada" }
    : finalizada
      ? { isEligible: true, code: "finalizada", label: "finalizada", tone: "green", helper: "tratativa encerrada" }
      : { isEligible: false, code: "em_analise", label: "em analise", tone: "blue", helper: "acompanhar andamento" };
  const expiration = computeExpiration(createdAt);
  const normalizedCategory = firstNonEmpty(categoryLabel, normalizeReasonLabel(reason), "Por outros motivos");

  return {
    id: firstNonEmpty(c.id, claim?.id, claim?.resource_id),
    resource_id: c.resource_id || claim?.resource_id || null,
    order_id: orderId,
    pack_id: order?.pack_id || related.pack_id || c.pack_id || null,
    item_id: itemId,
    item_title: itemTitle,
    status,
    stage,
    reason_id: reason,
    category_label: normalizedCategory,
    type: firstNonEmpty(c.type, claim?.type),
    created_at: createdAt,
    impact_date: expiration.impact_date,
    expires_at: expiration.expires_at,
    expires_in_days: expiration.days_remaining,
    is_expired: expiration.expired,
    expiration_label: expiration.label,
    expiration_helper: expiration.helper,
    last_updated: c.last_updated || detail?.last_updated || createdAt,
    amount: order?.total_amount || c.amount || c.claim_amount?.amount || c.expected_amount?.amount || null,
    currency_id: order?.currency_id || c.currency_id || c.claim_amount?.currency_id || "BRL",
    seller_messages: 0,
    seller_messages_probable: 0,
    buyer_messages: 0,
    buyer_messages_probable: 0,
    messages_total: 0,
    nossa_interacao: false,
    nossa_interacao_provavel: false,
    contato_iniciado: false,
    contato_iniciado_por_volume: false,
    finalizada,
    em_mediacao: emMediacao,
    aguardando_comprador: false,
    elegivel: eligibility.isEligible,
    eligibility_code: eligibility.code,
    eligibility_label: eligibility.label,
    eligibility_helper: eligibility.helper,
    eligibility_tone: eligibility.tone,
    last_message_from: "nao mapeada",
    last_message_confidence: "nao calculada",
    last_message_source: "claim",
    last_message_at: null,
    context_excerpt: normalizedCategory,
    message_state_label: "mensagens nao mapeadas",
    message_state_tone: "gray",
    last_interaction_label: "interacoes ocultas",
    status_badges: {
      finalizada,
      em_mediacao: emMediacao,
    },
    marketplace_link: orderId !== "-" ? `https://www.mercadolivre.com.br/vendas/${orderId}/detail` : null,
  };
}

const LIMITS_BY_TIER = {
  green: { claims: 2.0, mediations: 0.5, cancellations: 1.5, delayed: 10.0 },
  leader: { claims: 1.0, mediations: 0.5, cancellations: 0.5, delayed: 6.0 },
  gold: { claims: 1.0, mediations: 0.5, cancellations: 0.5, delayed: 6.0 },
  platinum: { claims: 1.0, mediations: 0.5, cancellations: 0.5, delayed: 6.0 },
  default: { claims: 2.0, mediations: 0.5, cancellations: 1.5, delayed: 10.0 },
};

function getSellerTier(sellerReputation = {}) {
  const medal = lower(sellerReputation?.power_seller_status);
  const level = lower(sellerReputation?.level_id);

  if (medal.includes("platinum")) return "platinum";
  if (medal.includes("gold")) return "gold";
  if (medal.includes("leader") || medal.includes("lider")) return "leader";
  if (level === "5_green") return "green";
  return "default";
}

function normalizeMetricPercent(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0;
  if (n > 0 && n <= 1) return n * 100;
  return n;
}

function metricValue(metric = {}) {
  if (typeof metric?.rate === "number") return normalizeMetricPercent(metric.rate);
  if (typeof metric?.percent === "number") return normalizeMetricPercent(metric.percent);
  if (typeof metric?.value === "number" && typeof metric?.rate !== "number") return normalizeMetricPercent(metric.value);
  return 0;
}

function metricAmount(metric = {}) {
  const candidates = [
    metric?.count,
    metric?.amount,
    metric?.total,
    metric?.cases,
    metric?.current_count,
    metric?.period_count,
    metric?.period?.count,
    metric?.claims,
    metric?.value,
  ];

  for (const raw of candidates) {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return 0;
}

function summarizeRawClaimLight(rawClaim = {}) {
  const related = rawClaim.related_entities || rawClaim.relatedEntities || {};
  const reason = firstNonEmpty(
    rawClaim.reason_id,
    rawClaim.reason?.id,
    rawClaim.reason?.name,
    rawClaim.reason,
    rawClaim.classification_id,
    rawClaim.classification
  );
  const createdAt = parseCasesDate(rawClaim);
  const expiration = computeExpiration(createdAt);
  const bucket = getClaimStageBucket(rawClaim);

  return {
    id: firstNonEmpty(rawClaim.id, rawClaim.resource_id, rawClaim.claim_id),
    display_id: String(firstNonEmpty(rawClaim.id, rawClaim.resource_id, rawClaim.claim_id, "-")),
    order_id: getClaimOrderId(rawClaim),
    item_id: firstNonEmpty(
      related.item_id,
      rawClaim.item_id,
      rawClaim.item?.id
    ),
    item_title: firstNonEmpty(
      rawClaim.item_title,
      related.item_title,
      rawClaim.item?.title,
      rawClaim.title,
      "Produto sem titulo"
    ),
    status: lower(rawClaim.status || rawClaim.claim_status || rawClaim.current_status) || "-",
    stage: lower(rawClaim.stage || rawClaim.claim_stage || rawClaim.type) || "-",
    reason_id: reason,
    category_label: firstNonEmpty(normalizeReasonLabel(reason), "Motivo nao informado"),
    type: firstNonEmpty(rawClaim.type, "claim"),
    created_at: createdAt,
    sale_date:
      rawClaim.sale_date ||
      rawClaim.order_date ||
      rawClaim.order?.date_created ||
      rawClaim.related_entities?.order_date ||
      null,
    impact_date: expiration.impact_date,
    expires_at: expiration.expires_at,
    exits_reputation_at: expiration.expires_at,
    expires_in_days: expiration.days_remaining,
    expiration_label: expiration.label,
    expiration_helper: expiration.helper,
    last_updated: rawClaim.last_updated || createdAt,
    finalizada: lower(rawClaim.status).includes("closed"),
    em_mediacao: bucket === "mediations",
    elegivel: false,
    eligibility_code: "snapshot_light",
    eligibility_label: "leitura agregada",
    eligibility_tone: "gray",
    context_excerpt: normalizeReasonLabel(reason),
    marketplace_link: getClaimOrderId(rawClaim)
      ? `https://www.mercadolivre.com.br/vendas/${getClaimOrderId(rawClaim)}/detail`
      : null,
    case_kind: "claim",
    case_kind_label: "Reclamacao",
    impact_bucket: bucket,
    affects_reputation: getAffectsReputationValue(rawClaim),
  };
}

function metricStatus(value, limit) {
  const current = Number(value || 0);
  const max = Number(limit || 0);
  if (!max) return "stable";
  if (current >= max) return "critical";
  if (current >= max * 0.8) return "warning";
  return "healthy";
}

function metricStatusLabel(status) {
  if (status === "critical") return "Acima do limite";
  if (status === "warning") return "Proximo do limite";
  return "Dentro do limite";
}

function resolveImpactBucketFromCase(item = {}) {
  const direct = lower(item.impact_bucket || item.metric_bucket || item.impact_metric || item.case_group || item.metric_key || item.filter_key);
  if (direct.includes("mediation") || direct.includes("mediacao") || direct.includes("dispute")) return "mediations";
  if (direct.includes("cancel")) return "cancellations";
  if (direct.includes("delay") || direct.includes("dispatch") || direct.includes("handling") || direct.includes("atraso")) return "delayed";
  return "claims";
}

function countCasesInRange(cases = [], bucket, from, to) {
  const start = from ? from.getTime() : 0;
  const end = to ? to.getTime() : Date.now();
  return cases.filter((item) => {
    if (resolveImpactBucketFromCase(item) !== bucket) return false;
    const d = new Date(parseCasesDate(item) || item.created_at || item.last_updated || 0);
    if (Number.isNaN(d.getTime())) return false;
    return d.getTime() >= start && d.getTime() < end;
  }).length;
}

function weeklyBuckets(cases = [], bucket) {
  const now = new Date();
  const result = [];
  for (let index = 3; index >= 0; index -= 1) {
    const from = new Date(now);
    from.setHours(0, 0, 0, 0);
    from.setDate(from.getDate() - (index + 1) * 7);
    const to = new Date(now);
    to.setHours(0, 0, 0, 0);
    to.setDate(to.getDate() - index * 7);
    result.push({
      label: `Semana ${4 - index}`,
      count: countCasesInRange(cases, bucket, from, to),
    });
  }
  return result;
}

function trendFromCounts(current, previous) {
  const cur = Number(current || 0);
  const prev = Number(previous || 0);
  if (!prev && !cur) return { value: 0, label: "Estavel", tone: "stable" };
  if (!prev && cur) return { value: null, label: "Sem historico", tone: "stable" };
  const delta = ((cur - prev) / prev) * 100;
  return {
    value: delta,
    label: `${delta >= 0 ? "+" : "-"}${Math.abs(Math.round(delta))}% esta semana`,
    tone: delta > 0 ? "up" : delta < 0 ? "down" : "stable",
  };
}

function snapshotAccountKey(state = {}, sellerId = "") {
  return String(
    state?.key ||
      state?.creds?.account_key ||
      state?.creds?.accountKey ||
      state?.creds?.meli_conta_id ||
      sellerId ||
      "sem-conta"
  );
}

async function ensureReputationSnapshotsTable() {
  await db.query(`
    CREATE SCHEMA IF NOT EXISTS ml;
    CREATE TABLE IF NOT EXISTS ml.reputation_snapshots (
      id bigserial PRIMARY KEY,
      account_key text NOT NULL,
      seller_id text NOT NULL DEFAULT '',
      meli_conta_id bigint NULL REFERENCES ml.meli_contas (id) ON DELETE SET NULL,
      snapshot_date date NOT NULL DEFAULT current_date,
      reputation_level text NULL,
      status_tone text NULL,
      claims_pct numeric(10,4) NOT NULL DEFAULT 0,
      claims_count integer NOT NULL DEFAULT 0,
      claims_limit numeric(10,4) NOT NULL DEFAULT 0,
      mediations_pct numeric(10,4) NOT NULL DEFAULT 0,
      mediations_count integer NOT NULL DEFAULT 0,
      mediations_limit numeric(10,4) NOT NULL DEFAULT 0,
      cancellations_pct numeric(10,4) NOT NULL DEFAULT 0,
      cancellations_count integer NOT NULL DEFAULT 0,
      cancellations_limit numeric(10,4) NOT NULL DEFAULT 0,
      delayed_pct numeric(10,4) NOT NULL DEFAULT 0,
      delayed_count integer NOT NULL DEFAULT 0,
      delayed_limit numeric(10,4) NOT NULL DEFAULT 0,
      top_products_json jsonb NOT NULL DEFAULT '[]'::jsonb,
      intelligence_json jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT reputation_snapshots_unique_day UNIQUE (account_key, seller_id, snapshot_date)
    );
    CREATE INDEX IF NOT EXISTS idx_reputation_snapshots_account_date
      ON ml.reputation_snapshots (account_key, seller_id, snapshot_date DESC);
  `);
}

function snapshotRowToMetrics(row = {}) {
  return {
    claims: { value: Number(row.claims_pct || 0), count: Number(row.claims_count || 0), limit: Number(row.claims_limit || 0) },
    mediations: { value: Number(row.mediations_pct || 0), count: Number(row.mediations_count || 0), limit: Number(row.mediations_limit || 0) },
    cancellations: { value: Number(row.cancellations_pct || 0), count: Number(row.cancellations_count || 0), limit: Number(row.cancellations_limit || 0) },
    delayed: { value: Number(row.delayed_pct || 0), count: Number(row.delayed_count || 0), limit: Number(row.delayed_limit || 0) },
  };
}

function findClosestSnapshot(snapshots = [], targetDate) {
  const target = new Date(targetDate);
  if (Number.isNaN(target.getTime())) return null;
  const targetMs = target.getTime();
  const toleranceMs = 36 * 60 * 60 * 1000;
  let best = null;
  let bestDiff = Infinity;
  for (const row of snapshots) {
    const d = new Date(row.snapshot_date);
    if (Number.isNaN(d.getTime())) continue;
    const diff = Math.abs(d.getTime() - targetMs);
    if (diff < bestDiff && diff <= toleranceMs) {
      best = row;
      bestDiff = diff;
    }
  }
  return best;
}

function applySnapshotHistory(intelligence = {}, snapshots = []) {
  const metrics = intelligence.metrics || {};
  const now = new Date();
  const previous = new Date(now);
  previous.setDate(previous.getDate() - 7);
  const previousSnapshot = findClosestSnapshot(snapshots, previous);
  const previousMetrics = previousSnapshot ? snapshotRowToMetrics(previousSnapshot) : null;

  for (const key of Object.keys(metrics)) {
    const metric = metrics[key] || {};
    const prev = previousMetrics?.[key] || null;
    if (prev && Number(prev.value || 0) > 0) {
      const delta = ((Number(metric.value || 0) - Number(prev.value || 0)) / Number(prev.value || 1)) * 100;
      metric.delta_7d_pct = delta;
      metric.delta_7d_label = `${delta >= 0 ? "+" : "-"}${Math.abs(Math.round(delta))}% vs 7d ant.`;
    } else {
      metric.delta_7d_pct = null;
      metric.delta_7d_label = "Sem historico";
    }

    metric.weeks = [21, 14, 7, 0].map((daysBack, index) => {
      if (daysBack === 0) {
        return { label: "Atual", count: Number(metric.count || 0), value: Number(metric.value || 0), has_history: true };
      }
      const target = new Date(now);
      target.setDate(target.getDate() - daysBack);
      const row = findClosestSnapshot(snapshots, target);
      const snapMetric = row ? snapshotRowToMetrics(row)[key] : null;
      return {
        label: `S-${3 - index}`,
        count: snapMetric ? Number(snapMetric.count || 0) : 0,
        value: snapMetric ? Number(snapMetric.value || 0) : 0,
        has_history: !!snapMetric,
      };
    });
  }

  intelligence.history = {
    available: !!previousSnapshot,
    retention_days: SNAPSHOT_RETENTION_DAYS,
    previous_snapshot_date: previousSnapshot?.snapshot_date || null,
  };

  return intelligence;
}

async function fetchReputationSnapshots({ state, sellerId }) {
  try {
    await ensureReputationSnapshotsTable();
    const accountKey = snapshotAccountKey(state, sellerId);
    const { rows } = await db.query(
      `
        SELECT *
          FROM ml.reputation_snapshots
         WHERE account_key = $1
           AND seller_id = $2
           AND snapshot_date >= current_date - ($3::int * interval '1 day')
         ORDER BY snapshot_date ASC
      `,
      [accountKey, String(sellerId || ""), SNAPSHOT_RETENTION_DAYS],
    );
    return rows || [];
  } catch (error) {
    state?.logger?.warn?.("[reputacao] Falha ao buscar snapshots:", error?.message || error);
    return [];
  }
}

async function saveReputationSnapshot({ state, sellerId, intelligence }) {
  try {
    await ensureReputationSnapshotsTable();
    const accountKey = snapshotAccountKey(state, sellerId);
    const metrics = intelligence?.metrics || {};
    const topProducts = intelligence?.top_products || [];
    await db.query(
      `
        INSERT INTO ml.reputation_snapshots (
          account_key, seller_id, meli_conta_id, snapshot_date,
          reputation_level, status_tone,
          claims_pct, claims_count, claims_limit,
          mediations_pct, mediations_count, mediations_limit,
          cancellations_pct, cancellations_count, cancellations_limit,
          delayed_pct, delayed_count, delayed_limit,
          top_products_json, intelligence_json, updated_at
        ) VALUES (
          $1, $2, $3, current_date,
          $4, $5,
          $6, $7, $8,
          $9, $10, $11,
          $12, $13, $14,
          $15, $16, $17,
          $18::jsonb, $19::jsonb, now()
        )
        ON CONFLICT (account_key, seller_id, snapshot_date)
        DO UPDATE SET
          reputation_level = excluded.reputation_level,
          status_tone = excluded.status_tone,
          claims_pct = excluded.claims_pct,
          claims_count = excluded.claims_count,
          claims_limit = excluded.claims_limit,
          mediations_pct = excluded.mediations_pct,
          mediations_count = excluded.mediations_count,
          mediations_limit = excluded.mediations_limit,
          cancellations_pct = excluded.cancellations_pct,
          cancellations_count = excluded.cancellations_count,
          cancellations_limit = excluded.cancellations_limit,
          delayed_pct = excluded.delayed_pct,
          delayed_count = excluded.delayed_count,
          delayed_limit = excluded.delayed_limit,
          top_products_json = excluded.top_products_json,
          intelligence_json = excluded.intelligence_json,
          updated_at = now()
      `,
      [
        accountKey,
        String(sellerId || ""),
        state?.creds?.meli_conta_id || null,
        intelligence?.status?.level || null,
        intelligence?.status?.tone || null,
        metrics.claims?.value || 0,
        metrics.claims?.count || 0,
        metrics.claims?.limit || 0,
        metrics.mediations?.value || 0,
        metrics.mediations?.count || 0,
        metrics.mediations?.limit || 0,
        metrics.cancellations?.value || 0,
        metrics.cancellations?.count || 0,
        metrics.cancellations?.limit || 0,
        metrics.delayed?.value || 0,
        metrics.delayed?.count || 0,
        metrics.delayed?.limit || 0,
        JSON.stringify(topProducts),
        JSON.stringify(intelligence),
      ],
    );
    await db.query(
      `DELETE FROM ml.reputation_snapshots WHERE snapshot_date < current_date - ($1::int * interval '1 day')`,
      [SNAPSHOT_RETENTION_DAYS],
    );
  } catch (error) {
    state?.logger?.warn?.("[reputacao] Falha ao salvar snapshot:", error?.message || error);
  }
}

function buildMetricInsight({ key, label, data, limit, cases, helper }) {
  const value = metricValue(data);
  const metricCount = metricAmount(data);
  const bucketCount = (cases || []).filter((item) => resolveImpactBucketFromCase(item) === key).length;
  const count = Math.max(Number(metricCount || 0), Number(bucketCount || 0));
  const current7 = countCasesInRange(cases, key, subtractDays(7), new Date());
  const previous7 = countCasesInRange(cases, key, subtractDays(14), subtractDays(7));
  const delta = trendFromCounts(current7, previous7);
  const status = metricStatus(value, limit);
  return {
    key,
    label,
    value,
    count,
    limit,
    limit_label: `Limite maximo ML: ${String(limit || 0).replace(".", ",")}%`,
    status,
    status_label: metricStatusLabel(status),
    delta_7d_pct: delta.value,
    delta_7d_label: delta.label,
    current_7d_count: current7,
    previous_7d_count: previous7,
    helper,
    weeks: weeklyBuckets(cases, key),
  };
}

function metricExplicitAmount(metric = {}) {
  const candidates = [
    metric?.count,
    metric?.amount,
    metric?.total,
    metric?.cases,
    metric?.current_count,
    metric?.period_count,
    metric?.period?.count,
    metric?.claims,
  ];

  for (const raw of candidates) {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return 0;
}

function estimateMetricCases(metric = {}, baseSales = 0) {
  const explicit = metricExplicitAmount(metric);
  if (explicit > 0) return Math.round(explicit);
  const value = metricValue(metric);
  const sales = Number(baseSales || 0);
  if (!value || !sales) return 0;
  return Math.max(0, Math.round((value / 100) * sales));
}

function buildTopClaimProducts(cases = [], fallbackCases = [], { maxCases = 0 } = {}) {
  const grouped = new Map();
  const sources = [];
  for (const item of cases || []) {
    if (resolveImpactBucketFromCase(item) !== "claims") continue;
    sources.push(item);
  }
  if (!sources.length) {
    for (const item of fallbackCases || []) {
      if (!item) continue;
      sources.push(item);
    }
  }

  const scopedSources = uniqueCasesByIdentity(sources)
    .sort((a, b) => {
      const da = new Date(parseCasesDate(a) || a.created_at || a.last_updated || 0).getTime();
      const db = new Date(parseCasesDate(b) || b.created_at || b.last_updated || 0).getTime();
      return db - da;
    })
    .slice(0, maxCases > 0 ? maxCases : sources.length);

  for (const item of scopedSources) {
    const key = String(item.item_id || item.order_id || item.id || "sem-item");
    const current = grouped.get(key) || {
      item_id: item.item_id || "-",
      order_id: item.order_id || null,
      title: item.item_title || "Produto sem titulo",
      sales: null,
      stock: null,
      claims: 0,
      last_case_at: null,
      reason: item.category_label || item.reason_id || "Motivo nao informado",
    };
    current.claims += 1;
    const itemDate = item.created_at || item.last_updated || null;
    if (!current.last_case_at || new Date(itemDate || 0).getTime() > new Date(current.last_case_at || 0).getTime()) {
      current.last_case_at = itemDate;
    }
    grouped.set(key, current);
  }

  const sorted = Array.from(grouped.values())
    .sort((a, b) => {
      const claimDiff = Number(b.claims || 0) - Number(a.claims || 0);
      if (claimDiff) return claimDiff;
      return new Date(b.last_case_at || 0).getTime() - new Date(a.last_case_at || 0).getTime();
    })
    .slice(0, 3);
  const totalClaims = Math.max(1, Array.from(grouped.values()).reduce((sum, item) => sum + Number(item.claims || 0), 0));

  return sorted
    .map((item, index) => ({
      ...item,
      rank: index + 1,
      sales_share_pct: (item.claims / totalClaims) * 100,
      trend_label: index === 0 ? "alta recente" : index === 1 ? "atencao" : "estavel",
      trend_tone: index === 0 ? "critical" : index === 1 ? "warning" : "healthy",
    }));
}

function uniqueCasesByIdentity(cases = []) {
  const output = [];
  const seen = new Set();
  for (const item of cases || []) {
    if (!item) continue;
    const key = String(item.id || item.display_id || item.order_id || item.resource_id || "").trim();
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    output.push(item);
  }
  return output;
}

function buildFallbackClaimCases(rawClaims = [], metrics = {}) {
  const reputationWindowStart = subtractDays(60);
  const officialCount = Math.max(0, Math.floor(metricExplicitAmount(metrics?.claims)));
  const rows = uniqueCasesByIdentity(
    rawClaims
      .map((rawClaim) => summarizeRawClaimLight(rawClaim))
      .filter((item) => {
        const date = parseCasesDate(item) || item.created_at || item.last_updated;
        return date && isOnOrAfter(date, reputationWindowStart) && !hasAvoidReputationTag(item);
      })
  ).sort((a, b) => {
    const da = new Date(parseCasesDate(a) || a.created_at || a.last_updated || 0).getTime();
    const db = new Date(parseCasesDate(b) || b.created_at || b.last_updated || 0).getTime();
    return db - da;
  });

  return officialCount ? rows.slice(0, officialCount) : rows.slice(0, 3);
}

async function enrichTopClaimProducts(products = [], state) {
  const output = [];
  for (const product of products || []) {
    let itemId = String(product?.item_id || "").trim();
    let summary = null;
    try {
      if (!/^ML[A-Z]\d+/i.test(itemId)) {
        const orderId = String(product?.order_id || product?.item_id || "").trim();
        const orderResp = await fetchOrderDetail(orderId, state);
        const orderItem = getFirstOrderItem(orderResp.data || {});
        itemId = String(orderItem?.item?.id || orderItem?.item?.item_id || "").trim();
        if (itemId) {
          product.title = orderItem?.item?.title || product.title;
        }
      }
      summary = await fetchItemSummary(itemId, state);
    } catch {
      summary = null;
    }
    output.push({
      ...product,
      item_id: summary?.item_id || (/^ML[A-Z]\d+/i.test(itemId) ? itemId : product.item_id) || "-",
      title: summary?.title || product.title || "Produto sem titulo",
      thumbnail: summary?.thumbnail || product.thumbnail || null,
      permalink: summary?.permalink || product.permalink || null,
    });
  }
  return output;
}

async function buildReputationIntelligence({ sellerId, sellerNickname, sellerReputation, limits, metrics, cases, fallbackClaimCases = [], salesWindow = null, state = null }) {
  const metricCards = {
    claims: buildMetricInsight({
      key: "claims",
      label: "Reclamacoes",
      data: metrics?.claims,
      limit: limits.claims,
      cases,
      helper: "Casos abertos por compradores que podem afetar a reputacao.",
    }),
    mediations: buildMetricInsight({
      key: "mediations",
      label: "Mediacoes",
      data: metrics?.disputes,
      limit: limits.mediations,
      cases,
      helper: "Casos que chegaram em disputa/mediacao.",
    }),
    cancellations: buildMetricInsight({
      key: "cancellations",
      label: "Cancelamentos",
      data: metrics?.cancellations,
      limit: limits.cancellations,
      cases,
      helper: "Pedidos cancelados por voce ou por falhas operacionais.",
    }),
    delayed: buildMetricInsight({
      key: "delayed",
      label: "Atrasos envio",
      data: metrics?.delayed_handling_time,
      limit: limits.delayed,
      cases,
      helper: "Envios despachados fora do prazo esperado.",
    }),
  };

  const ordered = Object.values(metricCards).sort((a, b) => {
    const severity = { critical: 3, warning: 2, healthy: 1, stable: 0 };
    return (severity[b.status] || 0) - (severity[a.status] || 0) || Number(b.value || 0) - Number(a.value || 0);
  });
  const worst = ordered[0] || metricCards.claims;
  const topProducts = [];
  const statusTone = worst?.status === "critical" ? "critical" : worst?.status === "warning" ? "warning" : "healthy";
  const statusLabel = statusTone === "critical" ? "Atencao imediata" : statusTone === "warning" ? "Em observacao" : "Dentro dos limites";
  const claims = metricCards.claims;

  return {
    generated_at: new Date().toISOString(),
    status: {
      tone: statusTone,
      label: statusLabel,
      level: sellerReputation?.level_id || null,
    },
    header: {
      seller_id: sellerId || null,
      seller_nickname: sellerNickname || "-",
      updated_label: "ha poucos minutos",
    },
    alert: {
      tone: statusTone,
      title:
        statusTone === "healthy"
          ? "Reputacao dentro dos limites monitorados"
          : `${worst.label} em atencao — priorize a tratativa`,
      summary:
        statusTone === "healthy"
          ? "As metricas principais estao abaixo dos limites do Mercado Livre. Continue monitorando variacoes semanais."
          : `${worst.label} esta em ${String(worst.value).replace(".", ",")}% com limite maximo de ${String(worst.limit).replace(".", ",")}%. Foram ${worst.current_7d_count} caso(s) nos ultimos 7 dias.`,
      detail:
        claims.count
          ? `${claims.count} venda(s) ainda fazem parte da janela atual de reclamacoes. Abra a metrica para consultar venda e datas.`
          : "Nenhuma venda impactada foi detalhada na leitura atual.",
    },
    metrics: metricCards,
    trends: metricCards,
    top_products: topProducts,
  };
}

function computeExpiration(createdAt) {
  if (!createdAt) {
    return {
      impact_date: null,
      expires_at: null,
      days_remaining: null,
      expired: false,
      label: "-",
      helper: "",
    };
  }

  const impactDate = new Date(createdAt);
  if (Number.isNaN(impactDate.getTime())) {
    return {
      impact_date: createdAt,
      expires_at: null,
      days_remaining: null,
      expired: false,
      label: "-",
      helper: "",
    };
  }

  const expiresAt = new Date(impactDate.getTime());
  expiresAt.setDate(expiresAt.getDate() + 60);

  const now = new Date();
  const msPerDay = 24 * 60 * 60 * 1000;
  const diffDays = Math.ceil((expiresAt.getTime() - now.getTime()) / msPerDay);
  const expired = diffDays < 0;

  return {
    impact_date: impactDate.toISOString(),
    expires_at: expiresAt.toISOString(),
    days_remaining: diffDays,
    expired,
    label: expired
      ? `expirou em ${expiresAt.toLocaleDateString("pt-BR")}`
      : `expira em ${expiresAt.toLocaleDateString("pt-BR")}`,
    helper: expired
      ? `${Math.abs(diffDays)} dia(s) apos a janela de 60 dias`
      : `faltam ${diffDays} dia(s)`,
  };
}

function makeOverviewCacheKey({ stateKey, page, pageSize }) {
  return `reputacao:overview:v${OVERVIEW_CACHE_VERSION}:${stateKey}:page:${page}:size:${pageSize}`;
}

function makeDatasetCacheKey({ stateKey }) {
  return `reputacao:dataset:${stateKey}`;
}

async function fetchReasonLabel(reasonId, state) {
  if (!reasonId || reasonId === "-") return "Por outros motivos";
  const cacheKey = `reputacao:reason:${reasonId}`;
  const cached = simpleCache.get(cacheKey);
  if (cached) return cached;

  const resp = await fetchJsonWithFallbacks(
    [
      `/claims/reasons/${reasonId}`,
      `/post-purchase/v1/claims/reasons/${reasonId}`,
    ],
    state,
    { soft: true }
  );

  const label = pickReasonLabel(resp.data || {}, reasonId);
  simpleCache.set(cacheKey, label, REASON_TTL_SEC);
  return label;
}

async function fetchItemSummary(itemId, state) {
  const id = String(itemId || "").trim();
  if (!/^ML[A-Z]\d+/i.test(id)) return null;
  const cacheKey = `reputacao:item:${id}`;
  const cached = simpleCache.get(cacheKey);
  if (cached) return cached;

  const resp = await fetchJsonWithFallbacks([`/items/${encodeURIComponent(id)}`], state, { soft: true });
  if (!resp.ok || !resp.data) return null;
  const item = resp.data || {};
  const summary = {
    item_id: item.id || id,
    title: item.title || "",
    thumbnail: item.secure_thumbnail || item.thumbnail || null,
    permalink: item.permalink || null,
  };
  simpleCache.set(cacheKey, summary, REASON_TTL_SEC);
  return summary;
}

function isoAtBrazilBoundary(dateValue, mode = "start") {
  const d = dateValue ? new Date(dateValue) : new Date();
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return mode === "end"
    ? `${y}-${m}-${day}T23:59:59.999-03:00`
    : `${y}-${m}-${day}T00:00:00.000-03:00`;
}

function subtractDays(days = 0) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - Number(days || 0));
  return d;
}

function dateKeySaoPaulo(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

function addDays(dateValue, days = 0) {
  const d = new Date(dateValue);
  d.setDate(d.getDate() + Number(days || 0));
  return d;
}

function numberOrZero(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}

function orderItems(order = {}) {
  return Array.isArray(order?.order_items) ? order.order_items : [];
}

function getOrderRevenue(order = {}) {
  const itemsRevenue = orderItems(order).reduce((sum, item) => {
    const qty = numberOrZero(item?.quantity) || 1;
    const unitPrice =
      numberOrZero(item?.unit_price) ||
      numberOrZero(item?.full_unit_price) ||
      numberOrZero(item?.gross_price);
    return sum + unitPrice * qty;
  }, 0);
  if (itemsRevenue > 0) return itemsRevenue;

  return (
    numberOrZero(order?.total_amount) ||
    numberOrZero(order?.paid_amount) ||
    numberOrZero(order?.payments?.[0]?.total_paid_amount)
  );
}

function buildSalesDailySeries({ fromDate, toDate, orders }) {
  const countByDate = new Map();
  const revenueByDate = new Map();
  for (const order of orders || []) {
    const key = dateKeySaoPaulo(order?.date_created || order?.date_closed || order?.date_last_updated);
    if (!key) continue;
    countByDate.set(key, Number(countByDate.get(key) || 0) + 1);
    revenueByDate.set(key, Number(revenueByDate.get(key) || 0) + getOrderRevenue(order));
  }

  const series = [];
  for (let cursor = new Date(fromDate); cursor <= toDate; cursor = addDays(cursor, 1)) {
    const key = dateKeySaoPaulo(cursor);
    if (!key) continue;
    series.push({
      date: key,
      sales: Number(countByDate.get(key) || 0),
      revenue: Number(Number(revenueByDate.get(key) || 0).toFixed(2)),
    });
  }
  return series;
}

function normalizePowerSellerStatus(value) {
  const text = lower(value);
  if (text.includes("platinum")) return "platinum";
  if (text.includes("gold")) return "gold";
  if (text.includes("silver") || text.includes("mercadolider") || text.includes("leader")) return "silver";
  return null;
}

function buildPowerSellerGoals(currentStatus) {
  const currentKey = normalizePowerSellerStatus(currentStatus);
  const currentIndex = currentKey ? POWER_SELLER_ORDER.indexOf(currentKey) : -1;
  const nextKey =
    currentIndex >= 0 && currentIndex < POWER_SELLER_ORDER.length - 1
      ? POWER_SELLER_ORDER[currentIndex + 1]
      : currentIndex < 0
        ? "silver"
        : currentKey;

  return {
    current_key: currentKey,
    current_label: currentKey ? POWER_SELLER_TIERS[currentKey]?.label || currentKey : "Sem medalha",
    next_key: nextKey,
    next_label: POWER_SELLER_TIERS[nextKey]?.label || "MercadoLider",
    tiers: POWER_SELLER_ORDER.map((key) => POWER_SELLER_TIERS[key]),
  };
}

function summarizeSalesWindow({ fromDate, toDate, orders, totalAvailable = 0, capped = false, source = "orders/search" }) {
  const unique = [];
  const seen = new Set();
  for (const order of orders || []) {
    const id = String(order?.id || "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    unique.push(order);
  }

  const daily = buildSalesDailySeries({ fromDate, toDate, orders: unique });
  const fetched = unique.length;
  const available = Math.max(Number(totalAvailable || 0), fetched);
  const days = SALES_WINDOW_DAYS;
  const current = capped ? available : fetched;
  const revenue = unique.reduce((sum, order) => sum + getOrderRevenue(order), 0);
  const last7 = daily.slice(-7).reduce((sum, row) => sum + Number(row.sales || 0), 0);
  const previous7 = daily.slice(-14, -7).reduce((sum, row) => sum + Number(row.sales || 0), 0);
  const revenueLast7 = daily.slice(-7).reduce((sum, row) => sum + Number(row.revenue || 0), 0);
  const revenuePrevious7 = daily.slice(-14, -7).reduce((sum, row) => sum + Number(row.revenue || 0), 0);
  const trend = trendFromCounts(last7, previous7);
  const revenueTrend = trendFromCounts(revenueLast7, revenuePrevious7);
  const dailyAverage = current / days;
  const dailyRevenueAverage = revenue / days;
  const forecastHorizons = [7, 15, 30].map((horizon) => {
    const daysToReplace = Math.min(days, horizon);
    const keptSales = daily
      .slice(daysToReplace)
      .reduce((sum, row) => sum + Number(row.sales || 0), 0);
    const keptRevenue = daily
      .slice(daysToReplace)
      .reduce((sum, row) => sum + Number(row.revenue || 0), 0);
    const incomingSales = dailyAverage * daysToReplace;
    const incomingRevenue = dailyRevenueAverage * daysToReplace;
    const projected = Math.round(keptSales + incomingSales);
    const projectedRevenue = Number((keptRevenue + incomingRevenue).toFixed(2));
    return {
      days_ahead: horizon,
      projected_orders_count: projected,
      delta_orders_count: projected - current,
      projected_revenue: projectedRevenue,
      delta_revenue: Number((projectedRevenue - revenue).toFixed(2)),
    };
  });

  return {
    days,
    from: isoAtBrazilBoundary(fromDate, "start"),
    to: isoAtBrazilBoundary(toDate, "end"),
    orders_count: current,
    fetched_orders_count: fetched,
    total_available: available,
    revenue: Number(revenue.toFixed(2)),
    capped,
    daily_average: Number(dailyAverage.toFixed(2)),
    daily_revenue_average: Number(dailyRevenueAverage.toFixed(2)),
    current_7d_count: last7,
    previous_7d_count: previous7,
    delta_7d_pct: trend.value,
    delta_7d_label: trend.label,
    current_7d_revenue: Number(revenueLast7.toFixed(2)),
    previous_7d_revenue: Number(revenuePrevious7.toFixed(2)),
    revenue_delta_7d_pct: revenueTrend.value,
    revenue_delta_7d_label: revenueTrend.label,
    source,
    date_field: "order.date_created",
    status: "paid",
    forecast: forecastHorizons,
    daily,
  };
}

function isOnOrAfter(dateValue, threshold) {
  if (!dateValue || !threshold) return false;
  const d = new Date(dateValue);
  if (Number.isNaN(d.getTime())) return false;
  return d.getTime() >= threshold.getTime();
}

function normalizeTags(payload = {}) {
  const raw = [
    ...(Array.isArray(payload?.tags) ? payload.tags : []),
    ...(Array.isArray(payload?.claim_tags) ? payload.claim_tags : []),
    ...(Array.isArray(payload?.flags) ? payload.flags : []),
    ...(Array.isArray(payload?.reputation?.tags) ? payload.reputation.tags : []),
  ];
  return raw.map((tag) => lower(tag)).filter(Boolean);
}

function hasAvoidReputationTag(payload = {}) {
  return normalizeTags(payload).includes("avoid_reputation");
}

function getAffectsReputationValue(payload = {}) {
  if (typeof payload === "boolean" || typeof payload === "number") {
    return payload === true || payload === 1 ? "affected" : "not_affected";
  }

  const raw =
    payload?.affects_reputation ??
    payload?.data?.affects_reputation ??
    payload?.affected ??
    payload?.data?.affected ??
    payload?.reputation?.affects_reputation ??
    payload?.reputation_affect ??
    payload?.reputation_status ??
    payload?.affectsReputation ??
    "";

  if (raw === true || raw === 1) return "affected";
  if (raw === false || raw === 0) return "not_affected";

  const value = lower(raw);
  if (!value) return "unknown";
  if (["affected", "true", "yes", "applies"].includes(value)) return "affected";
  if (["not_affected", "not-affected", "false", "no"].includes(value)) return "not_affected";
  if (["not_applies", "not-applies", "not_apply", "notapply", "n/a"].includes(value)) return "not_applies";
  return value;
}

function getClaimStageBucket(payload = {}) {
  const stage = lower(payload?.stage || payload?.claim_stage || payload?.type || payload?.classification || "");
  if (stage.includes("dispute") || stage.includes("mediation") || stage.includes("mediacion") || stage.includes("mediacao")) {
    return "mediations";
  }
  return "claims";
}

function getClaimOrderId(payload = {}) {
  return (
    payload?.order_id ||
    payload?.resource_id ||
    payload?.resourceId ||
    payload?.related_entities?.order_id ||
    payload?.relatedEntities?.order_id ||
    null
  );
}

function parseCasesDate(payload = {}) {
  return (
    payload?.date_created ||
    payload?.date_closed ||
    payload?.last_updated ||
    payload?.date_last_updated ||
    payload?.closed_date ||
    null
  );
}

function isStrictClaimImpactCase(item = {}, rawClaim = {}) {
  if (item.impact_bucket !== "claims") return false;
  if (hasAvoidReputationTag(rawClaim) || hasAvoidReputationTag(item)) return false;
  return item.affects_reputation === "affected";
}

function isFallbackClaimImpactCase(item = {}, rawClaim = {}) {
  if (item.impact_bucket !== "claims") return false;
  if (hasAvoidReputationTag(rawClaim) || hasAvoidReputationTag(item)) return false;
  return !["not_affected", "not_applies"].includes(item.affects_reputation);
}

function isCurrentReputationImpact(item = {}, rawClaim = {}) {
  const date = parseCasesDate(item) || item.created_at || item.last_updated;
  if (!date) return false;

  const expiration = item.expires_at ? new Date(item.expires_at) : new Date(new Date(date).getTime() + 60 * 24 * 60 * 60 * 1000);
  if (Number.isNaN(expiration.getTime()) || expiration.getTime() < Date.now()) return false;
  if (hasAvoidReputationTag(rawClaim) || hasAvoidReputationTag(item)) return false;

  const reputationStatus = getAffectsReputationValue(item);
  return !["not_affected", "not_applies"].includes(reputationStatus);
}

function selectOfficialImpactCases(cases = [], metrics = {}) {
  const officialCounts = {
    claims: Math.max(0, Math.floor(metricExplicitAmount(metrics?.claims))),
    mediations: Math.max(0, Math.floor(metricExplicitAmount(metrics?.disputes))),
  };
  const output = [];

  for (const bucket of ["claims", "mediations"]) {
    const rows = uniqueCasesByIdentity(
      cases.filter((item) => resolveImpactBucketFromCase(item) === bucket)
    ).sort((a, b) => {
      const affectedDiff = Number(getAffectsReputationValue(b) === "affected") - Number(getAffectsReputationValue(a) === "affected");
      if (affectedDiff) return affectedDiff;
      return new Date(parseCasesDate(b) || 0).getTime() - new Date(parseCasesDate(a) || 0).getTime();
    });
    const officialCount = officialCounts[bucket];
    output.push(...(officialCount > 0 ? rows.slice(0, officialCount) : rows.filter((item) => getAffectsReputationValue(item) === "affected")));
  }

  return output.sort((a, b) => {
    const da = new Date(parseCasesDate(a) || a.created_at || a.last_updated || 0).getTime();
    const db = new Date(parseCasesDate(b) || b.created_at || b.last_updated || 0).getTime();
    return db - da;
  });
}

async function fetchClaimsWindow(state, { sellerId, limit = 50, maxPages = 8 } = {}) {
  const warnings = [];
  const found = [];
  const seen = new Set();
  let total = 0;
  let anyOk = false;

  for (let page = 0; page < maxPages; page += 1) {
    const offset = page * limit;
    const resp = await fetchClaimsSearch(state, { sellerId, limit, offset });
    if (!resp.ok) {
      warnings.push(...(resp.warnings || []));
      if (!page) {
        return {
          ok: false,
          warnings,
          data: [],
          paging: { total: 0, offset: 0, limit },
        };
      }
      break;
    }

    anyOk = true;
    if (Array.isArray(resp.warnings) && resp.warnings.length) warnings.push(...resp.warnings);

    const rows = Array.isArray(resp.data) ? resp.data : [];
    total = Math.max(total, Number(resp.paging?.total || 0), rows.length + offset);

    for (const row of rows) {
      const id = row?.id || row?.resource_id || row?.claim_id;
      if (!id || seen.has(String(id))) continue;
      seen.add(String(id));
      found.push(row);
    }

    if (!rows.length) break;
    if (rows.length < limit) break;
    if (total && found.length >= total) break;
  }

  return {
    ok: anyOk,
    warnings,
    data: found,
    paging: {
      total: total || found.length,
      offset: 0,
      limit,
    },
  };
}

async function fetchOrderDetail(orderId, state) {
  if (!orderId) return { ok: false, data: null };
  return fetchJsonWithFallbacks([`/orders/${orderId}`], state, { soft: true });
}

async function hydrateClaimCase(rawClaim, { sellerId, state, warnings }) {
  const claimId = rawClaim?.id || rawClaim?.claim_id;
  const orderId = getClaimOrderId(rawClaim);

  const detailResp = claimId
    ? await fetchJsonWithFallbacks(
        [
          `/post-purchase/v1/claims/${claimId}/detail`,
          `/post-purchase/v1/claims/${claimId}`,
          `/claims/${claimId}`,
        ],
        state,
        { soft: true }
      )
    : { ok: false, data: null };

  const detail = detailResp.data || rawClaim || {};
  const reputationResp = claimId
    ? await fetchJsonWithFallbacks(
        [`/post-purchase/v1/claims/${claimId}/affects-reputation`],
        state,
        { soft: true }
      )
    : { ok: false, data: null };
  const orderResp = orderId ? await fetchOrderDetail(orderId, state) : { ok: false, data: null };
  const order = orderResp.data || {};
  const packId = order?.pack_id || detail?.related_entities?.pack_id || detail?.pack_id || null;

  const reasonId =
    detail?.reason_id ||
    detail?.reason?.id ||
    rawClaim?.reason_id ||
    rawClaim?.reason?.id ||
    rawClaim?.reason ||
    null;

  const categoryLabel = await fetchReasonLabel(reasonId, state);

  const item = summarizeClaim({
    claim: rawClaim,
    detail,
    order,
    categoryLabel,
  });

  item.case_kind = "claim";
  item.sale_date = order?.date_created || order?.date_closed || null;
  item.case_kind_label = "Reclamacao";
  item.impact_bucket = getClaimStageBucket(detail);
  const officialReputationStatus = getAffectsReputationValue(reputationResp.data);
  item.affects_reputation =
    officialReputationStatus !== "unknown"
      ? officialReputationStatus
      : getAffectsReputationValue(detail || rawClaim);
  item.display_id = String(item.id || claimId || "-");
  item.sources = compact({
    claim: claimId || null,
    order: orderId || null,
    pack: packId || null,
    detail_loaded: detailResp.ok,
    reputation_loaded: reputationResp.ok,
  });

  return item;
}

async function hydrateCurrentClaimImpacts(rawClaims = [], { sellerId, state, warnings }) {
  const reputationWindowStart = subtractDays(60);
  const candidates = rawClaims
    .map((rawClaim) => ({ rawClaim, light: summarizeRawClaimLight(rawClaim) }))
    .filter(({ rawClaim, light }) => {
      const date = parseCasesDate(light) || light.created_at || light.last_updated;
      return date && isOnOrAfter(date, reputationWindowStart) && !hasAvoidReputationTag(rawClaim) && !hasAvoidReputationTag(light);
    });

  const hydrated = [];
  const batchSize = 6;

  for (let index = 0; index < candidates.length; index += batchSize) {
    const batch = candidates.slice(index, index + batchSize);
    const rows = await Promise.all(
      batch.map(async ({ rawClaim, light }) => {
        try {
          const item = await hydrateClaimCase(rawClaim, { sellerId, state, warnings });
          return isCurrentReputationImpact(item, rawClaim) ? item : null;
        } catch (error) {
          warnings.push(`Falha ao confirmar impacto da claim ${rawClaim?.id || rawClaim?.resource_id || "-"}: ${error?.message || error}`);
          return isCurrentReputationImpact(light, rawClaim) ? light : null;
        }
      })
    );
    hydrated.push(...rows.filter(Boolean));
  }

  return hydrated.sort((a, b) => {
    const da = new Date(a.created_at || a.last_updated || 0).getTime();
    const db = new Date(b.created_at || b.last_updated || 0).getTime();
    return db - da;
  });
}

function getFirstOrderItem(order = {}) {
  return Array.isArray(order?.order_items) ? order.order_items[0] || null : null;
}

function pickCancellationReason(order = {}) {
  const candidates = [
    order?.cancel_detail,
    order?.cancel_details,
    order?.status_detail,
    order?.status_detail?.description,
    order?.feedback?.sale?.detail,
    order?.feedback?.sale?.rating,
    order?.feedback?.sale?.fulfillment,
    order?.feedback?.sale?.fulfilled,
  ];

  const found = candidates.find(Boolean);
  if (!found) return "Cancelada por voce";
  if (typeof found === "string") return found;
  return found?.description || found?.reason || found?.status || "Cancelada por voce";
}

function summarizeCancellation(order = {}) {
  const orderItem = getFirstOrderItem(order);
  const eventDate =
    order?.date_closed ||
    order?.date_last_updated ||
    order?.last_updated ||
    order?.date_created ||
    null;
  const expiration = computeExpiration(eventDate);
  const reason = pickCancellationReason(order);

  return {
    id: `cancel-${order?.id || "sem-pedido"}`,
    display_id: String(order?.id || "-"),
    resource_id: order?.id || null,
    order_id: order?.id || "-",
    pack_id: order?.pack_id || null,
    item_id: orderItem?.item?.id || orderItem?.item?.item_id || "-",
    item_title: orderItem?.item?.title || order?.shipping?.receiver_address?.comment || "-",
    status: lower(order?.status || "cancelled") || "cancelled",
    stage: "cancellation",
    reason_id: reason,
    category_label: "Canceladas por voce",
    type: "seller_cancellation",
    created_at: eventDate,
    impact_date: expiration.impact_date,
    expires_at: expiration.expires_at,
    expires_in_days: expiration.days_remaining,
    is_expired: expiration.expired,
    expiration_label: expiration.label,
    expiration_helper: expiration.helper,
    last_updated: order?.date_last_updated || order?.last_updated || eventDate,
    amount: order?.total_amount || order?.paid_amount || null,
    currency_id: order?.currency_id || "BRL",
    seller_messages: 0,
    seller_messages_probable: 0,
    buyer_messages: 0,
    buyer_messages_probable: 0,
    messages_total: 0,
    nossa_interacao: false,
    nossa_interacao_provavel: false,
    contato_iniciado: false,
    contato_iniciado_por_volume: false,
    finalizada: true,
    em_mediacao: false,
    aguardando_comprador: false,
    elegivel: false,
    eligibility_code: "seller_cancellation",
    eligibility_label: "cancelamento concluido",
    eligibility_helper: "sem claim associada",
    eligibility_tone: "orange",
    last_message_from: "nao identificada",
    last_message_confidence: "indefinida",
    last_message_source: "order",
    last_message_at: null,
    context_excerpt: `Pedido cancelado no fluxo de vendas. Motivo retornado: ${String(reason || "nao informado").trim()}.`,
    message_state_label: "sem mensagens",
    message_state_tone: "gray",
    last_interaction_label: "ultima: origem nao identificada",
    status_badges: {
      finalizada: true,
      em_mediacao: false,
    },
    marketplace_link: order?.id ? `https://www.mercadolivre.com.br/vendas/${order.id}/detail` : null,
    case_kind: "cancellation",
    case_kind_label: "Cancelamento",
    impact_bucket: "cancellations",
    affects_reputation: "affected",
    sources: compact({
      order: order?.id || null,
      pack: order?.pack_id || null,
    }),
  };
}

async function fetchCancelledOrdersWindow({ sellerId, state, fromDate, toDate, maxPages = 8 }) {
  const statuses = ["cancelled"];
  const found = [];
  const seen = new Set();
  const warnings = [];
  const limit = 50;

  for (const status of statuses) {
    for (let page = 0; page < maxPages; page += 1) {
      const offset = page * limit;
      const qs = new URLSearchParams();
      qs.set("seller", String(sellerId));
      qs.set("order.status", status);
      qs.set("order.date_closed.from", isoAtBrazilBoundary(fromDate, "start"));
      qs.set("order.date_closed.to", isoAtBrazilBoundary(toDate, "end"));
      qs.set("sort", "date_desc");
      qs.set("limit", String(limit));
      qs.set("offset", String(offset));

      const resp = await fetchJsonWithFallbacks([`/orders/search?${qs.toString()}`], state, { soft: true });
      if (!resp.ok) {
        warnings.push(resp.error?.message || `Falha ao consultar pedidos ${status}.`);
        break;
      }

      const rows = normalizeArray(resp.data);
      for (const row of rows) {
        const orderId = row?.id;
        if (!orderId || seen.has(String(orderId))) continue;
        seen.add(String(orderId));
        found.push(row);
      }

      const total = Number(resp.data?.paging?.total || 0);
      if (!rows.length) break;
      if (rows.length < limit) break;
      if (total && offset + rows.length >= total) break;
    }
  }

  found.sort((a, b) => {
    const da = new Date(parseCasesDate(a) || 0).getTime();
    const db = new Date(parseCasesDate(b) || 0).getTime();
    return db - da;
  });

  return { orders: found, warnings };
}

async function fetchPaidSalesWindow({ sellerId, state, fromDate, toDate, hardCap = SALES_WINDOW_HARD_CAP }) {
  const found = [];
  const seen = new Set();
  const warnings = [];
  const limit = 50;
  let totalAvailable = 0;

  for (let offset = 0; offset < hardCap; offset += limit) {
    const qs = new URLSearchParams();
    qs.set("seller", String(sellerId));
    qs.set("order.status", "paid");
    qs.set("order.date_created.from", isoAtBrazilBoundary(fromDate, "start"));
    qs.set("order.date_created.to", isoAtBrazilBoundary(toDate, "end"));
    qs.set("sort", "date_desc");
    qs.set("limit", String(limit));
    qs.set("offset", String(offset));

    const fallbackQs = new URLSearchParams(qs);
    fallbackQs.delete("order.date_created.from");
    fallbackQs.delete("order.date_created.to");
    fallbackQs.set("date_created.from", isoAtBrazilBoundary(fromDate, "start"));
    fallbackQs.set("date_created.to", isoAtBrazilBoundary(toDate, "end"));

    const resp = await fetchJsonWithFallbacks(
      [`/orders/search?${qs.toString()}`, `/orders/search?${fallbackQs.toString()}`],
      state,
      { soft: true },
    );
    if (!resp.ok) {
      warnings.push(resp.error?.message || "Falha ao consultar vendas pagas em orders/search.");
      break;
    }

    const rows = normalizeArray(resp.data);
    totalAvailable = Math.max(totalAvailable, Number(resp.data?.paging?.total || 0), offset + rows.length);
    for (const row of rows) {
      const orderId = row?.id;
      if (!orderId || seen.has(String(orderId))) continue;
      seen.add(String(orderId));
      found.push(row);
    }

    if (!rows.length) break;
    if (rows.length < limit) break;
    if (totalAvailable && offset + rows.length >= totalAvailable) break;
  }

  const capped = totalAvailable > found.length && found.length >= hardCap;
  return {
    salesWindow: summarizeSalesWindow({
      fromDate,
      toDate,
      orders: found,
      totalAvailable,
      capped,
    }),
    warnings,
  };
}

class ReputacaoService {
  static async obterVisaoGeral(options = {}) {
    const pageSize = Math.max(1, Math.min(MAX_PAGE_SIZE, Number(options.pageSize || options.limit || MAX_PAGE_SIZE)));
    const page = Math.max(1, Number(options.page || 1));
    const forceRefresh = [true, "true", 1, "1"].includes(options.forceRefresh);

    const state = await prepareAuthState(options);
    const cacheKey = makeOverviewCacheKey({ stateKey: state.key, page, pageSize });
    if (!forceRefresh) {
      const cached = simpleCache.get(cacheKey);
      if (cached) return cached;
    }

    const meResp = await fetchJsonWithFallbacks(["/users/me"], state);
    const me = meResp.data || {};
    const sellerId = me?.id;

    const warnings = [];

    const userResp = await fetchJsonWithFallbacks([`/users/${sellerId}`], state, { soft: true });
    if (!userResp.ok) warnings.push(`Nao foi possivel carregar seller_reputation: ${userResp.error?.message || "erro"}`);
    const user = userResp.data || me || {};

    const sellerReputation = user?.seller_reputation || me?.seller_reputation || {};
    const tier = getSellerTier(sellerReputation);
    const limits = LIMITS_BY_TIER[tier] || LIMITS_BY_TIER.default;
    const metrics = sellerReputation?.metrics || null;
    const claimsResp = await fetchClaimsWindow(state, { sellerId, limit: 50, maxPages: 4 });
    if (!claimsResp.ok) {
      warnings.push(
        "Nao foi possivel consultar claims. Verifique se a aplicacao tem o produto Post Purchase habilitado e se a conta possui acesso as APIs de reclamacoes."
      );
    }
    if (Array.isArray(claimsResp.warnings) && claimsResp.warnings.length && !claimsResp.data?.length) {
      warnings.push(`Tentativas de claims: ${claimsResp.warnings.slice(0, 2).join(" | ")}`);
    }

    const rawClaims = Array.isArray(claimsResp.data) ? claimsResp.data : [];
    const hydratedImpacts = await hydrateCurrentClaimImpacts(rawClaims, { sellerId, state, warnings });
    const allImpacts = selectOfficialImpactCases(hydratedImpacts, metrics);
    const fallbackClaimCases = buildFallbackClaimCases(rawClaims, metrics);
    const salesWindowFrom = subtractDays(SALES_WINDOW_DAYS);
    const salesWindowTo = new Date();
    const salesResp = await fetchPaidSalesWindow({
      sellerId,
      state,
      fromDate: salesWindowFrom,
      toDate: salesWindowTo,
    });
    if (Array.isArray(salesResp.warnings) && salesResp.warnings.length) warnings.push(...salesResp.warnings);
    const salesWindow = salesResp.salesWindow || summarizeSalesWindow({
      fromDate: salesWindowFrom,
      toDate: salesWindowTo,
      orders: [],
      source: "orders/search",
    });
    const powerSellerGoals = buildPowerSellerGoals(sellerReputation?.power_seller_status);

    const exposure = {
      unhealthy: { total: 0, items: [] },
      warning: { total: 0, items: [] },
    };
    const sellerNickname = me?.nickname || user?.nickname || "-";
    let intelligence = await buildReputationIntelligence({
      sellerId,
      sellerNickname,
      sellerReputation,
      limits,
      metrics,
      cases: allImpacts,
      fallbackClaimCases,
      salesWindow,
      state,
    });
    const snapshots = await fetchReputationSnapshots({ state, sellerId });
    intelligence = applySnapshotHistory(intelligence, snapshots);
    await saveReputationSnapshot({ state, sellerId, intelligence });

    const total = allImpacts.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const safePage = Math.min(Math.max(1, page), totalPages);
    const offset = (safePage - 1) * pageSize;
    const cases = allImpacts.slice(offset, offset + pageSize);

    const overview = {
      seller: {
        id: sellerId || null,
        nickname: sellerNickname,
        reputation_level_id: sellerReputation?.level_id || null,
        power_seller_status: sellerReputation?.power_seller_status || null,
        transactions: sellerReputation?.transactions || null,
        sales_window: salesWindow,
        power_seller_goals: powerSellerGoals,
        metrics,
        tier,
        limits,
        limit_labels: {
          claims: `Proximo de ${String(limits.claims).replace('.', ',')}% permitido`,
          mediations: `Abaixo de ${String(limits.mediations).replace('.', ',')}% permitido`,
          cancellations: `Abaixo de ${String(limits.cancellations).replace('.', ',')}% permitido`,
          delayed: `Abaixo de ${String(limits.delayed).replace('.', ',')}% permitido`,
        },
        metric_cards: {
          claims: {
            value: metricValue(metrics?.claims),
            count: Math.max(
              metricAmount(metrics?.claims),
              allImpacts.filter((item) => resolveImpactBucketFromCase(item) === "claims").length
            ),
            limit: limits.claims,
          },
          mediations: {
            value: metricValue(metrics?.disputes),
            count: Math.max(
              metricAmount(metrics?.disputes),
              allImpacts.filter((item) => resolveImpactBucketFromCase(item) === "mediations").length
            ),
            limit: limits.mediations,
          },
          cancellations: {
            value: metricValue(metrics?.cancellations),
            count: Math.max(
              metricAmount(metrics?.cancellations),
              allImpacts.filter((item) => resolveImpactBucketFromCase(item) === "cancellations").length
            ),
            limit: limits.cancellations,
          },
          delayed: {
            value: metricValue(metrics?.delayed_handling_time),
            count: Math.max(
              metricAmount(metrics?.delayed_handling_time),
              allImpacts.filter((item) => resolveImpactBucketFromCase(item) === "delayed").length
            ),
            limit: limits.delayed,
          },
        },
      },
      exposure,
      sales_window: salesWindow,
      power_seller_goals: powerSellerGoals,
      intelligence,
      warnings: Array.from(new Set(warnings.filter(Boolean))),
      cases,
      all_cases: allImpacts,
      pagination: {
        page: safePage,
        pageSize,
        total,
        totalPages,
        hasPrev: safePage > 1,
        hasNext: safePage < totalPages,
        from: total ? offset + 1 : 0,
        to: total ? Math.min(offset + cases.length, total) : 0,
      },
      cache: {
        ttlSec: OVERVIEW_TTL_SEC,
        cacheKey,
      },
    };

    simpleCache.set(cacheKey, overview, OVERVIEW_TTL_SEC);
    return overview;
  }
}

module.exports = ReputacaoService;


