"use strict";

const fetch = require("node-fetch");
const db = require("../db/db");
const simpleCache = require("./simpleCache");
const ProductAdsService = require("./productAdsService");

const TZ = "America/Sao_Paulo";
const HISTORY_DAYS = 7;
const REFRESH_TTL_SEC = 60 * 10;
const NEAR_LIMIT_RATIO = 0.8;

const LIMITS_BY_TIER = {
  green: { claims: 2.0, mediations: 0.5, cancellations: 1.5, delayed: 10.0 },
  leader: { claims: 1.0, mediations: 0.5, cancellations: 0.5, delayed: 6.0 },
  gold: { claims: 1.0, mediations: 0.5, cancellations: 0.5, delayed: 6.0 },
  platinum: { claims: 1.0, mediations: 0.5, cancellations: 0.5, delayed: 6.0 },
  default: { claims: 2.0, mediations: 0.5, cancellations: 1.5, delayed: 10.0 },
};

const REPUTATION_METRIC_META = {
  claims: { label: "reclamacoes", limitLabel: "de reclamacoes" },
  mediations: { label: "mediacoes", limitLabel: "de mediacoes" },
  cancellations: { label: "cancelamentos", limitLabel: "de cancelamentos" },
  delayed: { label: "atrasos", limitLabel: "de atrasos no envio" },
};

function numberOrZero(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function zonedDateParts(date = new Date(), timeZone = TZ) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = formatter.formatToParts(date);
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
  };
}

function todayISO() {
  const { year, month, day } = zonedDateParts();
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

function parseISODate(value) {
  const [y, m, d] = String(value || "")
    .split("-")
    .map((part) => Number(part));
  return new Date(y, (m || 1) - 1, d || 1);
}

function addDays(value, amount) {
  const date = parseISODate(value);
  date.setDate(date.getDate() + amount);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function startOfMonthISO(value) {
  const date = parseISODate(value);
  date.setDate(1);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function addMonths(value, amount) {
  const date = parseISODate(value);
  const day = date.getDate();
  date.setDate(1);
  date.setMonth(date.getMonth() + amount);
  const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  date.setDate(Math.min(day, lastDay));
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function normalizeDateValue(value) {
  if (!value) return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return value.toISOString().slice(0, 10);
  }

  const text = String(value).trim();
  if (!text) return null;

  const isoMatch = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) {
    return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
  }

  const brMatch = text.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (brMatch) {
    return `${brMatch[3]}-${brMatch[2]}-${brMatch[1]}`;
  }

  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

function normalizeDateTimeValue(value) {
  if (!value) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }

  const text = String(value).trim();
  if (!text) return null;

  const parsed = new Date(text);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toISOString();
  }

  const normalizedDate = normalizeDateValue(text);
  return normalizedDate ? `${normalizedDate}T00:00:00.000Z` : null;
}

function lower(value) {
  return String(value || "").trim().toLowerCase();
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
  if (typeof metric?.value === "number" && typeof metric?.rate !== "number") {
    return normalizeMetricPercent(metric.value);
  }
  return 0;
}

function getSellerTier(sellerReputation = {}) {
  const medal = lower(sellerReputation?.power_seller_status);
  const level = lower(sellerReputation?.level_id);

  if (medal.includes("platinum")) return "platinum";
  if (medal.includes("gold")) return "gold";
  if (medal.includes("leader") || medal.includes("lider")) return "leader";
  if (level === "5_green") return "green";
  return "default";
}

async function httpGetJson(url, accessToken, retries = 1) {
  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: "GET",
        headers: {
          accept: "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
      });

      const text = await response.text().catch(() => "");
      const data = text ? JSON.parse(text) : null;

      if (!response.ok) {
        const error = new Error(
          data?.message || data?.error || `HTTP ${response.status}`,
        );
        error.statusCode = response.status;
        throw error;
      }

      return data;
    } catch (error) {
      lastError = error;
      if (attempt < retries) {
        await new Promise((resolve) => setTimeout(resolve, 220 * (attempt + 1)));
      }
    }
  }

  throw lastError;
}

function formatCompactNumber(value, digits = 1) {
  const n = numberOrZero(value);
  return n.toLocaleString("pt-BR", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function formatPercent(value, digits = 1) {
  return `${formatCompactNumber(value, digits)}%`;
}

function formatRoas(value) {
  return `${formatCompactNumber(value, 1)}x`;
}

function buildDeltaPayload(currentValue, previousValue) {
  const current = numberOrZero(currentValue);
  const previous = numberOrZero(previousValue);

  if (previous <= 0) {
    return {
      current,
      previous,
      deltaPct: null,
      direction: current > 0 ? "up" : "flat",
    };
  }

  const raw = ((current - previous) / previous) * 100;
  const deltaPct = Number(raw.toFixed(1));
  return {
    current,
    previous,
    deltaPct,
    direction: deltaPct > 0 ? "up" : deltaPct < 0 ? "down" : "flat",
  };
}

async function cleanupExpiredRows() {
  await db.query(
    `
      DELETE FROM notificacoes
       WHERE criada_em < (now() - interval '7 days')
    `,
  );
}

async function fetchExistingNotifications({ userId, accountId }) {
  await cleanupExpiredRows();

  const result = await db.query(
    `
      SELECT
        id,
        tipo,
        data_referencia,
        titulo,
        mensagem,
        payload_json,
        lida_em,
        criada_em,
        atualizada_em
      FROM notificacoes
      WHERE usuario_id = $1
        AND meli_conta_id = $2
      ORDER BY data_referencia DESC, criada_em DESC, id DESC
      LIMIT 80
    `,
    [userId, accountId],
  );

  return result.rows.map((row) => ({
    id: row.id,
    type: row.tipo,
    reference_date: normalizeDateValue(row.data_referencia),
    title: row.titulo,
    message: row.mensagem,
    payload: row.payload_json || {},
    read_at: normalizeDateTimeValue(row.lida_em),
    created_at: normalizeDateTimeValue(row.criada_em),
    updated_at: normalizeDateTimeValue(row.atualizada_em),
    unread: !row.lida_em,
  }));
}

async function upsertNotification({
  userId,
  companyId,
  accountId,
  type,
  referenceDate,
  title,
  message,
  payload,
}) {
  await db.query(
    `
      INSERT INTO notificacoes (
        usuario_id,
        empresa_id,
        meli_conta_id,
        tipo,
        data_referencia,
        titulo,
        mensagem,
        payload_json,
        atualizada_em
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, now())
      ON CONFLICT (usuario_id, meli_conta_id, tipo, data_referencia)
      DO UPDATE
         SET titulo = EXCLUDED.titulo,
             mensagem = EXCLUDED.mensagem,
             payload_json = EXCLUDED.payload_json,
             atualizada_em = now()
    `,
    [
      userId,
      companyId || null,
      accountId,
      type,
      referenceDate,
      title,
      message,
      JSON.stringify(payload || {}),
    ],
  );
}

async function deleteNotificationByType({
  userId,
  accountId,
  type,
  referenceDate,
}) {
  await db.query(
    `
      DELETE FROM notificacoes
       WHERE usuario_id = $1
         AND meli_conta_id = $2
         AND tipo = $3
         AND data_referencia = $4
    `,
    [userId, accountId, type, referenceDate],
  );
}

async function markAllRead({ userId, accountId }) {
  await db.query(
    `
      UPDATE notificacoes
         SET lida_em = COALESCE(lida_em, now()),
             atualizada_em = now()
       WHERE usuario_id = $1
         AND meli_conta_id = $2
         AND lida_em IS NULL
    `,
    [userId, accountId],
  );
}

function buildRefreshCacheKey({ userId, accountId }) {
  return `notifications:refresh:${userId}:${accountId}`;
}

function mapSeriesByDate(series = []) {
  return new Map(
    series
      .filter((row) => row?.date)
      .map((row) => [String(row.date), row]),
  );
}

function metricRevenue(row = {}) {
  const total = numberOrZero(row.total_amount);
  if (total > 0) return total;
  return numberOrZero(row.direct_amount) + numberOrZero(row.indirect_amount);
}

function metricUnits(row = {}) {
  const units = numberOrZero(row.units_quantity);
  if (units > 0) return units;
  return (
    numberOrZero(row.direct_units_quantity) +
    numberOrZero(row.indirect_units_quantity)
  );
}

function sumAdsSeries(series = []) {
  return series.reduce(
    (acc, row) => {
      acc.clicks += numberOrZero(row.clicks);
      acc.cost += numberOrZero(row.cost);
      acc.revenue += metricRevenue(row);
      acc.units += metricUnits(row);
      return acc;
    },
    { clicks: 0, cost: 0, revenue: 0, units: 0 },
  );
}

async function buildAdsAlerts({ options, userId, companyId, accountId }) {
  const today = todayISO();
  const currentPeriodStart = startOfMonthISO(today);
  const previousPeriodEnd = addMonths(today, -1);
  const previousPeriodStart = startOfMonthISO(previousPeriodEnd);

  const [currentAds, previousAds] = await Promise.all([
    ProductAdsService.metricasDiarias(
      { date_from: currentPeriodStart, date_to: today },
      {
        mlCreds: options.mlCreds,
        accountKey: options.accountKey,
      },
    ),
    ProductAdsService.metricasDiarias(
      { date_from: previousPeriodStart, date_to: previousPeriodEnd },
      {
        mlCreds: options.mlCreds,
        accountKey: options.accountKey,
      },
    ),
  ]);

  if (
    !currentAds?.success ||
    !Array.isArray(currentAds.series) ||
    !previousAds?.success ||
    !Array.isArray(previousAds.series)
  ) {
    return [];
  }

  const currentTotals = sumAdsSeries(currentAds.series);
  const previousTotals = sumAdsSeries(previousAds.series);

  const roasCurrent =
    currentTotals.cost > 0 ? currentTotals.revenue / currentTotals.cost : 0;
  const roasPrevious =
    previousTotals.cost > 0 ? previousTotals.revenue / previousTotals.cost : 0;

  const roasComparable =
    currentTotals.cost > 0 ||
    previousTotals.cost > 0 ||
    currentTotals.revenue > 0 ||
    previousTotals.revenue > 0;

  const conversionCurrent =
    currentTotals.clicks > 0 ? (currentTotals.units / currentTotals.clicks) * 100 : 0;
  const conversionPrevious =
    previousTotals.clicks > 0 ? (previousTotals.units / previousTotals.clicks) * 100 : 0;

  const conversionComparable =
    currentTotals.clicks > 0 ||
    previousTotals.clicks > 0 ||
    currentTotals.units > 0 ||
    previousTotals.units > 0;

  const compareLabel = "mes atual vs mesmo periodo do mes passado";
  const currentRangeLabel = `${currentPeriodStart} a ${today}`;
  const previousRangeLabel = `${previousPeriodStart} a ${previousPeriodEnd}`;

  const alerts = [];

  if (roasComparable) {
    const delta = buildDeltaPayload(roasCurrent, roasPrevious);
    const directionLabel =
      delta.deltaPct == null
        ? "sem base de comparacao"
        : delta.direction === "up"
          ? `alta de ${formatPercent(Math.abs(delta.deltaPct), 1)}`
          : delta.direction === "down"
            ? `queda de ${formatPercent(Math.abs(delta.deltaPct), 1)}`
            : "estavel vs periodo anterior";

    alerts.push({
      type: "roas_delta",
      referenceDate: today,
      title: "ROAS de Ads",
      message:
        delta.deltaPct == null
          ? `Seu ROAS de publicidade acumulado no mes esta em ${formatRoas(delta.current)}. Ainda nao ha base suficiente para comparar com o mesmo periodo do mes passado.`
          : `Seu ROAS de publicidade acumulado no mes esta em ${formatRoas(delta.current)}, com ${directionLabel} vs o mesmo periodo do mes passado.`,
      payload: {
        kind: "delta",
        metric: "roas",
        label: "ROAS",
        compare_label: compareLabel,
        current_value: Number(delta.current.toFixed(2)),
        previous_value: Number(delta.previous.toFixed(2)),
        current_label: formatRoas(delta.current),
        previous_label: formatRoas(delta.previous),
        current_period_label: currentRangeLabel,
        previous_period_label: previousRangeLabel,
        delta_pct: delta.deltaPct,
        direction: delta.direction,
      },
    });
  }

  if (conversionComparable) {
    const delta = buildDeltaPayload(conversionCurrent, conversionPrevious);
    const directionLabel =
      delta.deltaPct == null
        ? "sem base de comparacao"
        : delta.direction === "up"
          ? `alta de ${formatPercent(Math.abs(delta.deltaPct), 1)}`
          : delta.direction === "down"
            ? `queda de ${formatPercent(Math.abs(delta.deltaPct), 1)}`
            : "estavel vs periodo anterior";

    alerts.push({
      type: "conversion_delta",
      referenceDate: today,
      title: "Conversao de Ads",
      message:
        delta.deltaPct == null
          ? `Sua conversao de publicidade acumulada no mes esta em ${formatPercent(delta.current, 2)}. Ainda nao ha base suficiente para comparar com o mesmo periodo do mes passado.`
          : `Sua conversao de publicidade acumulada no mes esta em ${formatPercent(delta.current, 2)}, com ${directionLabel} vs o mesmo periodo do mes passado.`,
      payload: {
        kind: "delta",
        metric: "conversion",
        label: "Conversao",
        compare_label: compareLabel,
        current_value: Number(delta.current.toFixed(4)),
        previous_value: Number(delta.previous.toFixed(4)),
        current_label: formatPercent(delta.current, 2),
        previous_label: formatPercent(delta.previous, 2),
        current_period_label: currentRangeLabel,
        previous_period_label: previousRangeLabel,
        delta_pct: delta.deltaPct,
        direction: delta.direction,
      },
    });
  }

  for (const alert of alerts) {
    await upsertNotification({
      userId,
      companyId,
      accountId,
      type: alert.type,
      referenceDate: alert.referenceDate,
      title: alert.title,
      message: alert.message,
      payload: alert.payload,
    });
  }

  return alerts;
}

async function buildReputationAlerts({
  accessToken,
  userId,
  companyId,
  accountId,
}) {
  const me = await httpGetJson("https://api.mercadolibre.com/users/me", accessToken, 1);
  const sellerId = me?.id;
  if (!sellerId) return [];

  let seller = me;
  try {
    seller = await httpGetJson(
      `https://api.mercadolibre.com/users/${encodeURIComponent(String(sellerId))}`,
      accessToken,
      1,
    );
  } catch {}

  const sellerReputation = seller?.seller_reputation || me?.seller_reputation || {};
  const tier = getSellerTier(sellerReputation);
  const limits = LIMITS_BY_TIER[tier] || LIMITS_BY_TIER.default;
  const metrics = sellerReputation?.metrics || {};
  const today = todayISO();

  const metricCards = {
    claims: { value: metricValue(metrics?.claims), limit: limits.claims },
    mediations: { value: metricValue(metrics?.disputes), limit: limits.mediations },
    cancellations: { value: metricValue(metrics?.cancellations), limit: limits.cancellations },
    delayed: { value: metricValue(metrics?.delayed_handling_time), limit: limits.delayed },
  };

  const activeTypes = new Set();
  const created = [];

  for (const [key, card] of Object.entries(metricCards)) {
    const value = numberOrZero(card.value);
    const limit = numberOrZero(card.limit);
    if (!(limit > 0) || value <= 0) {
      await deleteNotificationByType({
        userId,
        accountId,
        type: `reputation_${key}_limit`,
        referenceDate: today,
      });
      continue;
    }

    const ratio = value / limit;
    if (ratio < NEAR_LIMIT_RATIO) {
      await deleteNotificationByType({
        userId,
        accountId,
        type: `reputation_${key}_limit`,
        referenceDate: today,
      });
      continue;
    }

    const meta = REPUTATION_METRIC_META[key] || {
      label: key,
      limitLabel: `de ${key}`,
    };

    const type = `reputation_${key}_limit`;
    activeTypes.add(type);

    const isOverLimit = ratio > 1;
    const isAtLimit = !isOverLimit && Math.abs(ratio - 1) < 0.0001;
    const title = isOverLimit
      ? "Reputacao acima do limite"
      : isAtLimit
        ? "Reputacao no limite"
        : "Reputacao em atencao";
    const message = isOverLimit
      ? `A metrica ${meta.limitLabel} ultrapassou o limite permitido. Voce esta em ${formatPercent(value, 2)} de ${formatPercent(limit, 2)}.`
      : isAtLimit
        ? `A metrica ${meta.limitLabel} atingiu o limite permitido. Voce esta em ${formatPercent(value, 2)} de ${formatPercent(limit, 2)}.`
        : `Proximo do limite permitido na metrica ${meta.limitLabel}. Voce esta em ${formatPercent(value, 2)} de ${formatPercent(limit, 2)}.`;

    const payload = {
      kind: "limit",
      metric: key,
      label: meta.label,
      current_value: Number(value.toFixed(2)),
      limit_value: Number(limit.toFixed(2)),
      current_label: formatPercent(value, 2),
      limit_label: formatPercent(limit, 2),
      threshold_ratio: Number(ratio.toFixed(4)),
      direction: isOverLimit ? "down" : "warning",
    };

    await upsertNotification({
      userId,
      companyId,
      accountId,
      type,
      referenceDate: today,
      title,
      message,
      payload,
    });

    created.push({ type, referenceDate: today });
  }

  const knownTypes = Object.keys(REPUTATION_METRIC_META).map(
    (key) => `reputation_${key}_limit`,
  );

  for (const type of knownTypes) {
    if (activeTypes.has(type)) continue;
    await deleteNotificationByType({
      userId,
      accountId,
      type,
      referenceDate: today,
    });
  }

  return created;
}

class NotificationsService {
  static async list(options = {}) {
    const userId = numberOrZero(options.userId);
    const accountId = numberOrZero(options.accountId);

    if (!userId || !accountId) {
      return {
        success: false,
        error: "Usuario ou conta nao identificados.",
        items: [],
        unread_count: 0,
      };
    }

    const items = await fetchExistingNotifications({ userId, accountId });
    return {
      success: true,
      items,
      unread_count: items.filter((item) => item.unread).length,
      history_days: HISTORY_DAYS,
      today_iso: todayISO(),
    };
  }

  static async refresh(options = {}) {
    const userId = numberOrZero(options.userId);
    const companyId = numberOrZero(options.companyId);
    const accountId = numberOrZero(options.accountId);
    const force = [true, 1, "1", "true"].includes(options.force);

    if (!userId || !accountId) {
      return {
        success: false,
        error: "Usuario ou conta nao identificados para gerar notificacoes.",
        items: [],
      };
    }

    const refreshCacheKey = buildRefreshCacheKey({ userId, accountId });
    if (!force && simpleCache.get(refreshCacheKey)) {
      return this.list({ userId, accountId });
    }

    const accessToken =
      options.accessToken || options.mlCreds?.access_token || null;
    if (!accessToken) {
      return {
        success: false,
        error: "Token da conta indisponivel para gerar notificacoes.",
        items: [],
      };
    }

    await cleanupExpiredRows();
    await buildAdsAlerts({
      options,
      userId,
      companyId,
      accountId,
    });
    await buildReputationAlerts({
      accessToken,
      userId,
      companyId,
      accountId,
    });

    simpleCache.set(refreshCacheKey, true, REFRESH_TTL_SEC);
    return this.list({ userId, accountId });
  }

  static async markAllRead(options = {}) {
    const userId = numberOrZero(options.userId);
    const accountId = numberOrZero(options.accountId);

    if (!userId || !accountId) {
      return {
        success: false,
        error: "Usuario ou conta nao identificados para leitura.",
      };
    }

    await markAllRead({ userId, accountId });
    return {
      success: true,
      read_all: true,
    };
  }
}

module.exports = NotificationsService;
