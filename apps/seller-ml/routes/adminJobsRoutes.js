"use strict";

const express = require("express");
const db = require("../db/db");
const { createAuditAction } = require("../middleware/auditAction");

const router = express.Router();

const JOB_CATALOG = Object.freeze({});

const ALLOWED_PERIODS = new Set(["7d", "14d", "30d"]);
const DEFAULT_JOB_SETTINGS = Object.freeze({
  enabled: false,
  periods: [],
  account_ids: [],
  exclude_account_ids: [],
  include_inactive: false,
  concurrency: 1,
  limit: 0,
  fail_on_partial: false,
  cron_expression: null,
  params: {},
  updated_by: null,
  updated_at: null,
});

function ensureMasterOnly(req, res, next) {
  const u = req.user || res.locals.user;
  const nivel = String(u?.nivel || "").trim().toLowerCase();
  if (nivel === "admin_master") return next();
  return res.status(403).json({ ok: false, error: "Acesso nao autorizado." });
}

router.use(ensureMasterOnly);

function boolLike(value, fallback = false) {
  if (value === true || value === false) return value;
  if (value == null) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "sim", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "nao", "off"].includes(normalized)) return false;
  return fallback;
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function parsePeriods(value) {
  const list = Array.isArray(value)
    ? value
    : String(value || "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);

  const normalized = Array.from(
    new Set(
      list
        .map((period) => String(period || "").trim().toLowerCase())
        .filter((period) => ALLOWED_PERIODS.has(period)),
    ),
  );

  return normalized.length ? normalized : DEFAULT_JOB_SETTINGS.periods.slice();
}

function parseAccountIds(value) {
  if (value == null) return [];

  const list = Array.isArray(value)
    ? value
    : String(value || "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);

  const ids = Array.from(
    new Set(
      list
        .map((item) => Number(item))
        .filter((item) => Number.isFinite(item) && item > 0)
        .map((item) => Math.trunc(item)),
    ),
  );

  ids.sort((a, b) => a - b);
  return ids;
}

function resolveUpdatedBy(req) {
  const u = req.user || {};
  return (
    u.email ||
    u.login ||
    u.nome ||
    (u.id != null ? String(u.id) : null) ||
    (u.uid != null ? String(u.uid) : null) ||
    "admin_master"
  );
}

function getJobMeta(jobKey) {
  const meta = JOB_CATALOG[jobKey];
  return meta || null;
}

function normalizeSettingsRow(jobKey, row) {
  const meta = getJobMeta(jobKey);
  const fallback = meta ? meta.default_settings : DEFAULT_JOB_SETTINGS;

  if (!row) {
    return {
      ...fallback,
      params: fallback.params || {},
    };
  }

  return {
    enabled: row.enabled !== false,
    periods: parsePeriods(row.periods),
    account_ids: parseAccountIds(row.account_ids),
    exclude_account_ids: parseAccountIds(row.exclude_account_ids),
    include_inactive: row.include_inactive === true,
    concurrency: clampInt(row.concurrency, 1, 6, fallback.concurrency),
    limit: clampInt(row.limit_accounts, 0, 5000, fallback.limit),
    fail_on_partial: row.fail_on_partial === true,
    cron_expression: row.cron_expression || null,
    params:
      row.params_json && typeof row.params_json === "object"
        ? row.params_json
        : {},
    updated_by: row.updated_by || null,
    updated_at: row.updated_at || null,
  };
}

async function listAccounts() {
  const { rows } = await db.query(
    `
      select
        mc.id,
        mc.empresa_id,
        e.nome as empresa_nome,
        mc.meli_user_id,
        mc.apelido,
        mc.status,
        mc.site_id,
        (mt.refresh_token is not null) as has_refresh_token
      from meli_contas mc
      join empresas e on e.id = mc.empresa_id
      left join meli_tokens mt on mt.meli_conta_id = mc.id
      order by e.nome asc, mc.id asc
    `,
  );
  return Array.isArray(rows) ? rows : [];
}

async function loadAllJobSettings() {
  const keys = Object.keys(JOB_CATALOG);
  if (!keys.length) return {};

  try {
    const { rows } = await db.query(
      `
        select
          job_key,
          enabled,
          cron_expression,
          periods,
          account_ids,
          exclude_account_ids,
          include_inactive,
          concurrency,
          limit_accounts,
          fail_on_partial,
          params_json,
          updated_by,
          updated_at
        from automation_job_settings
        where job_key = any($1::text[])
      `,
      [keys],
    );

    const byKey = new Map();
    for (const row of rows || []) {
      byKey.set(String(row.job_key || ""), row);
    }

    const out = {};
    for (const key of keys) {
      out[key] = normalizeSettingsRow(key, byKey.get(key) || null);
    }
    return out;
  } catch (error) {
    if (String(error?.code || "") === "42P01") {
      const defaults = {};
      for (const key of keys) defaults[key] = normalizeSettingsRow(key, null);
      return defaults;
    }
    throw error;
  }
}

function normalizeInputForJob(jobKey, body = {}) {
  const meta = getJobMeta(jobKey);
  const defaults = meta
    ? meta.default_settings
    : DEFAULT_JOB_SETTINGS;

  return {
    enabled: boolLike(body.enabled, defaults.enabled),
    periods: parsePeriods(body.periods),
    account_ids: parseAccountIds(body.account_ids),
    exclude_account_ids: parseAccountIds(body.exclude_account_ids),
    include_inactive: boolLike(body.include_inactive, defaults.include_inactive),
    concurrency: clampInt(body.concurrency, 1, 6, defaults.concurrency),
    limit: clampInt(body.limit, 0, 5000, defaults.limit),
    fail_on_partial: boolLike(body.fail_on_partial, defaults.fail_on_partial),
    cron_expression:
      body.cron_expression == null
        ? null
        : String(body.cron_expression || "").trim() || null,
    params:
      body.params && typeof body.params === "object" && !Array.isArray(body.params)
        ? body.params
        : {},
  };
}

router.get("/jobs", async (_req, res) => {
  try {
    const [settingsByKey, accounts] = await Promise.all([
      loadAllJobSettings(),
      listAccounts(),
    ]);

    const jobs = Object.keys(JOB_CATALOG).map((jobKey) => ({
      job_key: jobKey,
      display_name: JOB_CATALOG[jobKey].display_name,
      description: JOB_CATALOG[jobKey].description,
      settings: settingsByKey[jobKey] || normalizeSettingsRow(jobKey, null),
    }));

    return res.json({
      ok: true,
      jobs,
      accounts,
    });
  } catch (error) {
    console.error("GET /api/admin/jobs erro:", error);
    return res.status(500).json({
      ok: false,
      error: "Erro ao carregar configuracao de jobs.",
    });
  }
});

router.put(
  "/jobs/:jobKey",
  createAuditAction({
    evento: "admin_job_settings_updated",
    metadata: (req) => {
      const jobKey = String(req.params?.jobKey || "").trim().toLowerCase();
      return {
        job_key: jobKey,
        ...normalizeInputForJob(jobKey, req.body || {}),
      };
    },
  }),
  express.json({ limit: "200kb" }),
  async (req, res) => {
    const jobKey = String(req.params?.jobKey || "").trim().toLowerCase();
    if (!getJobMeta(jobKey)) {
      return res.status(404).json({
        ok: false,
        error: "Job nao encontrado.",
      });
    }

    try {
      const normalized = normalizeInputForJob(jobKey, req.body || {});
      const updatedBy = resolveUpdatedBy(req);

      const { rows } = await db.query(
        `
          insert into automation_job_settings (
            job_key,
            enabled,
            cron_expression,
            periods,
            account_ids,
            exclude_account_ids,
            include_inactive,
            concurrency,
            limit_accounts,
            fail_on_partial,
            params_json,
            updated_by,
            updated_at
          )
          values (
            $1,
            $2,
            $3,
            $4::text[],
            $5::bigint[],
            $6::bigint[],
            $7,
            $8,
            $9,
            $10,
            $11::jsonb,
            $12,
            now()
          )
          on conflict (job_key) do update set
            enabled = excluded.enabled,
            cron_expression = excluded.cron_expression,
            periods = excluded.periods,
            account_ids = excluded.account_ids,
            exclude_account_ids = excluded.exclude_account_ids,
            include_inactive = excluded.include_inactive,
            concurrency = excluded.concurrency,
            limit_accounts = excluded.limit_accounts,
            fail_on_partial = excluded.fail_on_partial,
            params_json = excluded.params_json,
            updated_by = excluded.updated_by,
            updated_at = now()
          returning
            job_key,
            enabled,
            cron_expression,
            periods,
            account_ids,
            exclude_account_ids,
            include_inactive,
            concurrency,
            limit_accounts,
            fail_on_partial,
            params_json,
            updated_by,
            updated_at
        `,
        [
          jobKey,
          normalized.enabled,
          normalized.cron_expression,
          normalized.periods,
          normalized.account_ids.length ? normalized.account_ids : null,
          normalized.exclude_account_ids.length
            ? normalized.exclude_account_ids
            : null,
          normalized.include_inactive,
          normalized.concurrency,
          normalized.limit,
          normalized.fail_on_partial,
          JSON.stringify(normalized.params || {}),
          updatedBy,
        ],
      );

      return res.json({
        ok: true,
        job: {
          job_key: jobKey,
          display_name: JOB_CATALOG[jobKey].display_name,
          description: JOB_CATALOG[jobKey].description,
          settings: normalizeSettingsRow(jobKey, rows?.[0] || null),
        },
      });
    } catch (error) {
      if (String(error?.code || "") === "42P01") {
        return res.status(503).json({
          ok: false,
          error:
            "Tabela de jobs nao encontrada. Rode as migracoes pendentes no painel Admin > Migracoes.",
          code: "JOB_SETTINGS_TABLE_MISSING",
        });
      }

      console.error(`PUT /api/admin/jobs/${jobKey} erro:`, error);
      return res.status(500).json({
        ok: false,
        error: "Erro ao salvar configuracao do job.",
      });
    }
  },
);

module.exports = router;

