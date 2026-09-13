"use strict";

const db = require("../db/db");

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_RECIPIENTS = 10;
const MAX_MLBS = 500;
const MAX_DAILY_REPORTS = 2;
const DEFAULT_TZ = "America/Sao_Paulo";
const COMMERCIAL_ENRICHMENTS = new Set(["visits", "ads"]);

function toInt(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function normalizeText(value, max = 500) {
  return String(value || "").trim().slice(0, max);
}

function normalizeEnum(value, allowed, fallback) {
  const text = normalizeText(value).toLowerCase();
  return allowed.includes(text) ? text : fallback;
}

function unique(arr) {
  return Array.from(new Set((arr || []).filter(Boolean)));
}

function normalizeEmail(value) {
  return normalizeText(value, 320).toLowerCase();
}

function normalizeRecipients(value, fallbackUser = null) {
  const raw = Array.isArray(value) ? value : [];
  const recipients = raw
    .map((entry) => {
      if (typeof entry === "string") return { email: normalizeEmail(entry), name: "" };
      return {
        email: normalizeEmail(entry?.email),
        name: normalizeText(entry?.name || entry?.nome, 160),
      };
    })
    .filter((entry) => entry.email && EMAIL_RE.test(entry.email));

  if (fallbackUser?.email) {
    recipients.unshift({
      email: normalizeEmail(fallbackUser.email),
      name: normalizeText(fallbackUser.name || fallbackUser.nome, 160),
    });
  }

  const byEmail = new Map();
  for (const recipient of recipients) {
    if (!byEmail.has(recipient.email)) byEmail.set(recipient.email, recipient);
  }

  return Array.from(byEmail.values()).slice(0, MAX_RECIPIENTS);
}

function normalizeMlbs(value) {
  const list = Array.isArray(value)
    ? value
    : String(value || "").split(/[\s,;]+/);

  return unique(
    list
      .map((item) => normalizeText(item, 32).toUpperCase())
      .filter((item) => /^MLB\d{6,}$/.test(item)),
  ).slice(0, MAX_MLBS);
}

function formatYmdInTz(date, timeZone = DEFAULT_TZ) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function partsInTz(date, timeZone = DEFAULT_TZ) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const out = {};
  for (const part of parts) {
    if (part.type !== "literal") out[part.type] = Number(part.value);
  }
  if (out.hour === 24) out.hour = 0;
  return out;
}

function localDateTimeToUtc({ y, m, d, hh, mm, timeZone = DEFAULT_TZ }) {
  const desiredLocalMs = Date.UTC(y, m - 1, d, hh, mm, 0);
  let utc = new Date(desiredLocalMs);
  for (let i = 0; i < 3; i++) {
    const p = partsInTz(utc, timeZone);
    const observedLocalMs = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second || 0);
    utc = new Date(utc.getTime() + (desiredLocalMs - observedLocalMs));
  }
  return utc;
}

function addDaysYmd(ymd, days) {
  const [y, m, d] = String(ymd).split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days, 12, 0, 0));
  return dt.toISOString().slice(0, 10);
}

function weekdayFromYmd(ymd) {
  const [y, m, d] = String(ymd).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12, 0, 0)).getUTCDay();
}

function parseTimeOfDay(value) {
  const match = normalizeText(value).match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (!match) return null;
  const hh = Number(match[1]);
  const mm = Number(match[2]);
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

function calculateNextRunAt({
  frequency,
  weekday = null,
  timeOfDay,
  timezone = DEFAULT_TZ,
  from = new Date(),
}) {
  const time = parseTimeOfDay(timeOfDay);
  if (!time) return null;
  const [hh, mm] = time.split(":").map(Number);
  let ymd = formatYmdInTz(from, timezone);

  for (let i = 0; i < 14; i++) {
    const day = weekdayFromYmd(ymd);
    const allowed =
      frequency === "daily" ||
      (frequency === "weekdays" && day >= 1 && day <= 5) ||
      (frequency === "weekly" && day === Number(weekday));

    if (allowed) {
      const [y, m, d] = ymd.split("-").map(Number);
      const candidate = localDateTimeToUtc({ y, m, d, hh, mm, timeZone: timezone });
      if (candidate.getTime() > from.getTime() + 30 * 1000) return candidate;
    }
    ymd = addDaysYmd(ymd, 1);
  }

  return null;
}

function resolvePeriodRange(periodType, now = new Date(), timeZone = DEFAULT_TZ) {
  const today = formatYmdInTz(now, timeZone);
  const [y, m] = today.split("-").map(Number);
  if (periodType === "last_7_days") return { date_from: addDaysYmd(today, -6), date_to: today };
  if (periodType === "last_30_days") return { date_from: addDaysYmd(today, -29), date_to: today };
  if (periodType === "current_month") return { date_from: `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-01`, date_to: today };
  if (periodType === "previous_month") {
    const firstCurrent = new Date(Date.UTC(y, m - 1, 1, 12, 0, 0));
    const lastPrev = new Date(firstCurrent);
    lastPrev.setUTCDate(0);
    const firstPrev = new Date(Date.UTC(lastPrev.getUTCFullYear(), lastPrev.getUTCMonth(), 1, 12, 0, 0));
    return {
      date_from: firstPrev.toISOString().slice(0, 10),
      date_to: lastPrev.toISOString().slice(0, 10),
    };
  }
  return { date_from: "", date_to: "" };
}

function normalizePayload(input = {}, context = {}) {
  const name = normalizeText(input.name, 120);
  if (name.length < 3) {
    const error = new Error("Informe um nome com pelo menos 3 caracteres.");
    error.status = 400;
    throw error;
  }

  const base_status = normalizeEnum(input.base_status, ["active", "paused", "all", "mlb_list"], "active");
  const enrichment = normalizeEnum(input.enrichment, ["none", "category", "visits", "ads", "promos", "variations"], "none");
  const period_type = normalizeEnum(
    input.period_type,
    ["none", "last_7_days", "last_30_days", "current_month", "previous_month"],
    COMMERCIAL_ENRICHMENTS.has(enrichment) ? "last_30_days" : "none",
  );
  if (COMMERCIAL_ENRICHMENTS.has(enrichment) && period_type === "none") {
    const error = new Error("Visitas e Ads exigem periodo comercial.");
    error.status = 400;
    throw error;
  }

  const frequency = normalizeEnum(input.frequency, ["daily", "weekdays", "weekly"], "daily");
  const weekday = frequency === "weekly" ? toInt(input.weekday, null) : null;
  if (frequency === "weekly" && (weekday === null || weekday < 0 || weekday > 6)) {
    const error = new Error("Selecione o dia da semana do envio semanal.");
    error.status = 400;
    throw error;
  }

  const time_of_day = parseTimeOfDay(input.time_of_day);
  if (!time_of_day) {
    const error = new Error("Informe um horario valido no formato HH:mm.");
    error.status = 400;
    throw error;
  }

  const mlb_ids = base_status === "mlb_list" ? normalizeMlbs(input.mlb_ids || input.mlbs) : [];
  if (base_status === "mlb_list" && !mlb_ids.length) {
    const error = new Error("Informe ao menos um MLB valido para lista especifica.");
    error.status = 400;
    throw error;
  }

  const recipients = normalizeRecipients(input.recipients || input.recipients_json, context.user);
  if (!recipients.length) {
    const error = new Error("Informe ao menos um destinatario valido.");
    error.status = 400;
    throw error;
  }

  const timezone = normalizeText(input.timezone, 80) || DEFAULT_TZ;
  const next_run_at = calculateNextRunAt({
    frequency,
    weekday,
    timeOfDay: time_of_day,
    timezone,
  });

  return {
    name,
    report_type: "listing",
    base_status,
    mlb_ids,
    enrichment,
    period_type,
    recipients,
    frequency,
    weekday,
    time_of_day,
    timezone,
    next_run_at,
    active: input.active !== false,
  };
}

function mapRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    empresa_id: Number(row.empresa_id),
    meli_conta_id: Number(row.meli_conta_id),
    created_by_user_id: row.created_by_user_id == null ? null : Number(row.created_by_user_id),
    name: row.name,
    report_type: row.report_type,
    base_status: row.base_status,
    mlb_ids: Array.isArray(row.mlb_ids) ? row.mlb_ids : [],
    enrichment: row.enrichment,
    period_type: row.period_type,
    recipients: Array.isArray(row.recipients_json) ? row.recipients_json : [],
    frequency: row.frequency,
    weekday: row.weekday == null ? null : Number(row.weekday),
    time_of_day: String(row.time_of_day || "").slice(0, 5),
    timezone: row.timezone,
    next_run_at: row.next_run_at,
    active: row.active === true,
    last_run_at: row.last_run_at,
    last_status: row.last_status,
    last_error: row.last_error,
    created_at: row.created_at,
    updated_at: row.updated_at,
    account_label: row.account_label || null,
  };
}

function mapRun(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    automation_id: Number(row.automation_id),
    empresa_id: Number(row.empresa_id),
    meli_conta_id: Number(row.meli_conta_id),
    status: row.status,
    scheduled_for: row.scheduled_for,
    started_at: row.started_at,
    finished_at: row.finished_at,
    query_job_id: row.query_job_id,
    csv_job_id: row.csv_job_id,
    csv_url: row.csv_url,
    rows_count: row.rows_count == null ? null : Number(row.rows_count),
    recipients: Array.isArray(row.recipients_json) ? row.recipients_json : [],
    email_result: row.email_result_json || {},
    error_message: row.error_message,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function validateDailyLimit(client, { empresaId, meliContaId, frequency, weekday, excludeId = null }) {
  const params = [empresaId, meliContaId];
  let where = `
    empresa_id = $1
    and meli_conta_id = $2
    and active = true
  `;
  if (excludeId) {
    params.push(excludeId);
    where += ` and id <> $${params.length}`;
  }

  const { rows } = await client.query(
    `select frequency, weekday
       from report_automations
      where ${where}`,
    params,
  );

  const counts = Array.from({ length: 7 }, () => 0);
  for (const row of rows || []) {
    if (row.frequency === "daily") {
      for (let i = 0; i < 7; i++) counts[i] += 1;
    } else if (row.frequency === "weekdays") {
      for (let i = 1; i <= 5; i++) counts[i] += 1;
    } else if (row.frequency === "weekly" && row.weekday != null) {
      counts[Number(row.weekday)] += 1;
    }
  }

  if (frequency === "daily") {
    for (let i = 0; i < 7; i++) counts[i] += 1;
  } else if (frequency === "weekdays") {
    for (let i = 1; i <= 5; i++) counts[i] += 1;
  } else if (frequency === "weekly") {
    counts[Number(weekday)] += 1;
  }

  if (counts.some((count) => count > MAX_DAILY_REPORTS)) {
    const error = new Error("Limite de 2 relatorios por dia para esta empresa e conta ML.");
    error.status = 409;
    throw error;
  }
}

async function listAutomations({ empresaId, meliContaId }) {
  const { rows } = await db.query(
    `select ra.*, coalesce(mc.apelido, mc.meli_user_id::text, ra.meli_conta_id::text) as account_label
       from report_automations ra
       join meli_contas mc on mc.id = ra.meli_conta_id
      where ra.empresa_id = $1
        and ra.meli_conta_id = $2
      order by ra.active desc, ra.next_run_at nulls last, ra.id desc`,
    [empresaId, meliContaId],
  );
  return rows.map(mapRow);
}

async function getAutomation({ id, empresaId, meliContaId = null, client = db }) {
  const params = [id, empresaId];
  let where = "ra.id = $1 and ra.empresa_id = $2";
  if (meliContaId) {
    params.push(meliContaId);
    where += ` and ra.meli_conta_id = $${params.length}`;
  }
  const { rows } = await client.query(
    `select ra.*, coalesce(mc.apelido, mc.meli_user_id::text, ra.meli_conta_id::text) as account_label
       from report_automations ra
       join meli_contas mc on mc.id = ra.meli_conta_id
      where ${where}
      limit 1`,
    params,
  );
  return mapRow(rows[0]);
}

async function createAutomation({ empresaId, meliContaId, userId, user, payload }) {
  return db.withClient(async (client) => {
    const normalized = normalizePayload(payload, { user });
    if (normalized.active) {
      await validateDailyLimit(client, {
        empresaId,
        meliContaId,
        frequency: normalized.frequency,
        weekday: normalized.weekday,
      });
    }

    const { rows } = await client.query(
      `insert into report_automations (
         empresa_id, meli_conta_id, created_by_user_id, name, report_type,
         base_status, mlb_ids, enrichment, period_type, recipients_json,
         frequency, weekday, time_of_day, timezone, next_run_at, active
       ) values (
         $1, $2, $3, $4, $5,
         $6, $7::text[], $8, $9, $10::jsonb,
         $11, $12, $13::time, $14, $15, $16
       )
       returning *`,
      [
        empresaId,
        meliContaId,
        userId || null,
        normalized.name,
        normalized.report_type,
        normalized.base_status,
        normalized.mlb_ids.length ? normalized.mlb_ids : null,
        normalized.enrichment,
        normalized.period_type,
        JSON.stringify(normalized.recipients),
        normalized.frequency,
        normalized.weekday,
        normalized.time_of_day,
        normalized.timezone,
        normalized.next_run_at,
        normalized.active,
      ],
    );
    return mapRow(rows[0]);
  });
}

async function updateAutomation({ id, empresaId, meliContaId, user, payload }) {
  return db.withClient(async (client) => {
    const current = await getAutomation({ id, empresaId, meliContaId, client });
    if (!current) return null;

    const normalized = normalizePayload({ ...current, ...payload }, { user });
    if (normalized.active) {
      await validateDailyLimit(client, {
        empresaId,
        meliContaId,
        frequency: normalized.frequency,
        weekday: normalized.weekday,
        excludeId: id,
      });
    }

    const { rows } = await client.query(
      `update report_automations
          set name = $4,
              base_status = $5,
              mlb_ids = $6::text[],
              enrichment = $7,
              period_type = $8,
              recipients_json = $9::jsonb,
              frequency = $10,
              weekday = $11,
              time_of_day = $12::time,
              timezone = $13,
              next_run_at = case when active then $14 else null end,
              active = $15,
              updated_at = now()
        where id = $1 and empresa_id = $2 and meli_conta_id = $3
        returning *`,
      [
        id,
        empresaId,
        meliContaId,
        normalized.name,
        normalized.base_status,
        normalized.mlb_ids.length ? normalized.mlb_ids : null,
        normalized.enrichment,
        normalized.period_type,
        JSON.stringify(normalized.recipients),
        normalized.frequency,
        normalized.weekday,
        normalized.time_of_day,
        normalized.timezone,
        normalized.next_run_at,
        normalized.active,
      ],
    );
    return mapRow(rows[0]);
  });
}

async function setAutomationActive({ id, empresaId, meliContaId, active }) {
  return db.withClient(async (client) => {
    const current = await getAutomation({ id, empresaId, meliContaId, client });
    if (!current) return null;
    if (active) {
      await validateDailyLimit(client, {
        empresaId,
        meliContaId,
        frequency: current.frequency,
        weekday: current.weekday,
        excludeId: id,
      });
    }
    const nextRunAt = active
      ? calculateNextRunAt({
          frequency: current.frequency,
          weekday: current.weekday,
          timeOfDay: current.time_of_day,
          timezone: current.timezone,
        })
      : null;
    const { rows } = await client.query(
      `update report_automations
          set active = $4,
              next_run_at = $5,
              updated_at = now()
        where id = $1 and empresa_id = $2 and meli_conta_id = $3
        returning *`,
      [id, empresaId, meliContaId, !!active, nextRunAt],
    );
    return mapRow(rows[0]);
  });
}

async function deleteAutomation({ id, empresaId, meliContaId }) {
  const { rowCount } = await db.query(
    `delete from report_automations
      where id = $1 and empresa_id = $2 and meli_conta_id = $3`,
    [id, empresaId, meliContaId],
  );
  return rowCount > 0;
}

async function listRuns({ automationId, empresaId, meliContaId, limit = 20 }) {
  const { rows } = await db.query(
    `select *
       from report_automation_runs
      where automation_id = $1
        and empresa_id = $2
        and meli_conta_id = $3
      order by created_at desc
      limit $4`,
    [automationId, empresaId, meliContaId, Math.max(1, Math.min(100, Number(limit) || 20))],
  );
  return rows.map(mapRun);
}

function buildFiltroFilters(automation, now = new Date()) {
  const period = resolvePeriodRange(automation.period_type, now, automation.timezone || DEFAULT_TZ);
  const filters = {
    status: automation.base_status === "all" || automation.base_status === "mlb_list"
      ? "all"
      : automation.base_status,
    lookup_type: automation.base_status === "mlb_list" ? "mlb" : "sku",
    sku_query: automation.base_status === "mlb_list" ? (automation.mlb_ids || []).join(",") : "",
    include_category: automation.enrichment === "category",
    include_visits: automation.enrichment === "visits",
    include_ads: automation.enrichment === "ads",
    include_promos: automation.enrichment === "promos",
    detail_variations: automation.enrichment === "variations" || automation.base_status === "mlb_list",
    date_from: period.date_from,
    date_to: period.date_to,
    has_period: !!(period.date_from && period.date_to),
    allow_long_period: false,
    sales_op: "all",
    sales_value: 0,
    sales_no_sales_after: false,
    envio: "all",
    tipo: "all",
    detalhes: "all",
    stock_op: "all",
    stock_value: null,
    sort_by: "sold_value",
    sort_dir: "desc",
    q: "",
  };

  if (!filters.has_period) {
    filters.include_visits = false;
    filters.include_ads = false;
  }

  return filters;
}

async function createRunForAutomation({ automation, scheduledFor = new Date(), client = db }) {
  const { rows } = await client.query(
    `insert into report_automation_runs (
       automation_id, empresa_id, meli_conta_id, status, scheduled_for, recipients_json
     ) values ($1, $2, $3, 'queued', $4, $5::jsonb)
     returning *`,
    [
      automation.id,
      automation.empresa_id,
      automation.meli_conta_id,
      scheduledFor,
      JSON.stringify(automation.recipients || []),
    ],
  );
  return mapRun(rows[0]);
}

module.exports = {
  MAX_DAILY_REPORTS,
  buildFiltroFilters,
  calculateNextRunAt,
  createAutomation,
  createRunForAutomation,
  deleteAutomation,
  getAutomation,
  listAutomations,
  listRuns,
  mapRun,
  normalizeRecipients,
  resolvePeriodRange,
  setAutomationActive,
  updateAutomation,
};
